/**
 * 단지 사용승인일(apt_complex_profile.approval_date) 빈 칸 채우기 — 건축물대장(건축HUB)만, 필지는 complex_building_checkpoint.pnu.
 *
 * 규칙 (추정 없음):
 *   ① 총괄표제부(getBrRecapTitleInfo)가 한 행이고 사용승인일(useAprDay)이 8자리면 그 날짜.
 *   ② 아니면 표제부(getBrTitleInfo)에서 주건축물·공동주택 행들의 사용승인일이 모두 같을 때만 그 날짜.
 *      날짜가 여럿(분할 준공 등)이거나 없으면 보류.
 * 빈 칸만: 기존 행은 approval_date가 NULL/빈 문자열일 때만 UPDATE, 행이 없으면 INSERT OR IGNORE.
 * 표제부 조회가 이미 비었던 필지(checkpoint title_status = EMPTY)는 뺀다.
 * 공급면적 채움에서 승인일이 없어 빠진 단지(C:/data/fixes/supply-common-rule-2026-09-25/work/units-*.jsonl)를 먼저 조회한다.
 *
 *   npx tsx scripts/fixes/fill-approval-date.mts fetch [--limit N]   # API 조회만, 캐시에 이어 쓰기 (DB 쓰기 없음)
 *   npx tsx scripts/fixes/fill-approval-date.mts plan                # 캐시로 계획
 *   npx tsx scripts/fixes/fill-approval-date.mts apply               # 계획대로 쓰기 (빈 칸 조건 걸고)
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";

const OUT = "C:/data/fixes/approval-date-2026-09-25";
const CACHE = join(OUT, "hub-cache.jsonl");
const PLAN = join(OUT, "plan.json");
const SUPPLY_WORK = "C:/data/fixes/supply-common-rule-2026-09-25/work";
const VERSION = "approval_fill_2026_09";
const HUB = "https://apis.data.go.kr/1613000/BldRgstHubService";

type Target = { complexId: string; pnu: string; hasRow: boolean };
type Cached = { complexId: string; pnu: string; recap: string[] | null; title: string[] | null; error?: string };

class QuotaError extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hub(op: string, pnu: string): Promise<Array<Record<string, unknown>> | null> {
  const qs = new URLSearchParams({
    serviceKey: process.env.MOLIT_API_KEY!.trim(),
    sigunguCd: pnu.slice(0, 5),
    bjdongCd: pnu.slice(5, 10),
    platGbCd: pnu[10]!,
    bun: pnu.slice(11, 15),
    ji: pnu.slice(15, 19),
    numOfRows: "200",
    pageNo: "1",
    _type: "json",
  });
  for (let a = 0; a < 5; a++) {
    await sleep(250 + a * 1000);
    let text = "";
    try {
      const res = await fetch(`${HUB}/${op}?${qs}`, { signal: AbortSignal.timeout(20000) });
      text = await res.text();
    } catch {
      continue;
    }
    if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS|SERVICE_REQUESTS_EXCEEDS/.test(text)) throw new QuotaError(text.slice(0, 120));
    try {
      const j = JSON.parse(text);
      const it = j.response?.body?.items?.item;
      return Array.isArray(it) ? it : it ? [it] : [];
    } catch {
      /* 빈 본문·XML 오류 — 다시 */
    }
  }
  return null;
}

const date8 = (v: unknown) => {
  const s = String(v ?? "").trim();
  return /^\d{8}$/.test(s) && s !== "00000000" ? s : "";
};

async function targets(): Promise<Target[]> {
  const db = getDb()!;
  const res = await db.execute(`
    SELECT m.complex_id, c.pnu, p.complex_id IS NOT NULL AS has_row
    FROM apt_complex_master m
    JOIN complex_building_checkpoint c USING (complex_id)
    LEFT JOIN apt_complex_profile p USING (complex_id)
    WHERE length(c.pnu) = 19 AND c.title_status <> 'EMPTY' AND (p.approval_date IS NULL OR p.approval_date = '')`);
  const priority = new Set<string>();
  if (existsSync(SUPPLY_WORK)) {
    for (const f of readdirSync(SUPPLY_WORK).filter((x) => /^units-.*\.jsonl$/.test(x))) {
      for (const l of readFileSync(join(SUPPLY_WORK, f), "utf8").split("\n")) {
        const m = l.match(/"complexId":"(cx_[0-9a-f]{16})"/);
        if (m) priority.add(m[1]!);
      }
    }
  }
  return res.rows
    .map((r) => ({ complexId: String(r.complex_id), pnu: String(r.pnu), hasRow: Number(r.has_row) === 1 }))
    .sort((a, b) => Number(priority.has(b.complexId)) - Number(priority.has(a.complexId)));
}

function readCache(): Map<string, Cached> {
  const out = new Map<string, Cached>();
  if (!existsSync(CACHE)) return out;
  for (const l of readFileSync(CACHE, "utf8").split("\n")) {
    if (!l) continue;
    const c = JSON.parse(l) as Cached;
    if (!c.error) out.set(c.complexId, c);
  }
  return out;
}

async function fetchAll(limit: number) {
  mkdirSync(OUT, { recursive: true });
  const cache = readCache();
  const todo = (await targets()).filter((t) => !cache.has(t.complexId)).slice(0, limit);
  console.log(JSON.stringify({ todo: todo.length, cached: cache.size }));
  let done = 0;
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const t = todo[i++]!;
      const recapRows = await hub("getBrRecapTitleInfo", t.pnu);
      const recap = recapRows ? recapRows.map((r) => date8(r.useAprDay)) : null;
      let title: string[] | null = [];
      if (!(recap && recap.length === 1 && recap[0])) {
        const rows = await hub("getBrTitleInfo", t.pnu);
        title = rows
          ? rows
              .filter((r) => String(r.mainAtchGbCdNm ?? "").includes("주건축물") && String(r.mainPurpsCdNm ?? "").includes("공동주택"))
              .map((r) => date8(r.useAprDay))
          : null;
      }
      const rec: Cached = { complexId: t.complexId, pnu: t.pnu, recap, title };
      if (recap == null || title == null) rec.error = "no_response";
      appendFileSync(CACHE, JSON.stringify(rec) + "\n");
      if (++done % 200 === 0) console.log(JSON.stringify({ done, of: todo.length }));
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
  } catch (e) {
    if (e instanceof QuotaError) console.log(JSON.stringify({ quotaStop: true, done }));
    else throw e;
  }
  console.log(JSON.stringify({ fetched: done }));
}

function decide(c: Cached): { date: string; basis: string } | { hold: string } {
  if (c.recap && c.recap.length === 1 && c.recap[0]) return { date: c.recap[0], basis: "BUILDING_HUB_RECAP" };
  const dates = [...new Set((c.title ?? []).filter(Boolean))];
  if (dates.length === 1) return { date: dates[0]!, basis: "BUILDING_HUB_TITLE_ALL_SAME" };
  if (dates.length > 1) return { hold: "MULTI_DATES" };
  return { hold: (c.title ?? []).length ? "TITLE_NO_DATE" : "NO_APT_TITLE" };
}

async function plan() {
  const cache = readCache();
  const ts = await targets();
  const fills: Array<{ complexId: string; pnu: string; hasRow: boolean; date: string; basis: string }> = [];
  const held: Record<string, number> = {};
  let notFetched = 0;
  for (const t of ts) {
    const c = cache.get(t.complexId);
    if (!c || c.pnu !== t.pnu) {
      notFetched++;
      continue;
    }
    const d = decide(c);
    if ("hold" in d) held[d.hold] = (held[d.hold] ?? 0) + 1;
    else fills.push({ ...t, date: `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}`, basis: d.basis });
  }
  const byDecade: Record<string, number> = {};
  for (const f of fills) byDecade[`${f.date.slice(0, 3)}0s`] = (byDecade[`${f.date.slice(0, 3)}0s`] ?? 0) + 1;
  writeFileSync(PLAN, JSON.stringify({ built_at: new Date().toISOString(), fills }, null, 0));
  console.log(
    JSON.stringify(
      {
        targets: ts.length,
        notFetched,
        fill: fills.length,
        update: fills.filter((f) => f.hasRow).length,
        insert: fills.filter((f) => !f.hasRow).length,
        byBasis: fills.reduce<Record<string, number>>((a, f) => ((a[f.basis] = (a[f.basis] ?? 0) + 1), a), {}),
        byDecade,
        held,
        odd: fills.filter((f) => f.date < "1960" || f.date > new Date().toISOString().slice(0, 10)).slice(0, 5),
      },
      null,
      1,
    ),
  );
}

async function apply() {
  const db = getDb()!;
  const { fills } = JSON.parse(readFileSync(PLAN, "utf8")) as {
    fills: Array<{ complexId: string; pnu: string; hasRow: boolean; date: string; basis: string }>;
  };
  const now = new Date().toISOString();
  const prov = (f: (typeof fills)[number]) =>
    JSON.stringify({ source: f.basis, source_key: f.pnu, derived: false, derived_tag: null, raw: f.date.replace(/-/g, ""), fill: VERSION });
  let updated = 0;
  let inserted = 0;
  for (let i = 0; i < fills.length; i += 100) {
    const part = fills.slice(i, i + 100);
    const res = await db.batch(
      part.map((f) =>
        f.hasRow
          ? {
              sql: `UPDATE apt_complex_profile
                    SET approval_date = ?, updated_at = ?,
                        raw_meta_json = json_set(COALESCE(raw_meta_json, '{}'), '$.field_provenance.approval_date', json(?))
                    WHERE complex_id = ? AND (approval_date IS NULL OR approval_date = '')`,
              args: [f.date, now, prov(f), f.complexId],
            }
          : {
              sql: `INSERT OR IGNORE INTO apt_complex_profile (complex_id, approval_date, source, source_version, raw_meta_json, updated_at)
                    VALUES (?, ?, 'PROFILE_FILL', ?, json_object('field_provenance', json_object('approval_date', json(?)), 'profile_fill', ?), ?)`,
              args: [f.complexId, f.date, VERSION, prov(f), VERSION, now],
            },
      ),
      "write",
    );
    res.forEach((r, j) => (part[j]!.hasRow ? (updated += r.rowsAffected) : (inserted += r.rowsAffected)));
  }
  console.log(JSON.stringify({ planned: fills.length, updated, inserted }));
}

const [mode] = process.argv.slice(2);
const li = process.argv.indexOf("--limit");
if (mode === "fetch") await fetchAll(li > 0 ? Number(process.argv[li + 1]) : Infinity);
else if (mode === "plan") await plan();
else if (mode === "apply") await apply();
else console.error("usage: fill-approval-date.mts fetch [--limit N] | plan | apply");
