/**
 * 청약홈 모집공고 주택형(applyhome_models)으로 새 단지의 빈 공급면적과 타입명(A/B/C)을 채운다.
 * 호갱노노의 "109A / 84㎡"처럼: 공급면적 → 평, 주택형 끝 글자 → 타입명.
 *
 * 공고 ↔ 단지 연결 (정확 일치만, 유사도 점수 없음). 아래 1~4를 모두 만족해야 한다.
 *   1. 시군구 코드: notice.lawd_cd = master.lawd_cd.
 *      다르면 lawd-successor.csv(법정동 변경 이력)에서 (공고 코드 앞 5자리, 단지 법정동 이름)의
 *      새 코드가 하나뿐이고(1:1) 그 앞 5자리가 master.lawd_cd일 때만 같은 것으로 본다.
 *   2. 이름: 공백 제거 + 괄호( ) 안 내용 제거 후 같아야 한다. 추가로 허용하는 것은 두 가지뿐.
 *      a) 공고 이름 앞의 지역명 하나 떼기 — 지역명 = 공고 주소의 시군구 토큰(…시/군/구) 또는
 *         읍면동 토큰(…읍/면/동/가) 그대로, 또는 그 토큰에서 끝 글자(시/군/구/읍/면/동/가)를 뗀 것
 *         (남은 길이 2자 이상). 예: 주소 "서울특별시 강서구 화곡동 …" → "강서구","강서","화곡동","화곡".
 *         떼고 남은 이름이 단지 이름과 정확히 같을 때만.
 *      b) 끝의 "아파트" 떼기 (양쪽 모두).
 *   3. 법정동: master.legal_dong_name 이 공고 주소 문자열 안에 그대로 있어야 한다.
 *   4. 전용면적 집합: 단지 유형의 전용(0.01㎡)이 모두 공고 주택형 전용(0.01㎡)에 있고,
 *      공고에만 있는 전용도 없어야 한다(집합이 같음). 단지에 유형 행이 하나도 없으면 건너뜀(새로 만들지 않음).
 *      --allow-subset: 진단용. 공고에만 있는 전용을 허용(단지 ⊆ 공고). 기본값은 끔.
 *   5. 단지마다 1~4를 통과한 공고가 하나이거나, 여럿이면 모든 (전용 → 공급) 값이 서로 같아야 한다.
 *      무순위(notice_type='remndr')는 일반 공고가 하나도 통과하지 못했을 때만 쓴다.
 *      공고 하나가 단지 둘 이상에 붙으면 모두 보류.
 *
 * 채우기 (빈 값만):
 *   - supply_area 가 NULL인 행(NO_SOURCE, supply_cents=-1): 같은 전용의 공고 주택형이 모두 같은 공급(0.01)이면
 *     supply_area/cents/pyeong/label, type_name(글자를 A/C처럼), status=EXACT_SINGLE, source='applyhome'로 채운다.
 *     (fill-g2-local.mts의 NO_SOURCE 행 제자리 채우기 규칙과 같음. unit_type_id는 그대로 둔다.)
 *     household_count 는 채우지 않는다 — 공고 공급 세대수는 조합원분이 빠진 분양분이라 단지 세대수가 아니다.
 *     apt_unit_exclusive_pairs 의 NO_SOURCE 도 EXACT_SINGLE 로 바꾼다 (g2와 같음).
 *   - 같은 전용에 공급이 둘 이상(예: 74.99B 102.07 / 74.99C 99.36)이면 보류. 행을 나누려면 기존 행의
 *     household_count 합이 맞아야 하는데 NO_SOURCE 행은 세대수가 비어 있어 나눌 수 없다.
 *   - 이미 공급이 있는 행: type_name 이 NULL이고 공고 공급이 그 행 공급과 0.01까지 같을 때 type_name만 채운다.
 *   - 값이 있는 supply_area·type_name 은 덮어쓰지 않는다. 행을 지우지 않는다.
 *
 *   npx tsx --env-file=.env.local scripts/supply-fill/fill-from-applyhome.mts plan [--allow-subset]
 *   npx tsx --env-file=.env.local scripts/supply-fill/fill-from-applyhome.mts apply
 *
 * plan: DB 쓰기 없음. 계획·연결표·백업(바뀔 행의 지금 값)을 OUT 폴더에 쓴다.
 * apply: plan.json 그대로 실행. 행마다 "아직 비어 있음" 조건을 WHERE에 걸어 다시 확인한다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client, type InArgs } from "@libsql/client";
import { areaFromCents, canonicalSupplyPyeong, NO_SUPPLY_CENTS } from "../../src/lib/unit-type/canonical";
import { supplyPyeongDisplayLabel } from "../../src/lib/unit-type/supply-label";

const OUT = process.env.APPLYHOME_FILL_OUT ?? "C:/data/fixes/applyhome-supply-2026-09-25";
const SUCCESSOR_CSV =
  process.env.LAWD_SUCCESSOR_CSV ??
  "C:/dev/ziplab/.claude/worktrees/agent-ab9f8df0cdcaf0df8/data/admin-codes/lawd-successor.csv";
const RECOVERY = "applyhome_supply_2026_09_25";
const WATCH = ["cx_df8658f7baf2e491", "cx_63f4501891e27116", "cx_d7422c3fc9c0daea"];

type Notice = { id: string; name: string; address: string; lawd: string; date: string; remndr: boolean; secd: string };
type Model = { exCents: number; supplyCents: number | null; letter: string; houseTy: string };
type Master = { id: string; name: string; lawd: string; dong: string };
type UnitRow = {
  unitTypeId: string;
  exCents: number;
  supplyCents: number;
  supplyArea: number | null;
  typeName: string | null;
  status: string;
};
type Stmt = { sql: string; args: InArgs };

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}
function num(v: unknown): number {
  const n = Number(typeof v === "bigint" ? Number(v) : v);
  return Number.isFinite(n) ? n : 0;
}
function db(): Client {
  return createClient({ url: process.env.TURSO_DATABASE_URL!.trim(), authToken: process.env.TURSO_AUTH_TOKEN!.trim() });
}
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
function bump(m: Record<string, number>, k: string, by = 1) {
  m[k] = (m[k] ?? 0) + by;
}

/** "084.9700A" → 8497 (정수 계산, 0.005는 올림). */
export function houseTyExclusiveCents(houseTy: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,4})/.exec(houseTy.trim());
  if (!m) return null;
  const tenThousandths = Number(m[1]) * 10000 + Number(m[2]!.padEnd(4, "0"));
  return Math.floor((tenThousandths + 50) / 100);
}
export function houseTyLetter(houseTy: string): string {
  const m = /^\d{1,3}\.\d{1,4}([A-Za-z]*)\s*$/.exec(houseTy.trim());
  return m ? m[1]!.toUpperCase() : "";
}
function areaCents(area: number): number {
  return Math.floor((Math.round(area * 10000) + 50) / 100);
}

export function normName(name: string): string {
  return name.replace(/\([^)]*\)/g, "").replace(/\s+/g, "");
}
function stripApt(n: string): string {
  return n.endsWith("아파트") && n.length > 3 ? n.slice(0, -3) : n;
}
/** 공고 주소의 시군구·읍면동 토큰과 그 줄기. 첫 토큰(시도)은 뺀다. */
export function regionPrefixes(address: string): string[] {
  const tokens = address.replace(/[(),]/g, " ").split(/\s+/).filter(Boolean).slice(1, 6);
  const out = new Set<string>();
  for (const t of tokens) {
    if (/[시군구읍면동가]$/.test(t) && !/^\d/.test(t)) {
      out.add(t);
      const stem = t.slice(0, -1);
      if (stem.length >= 2) out.add(stem);
    }
  }
  return [...out];
}
export function noticeNameForms(name: string, address: string): string[] {
  const n0 = normName(name);
  const forms = new Set([n0, stripApt(n0)]);
  for (const p of regionPrefixes(address)) {
    if (n0.startsWith(p) && n0.length > p.length) {
      const rest = n0.slice(p.length);
      forms.add(rest);
      forms.add(stripApt(rest));
    }
  }
  forms.delete("");
  return [...forms];
}
function masterNameForms(name: string): string[] {
  const n0 = normName(name);
  return [...new Set([n0, stripApt(n0)])].filter(Boolean);
}

/** (옛 시군구 5자리, 읍면동) → 새 시군구 5자리 집합. */
function loadSuccessor(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!existsSync(SUCCESSOR_CSV)) return out;
  const lines = readFileSync(SUCCESSOR_CSV, "utf8").split(/\r?\n/).filter(Boolean);
  const head = lines[0]!.split(",");
  const iOld = head.indexOf("old_lawd_cd");
  const iRes = head.indexOf("resolved_lawd_cd");
  const iUmd = head.indexOf("umd_nm");
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const key = `${c[iOld]!.slice(0, 5)}|${c[iUmd]}`;
    const set = out.get(key) ?? new Set<string>();
    set.add(c[iRes]!.slice(0, 5));
    out.set(key, set);
  }
  return out;
}

type LinkStage = "NAME" | "LAWD" | "DONG" | "NO_UNIT_TYPES" | "EXCLUSIVE" | "PASS";

async function buildPlan(client: Client, allowSubset: boolean) {
  const q = async (sql: string, args: InArgs = []) => (await client.execute({ sql, args })).rows;

  const notices: Notice[] = (
    await q(`SELECT house_manage_no, house_nm, address, lawd_cd, notice_date, notice_type, house_secd_nm FROM applyhome_notices`)
  ).map((r) => ({
    id: str(r.house_manage_no),
    name: str(r.house_nm),
    address: str(r.address),
    lawd: str(r.lawd_cd),
    date: str(r.notice_date),
    remndr: str(r.notice_type) === "remndr",
    secd: str(r.house_secd_nm),
  }));
  const models = new Map<string, Model[]>();
  for (const r of await q(`SELECT house_manage_no, house_ty, supply_area FROM applyhome_models ORDER BY house_manage_no, model_no`)) {
    const houseTy = str(r.house_ty);
    const ex = houseTyExclusiveCents(houseTy);
    if (ex == null) continue;
    const sa = r.supply_area == null ? null : num(r.supply_area);
    const list = models.get(str(r.house_manage_no)) ?? [];
    list.push({ exCents: ex, supplyCents: sa != null && sa > 0 ? areaCents(sa) : null, letter: houseTyLetter(houseTy), houseTy });
    models.set(str(r.house_manage_no), list);
  }
  const masters = (await q(`SELECT complex_id, apt_name, lawd_cd, legal_dong_name FROM apt_complex_master`)).map(
    (r): Master => ({ id: str(r.complex_id), name: str(r.apt_name), lawd: str(r.lawd_cd), dong: str(r.legal_dong_name) }),
  );
  const byName = new Map<string, Master[]>();
  for (const m of masters) {
    for (const f of masterNameForms(m.name)) {
      const list = byName.get(f) ?? [];
      if (!list.includes(m)) list.push(m);
      byName.set(f, list);
    }
  }
  const successor = loadSuccessor();

  // 1) 이름 후보
  const noticeStage: Record<string, LinkStage> = {};
  const candidates: Array<{ n: Notice; m: Master }> = [];
  for (const n of notices) {
    const seen = new Set<string>();
    for (const f of noticeNameForms(n.name, n.address)) {
      for (const m of byName.get(f) ?? []) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        candidates.push({ n, m });
      }
    }
    noticeStage[n.id] = "NAME";
  }

  // 단지 유형 행 (후보 단지만)
  const units = new Map<string, UnitRow[]>();
  const candIds = [...new Set(candidates.map((c) => c.m.id))];
  for (const part of chunks(candIds, 300)) {
    const rows = await q(
      `SELECT unit_type_id, complex_id, exclusive_cents, supply_cents, supply_area, type_name, status
       FROM apt_canonical_unit_types WHERE complex_id IN (${part.map(() => "?").join(",")})`,
      part,
    );
    for (const r of rows) {
      const list = units.get(str(r.complex_id)) ?? [];
      list.push({
        unitTypeId: str(r.unit_type_id),
        exCents: num(r.exclusive_cents),
        supplyCents: num(r.supply_cents),
        supplyArea: r.supply_area == null ? null : num(r.supply_area),
        typeName: r.type_name == null ? null : str(r.type_name),
        status: str(r.status),
      });
      units.set(str(r.complex_id), list);
    }
  }

  const order: LinkStage[] = ["NAME", "LAWD", "DONG", "NO_UNIT_TYPES", "EXCLUSIVE", "PASS"];
  const better = (a: LinkStage, b: LinkStage) => (order.indexOf(a) > order.indexOf(b) ? a : b);
  const lawdVia: Record<string, number> = { same: 0, successor: 0 };
  const passed: Array<{ n: Notice; m: Master; lawdVia: string; noticeOnlyEx: number[] }> = [];
  const complexStage = new Map<string, { stage: LinkStage; notices: string[] }>();
  const noteComplex = (id: string, stage: LinkStage, nid: string) => {
    const cur = complexStage.get(id);
    if (!cur) complexStage.set(id, { stage, notices: [nid] });
    else {
      cur.stage = better(cur.stage, stage);
      cur.notices.push(nid);
    }
  };
  for (const { n, m } of candidates) {
    let stage: LinkStage = "LAWD";
    let via = "";
    if (n.lawd && n.lawd === m.lawd) via = "same";
    else if (n.lawd) {
      const set = successor.get(`${n.lawd.slice(0, 5)}|${m.dong}`);
      if (set && set.size === 1 && set.has(m.lawd)) via = "successor";
    }
    if (via) {
      stage = "DONG";
      if (m.dong && n.address.includes(m.dong)) {
        stage = "NO_UNIT_TYPES";
        const u = units.get(m.id) ?? [];
        if (u.length > 0) {
          stage = "EXCLUSIVE";
          const cx = new Set(u.map((x) => x.exCents));
          const nx = new Set((models.get(n.id) ?? []).map((x) => x.exCents));
          const missing = [...cx].filter((e) => !nx.has(e));
          const extra = [...nx].filter((e) => !cx.has(e));
          if (nx.size > 0 && missing.length === 0 && (extra.length === 0 || allowSubset)) {
            stage = "PASS";
            passed.push({ n, m, lawdVia: via, noticeOnlyEx: extra });
            bump(lawdVia, via);
          }
        }
      }
    }
    noticeStage[n.id] = better(noticeStage[n.id]!, stage);
    noteComplex(m.id, stage, n.id);
  }

  // 5) 단지별 공고 고르기
  const perComplex = new Map<string, typeof passed>();
  for (const p of passed) {
    const list = perComplex.get(p.m.id) ?? [];
    list.push(p);
    perComplex.set(p.m.id, list);
  }
  const noticeComplexes = new Map<string, Set<string>>();
  for (const p of passed) {
    const s = noticeComplexes.get(p.n.id) ?? new Set<string>();
    s.add(p.m.id);
    noticeComplexes.set(p.n.id, s);
  }
  const exSupplyKey = (nid: string) => {
    const map = new Map<number, Set<number>>();
    for (const md of models.get(nid) ?? []) {
      if (md.supplyCents == null) continue;
      const s = map.get(md.exCents) ?? new Set<number>();
      s.add(md.supplyCents);
      map.set(md.exCents, s);
    }
    return map;
  };
  const agree = (ids: string[]) => {
    const maps = ids.map(exSupplyKey);
    const allEx = new Set(maps.flatMap((m) => [...m.keys()]));
    for (const ex of allEx) {
      const vals = maps.filter((m) => m.has(ex)).map((m) => [...m.get(ex)!].sort((a, b) => a - b).join(","));
      if (new Set(vals).size > 1) return false;
    }
    return true;
  };

  type Link = { complexId: string; complexName: string; lawd: string; dong: string; notices: Array<{ id: string; name: string; address: string; date: string; remndr: boolean; secd: string; lawdVia: string }>; noticeOnlyEx: number[] };
  const links: Link[] = [];
  const complexHold: Record<string, number> = {};
  const heldComplexes: Array<{ complexId: string; name: string; reason: string; notices: string[] }> = [];
  for (const [cid, list] of perComplex) {
    const multiComplex = list.filter((p) => (noticeComplexes.get(p.n.id)?.size ?? 0) > 1);
    if (multiComplex.length > 0) {
      bump(complexHold, "NOTICE_LINKS_MANY_COMPLEXES");
      heldComplexes.push({ complexId: cid, name: list[0]!.m.name, reason: "NOTICE_LINKS_MANY_COMPLEXES", notices: list.map((p) => p.n.id) });
      continue;
    }
    const general = list.filter((p) => !p.n.remndr);
    const chosen = general.length > 0 ? general : list;
    if (!agree(chosen.map((p) => p.n.id))) {
      bump(complexHold, general.length > 0 ? "MULTIPLE_NOTICES_DISAGREE" : "REMNDR_NOTICES_DISAGREE");
      heldComplexes.push({ complexId: cid, name: list[0]!.m.name, reason: "MULTIPLE_NOTICES_DISAGREE", notices: chosen.map((p) => p.n.id) });
      continue;
    }
    const m = chosen[0]!.m;
    links.push({
      complexId: cid,
      complexName: m.name,
      lawd: m.lawd,
      dong: m.dong,
      notices: chosen.map((p) => ({ id: p.n.id, name: p.n.name, address: p.n.address, date: p.n.date, remndr: p.n.remndr, secd: p.n.secd, lawdVia: p.lawdVia })),
      noticeOnlyEx: [...new Set(chosen.flatMap((p) => p.noticeOnlyEx))].sort((a, b) => a - b),
    });
  }

  // 채우기 계획
  const now = new Date().toISOString();
  type SupplyFill = { complexId: string; unitTypeId: string; exCents: number; supplyCents: number; typeName: string | null; houseTys: string[]; notices: string[] };
  type TypeFill = { complexId: string; unitTypeId: string; exCents: number; supplyCents: number; typeName: string; houseTys: string[]; notices: string[] };
  type RowHold = { complexId: string; unitTypeId: string; exCents: number; reason: string; detail: string };
  const supplyFills: SupplyFill[] = [];
  const typeFills: TypeFill[] = [];
  const rowHolds: RowHold[] = [];
  let fullyAfter = 0;
  let hadNull = 0;
  for (const link of links) {
    const nids = link.notices.map((x) => x.id);
    const ms = nids.flatMap((nid) => (models.get(nid) ?? []).map((md) => ({ ...md, nid })));
    const rows = units.get(link.complexId) ?? [];
    const positiveEx = new Set(rows.filter((r) => r.supplyCents >= 0).map((r) => r.exCents));
    let nullLeft = 0;
    let nullRows = 0;
    for (const r of rows) {
      const same = ms.filter((md) => md.exCents === r.exCents);
      const letters = (list: typeof same) => {
        const l = [...new Set(list.map((x) => x.letter).filter(Boolean))].sort();
        return l.length ? l.join("/") : null;
      };
      if (r.supplyArea == null) {
        nullRows += 1;
        if (r.supplyCents !== NO_SUPPLY_CENTS || r.status !== "NO_SOURCE") {
          rowHolds.push({ complexId: link.complexId, unitTypeId: r.unitTypeId, exCents: r.exCents, reason: "UNEXPECTED_NULL_ROW", detail: `${r.status}/${r.supplyCents}` });
          nullLeft += 1;
          continue;
        }
        if (positiveEx.has(r.exCents)) {
          rowHolds.push({ complexId: link.complexId, unitTypeId: r.unitTypeId, exCents: r.exCents, reason: "SAME_EXCLUSIVE_HAS_SUPPLY_ROW", detail: "" });
          nullLeft += 1;
          continue;
        }
        const withSupply = same.filter((x) => x.supplyCents != null);
        const supplies = [...new Set(withSupply.map((x) => x.supplyCents!))];
        if (supplies.length === 0) {
          rowHolds.push({ complexId: link.complexId, unitTypeId: r.unitTypeId, exCents: r.exCents, reason: "NO_MODEL_SUPPLY", detail: "" });
          nullLeft += 1;
          continue;
        }
        if (supplies.length > 1 || withSupply.length !== same.length) {
          rowHolds.push({
            complexId: link.complexId,
            unitTypeId: r.unitTypeId,
            exCents: r.exCents,
            reason: "CONFLICTING_SUPPLIES",
            detail: same.map((x) => `${x.houseTy}=${x.supplyCents == null ? "null" : (x.supplyCents / 100).toFixed(2)}`).join(" "),
          });
          nullLeft += 1;
          continue;
        }
        supplyFills.push({
          complexId: link.complexId,
          unitTypeId: r.unitTypeId,
          exCents: r.exCents,
          supplyCents: supplies[0]!,
          typeName: letters(same),
          houseTys: [...new Set(same.map((x) => x.houseTy))],
          notices: [...new Set(same.map((x) => x.nid))],
        });
      } else if (r.typeName == null) {
        const match = same.filter((x) => x.supplyCents === r.supplyCents);
        const t = letters(match);
        if (t) {
          typeFills.push({
            complexId: link.complexId,
            unitTypeId: r.unitTypeId,
            exCents: r.exCents,
            supplyCents: r.supplyCents,
            typeName: t,
            houseTys: [...new Set(match.map((x) => x.houseTy))],
            notices: [...new Set(match.map((x) => x.nid))],
          });
        }
      }
    }
    if (nullRows > 0) hadNull += 1;
    if (nullRows > 0 && nullLeft === 0) fullyAfter += 1;
  }

  // 진단 요약
  const noticeStageCounts: Record<string, number> = {};
  for (const n of notices) {
    bump(noticeStageCounts, `${n.remndr ? "remndr" : "general"}:${noticeStage[n.id]}`);
  }
  const complexStageCounts: Record<string, number> = {};
  for (const v of complexStage.values()) bump(complexStageCounts, v.stage);
  const rowHoldCounts: Record<string, number> = {};
  for (const h of rowHolds) bump(rowHoldCounts, h.reason);

  const watch = WATCH.map((id) => {
    const cs = complexStage.get(id);
    const link = links.find((l) => l.complexId === id);
    const held = heldComplexes.find((h) => h.complexId === id);
    const rows = units.get(id) ?? [];
    const noticeEx = (cs?.notices ?? []).map((nid) => ({
      nid,
      name: notices.find((n) => n.id === nid)?.name,
      exclusives: [...new Set((models.get(nid) ?? []).map((x) => x.exCents))].sort((a, b) => a - b),
    }));
    return {
      complexId: id,
      name: masters.find((m) => m.id === id)?.name,
      bestStage: cs?.stage ?? "NO_NAME_CANDIDATE",
      linked: !!link,
      held: held?.reason,
      complexExclusives: [...new Set(rows.map((r) => r.exCents))].sort((a, b) => a - b),
      nameCandidates: noticeEx,
      supplyFills: supplyFills.filter((f) => f.complexId === id),
      rowHolds: rowHolds.filter((h) => h.complexId === id),
    };
  });

  const typeLetterDist: Record<string, number> = {};
  for (const f of supplyFills) bump(typeLetterDist, f.typeName ?? "(none)");

  const summary = {
    built_at: now,
    allowSubset,
    notices: { total: notices.length, general: notices.filter((n) => !n.remndr).length, remndr: notices.filter((n) => n.remndr).length, noLawd: notices.filter((n) => !n.lawd).length },
    noticeBestStage: noticeStageCounts,
    nameCandidatePairs: candidates.length,
    complexesWithNameCandidate: complexStage.size,
    complexBestStage: complexStageCounts,
    passedPairs: passed.length,
    passedLawdVia: lawdVia,
    complexesPassed: perComplex.size,
    complexHold,
    complexesLinked: links.length,
    linksUsingRemndrOnly: links.filter((l) => l.notices.every((x) => x.remndr)).length,
    linksWithMultipleNotices: links.filter((l) => l.notices.length > 1).length,
    fill: {
      supplyRows: supplyFills.length,
      supplyComplexes: new Set(supplyFills.map((f) => f.complexId)).size,
      supplyRowsWithTypeName: supplyFills.filter((f) => f.typeName).length,
      typeNameOnlyRows: typeFills.length,
      rowHolds: rowHoldCounts,
      linkedComplexesWithNullRows: hadNull,
      complexesFullySuppliedAfter: fullyAfter,
      typeNameValues: typeLetterDist,
    },
  };

  // 실행문 (apply 때 그대로 씀). 행마다 빈 값 조건.
  const statements: Array<Stmt & { kind: string }> = [];
  for (const f of supplyFills) {
    const supplyArea = areaFromCents(f.supplyCents);
    statements.push({
      kind: "supply",
      sql: `UPDATE apt_canonical_unit_types
            SET supply_area = ?, supply_cents = ?, supply_pyeong = ?, display_pyeong_label = ?,
                type_name = COALESCE(type_name, ?), source = 'applyhome', source_key = ?, source_as_of = ?,
                confidence = 'applyhome_notice', status = 'EXACT_SINGLE', formula = 'applyhome_model_supply_area',
                provenance_json = ?, updated_at = ?
            WHERE unit_type_id = ? AND complex_id = ? AND exclusive_cents = ?
              AND supply_area IS NULL AND supply_cents = ? AND status = 'NO_SOURCE'
              AND NOT EXISTS (SELECT 1 FROM apt_canonical_unit_types o
                              WHERE o.complex_id = ? AND o.exclusive_cents = ? AND o.supply_cents = ?)`,
      args: [
        supplyArea,
        f.supplyCents,
        canonicalSupplyPyeong(supplyArea),
        supplyPyeongDisplayLabel(supplyArea),
        f.typeName,
        `applyhome:${f.notices.join("+")}:${f.exCents}:${f.supplyCents}`,
        f.notices.map((nid) => notices.find((n) => n.id === nid)?.date ?? "").sort().at(-1) ?? "",
        JSON.stringify({ recovery: RECOVERY, source: "applyhome_models", house_manage_no: f.notices, house_ty: f.houseTys, type_name: f.typeName }),
        now,
        f.unitTypeId,
        f.complexId,
        f.exCents,
        NO_SUPPLY_CENTS,
        f.complexId,
        f.exCents,
        f.supplyCents,
      ],
    });
    statements.push({
      kind: "pair",
      sql: `UPDATE apt_unit_exclusive_pairs
            SET resolution_status = 'EXACT_SINGLE', supply_variant_count = 1,
                observed_from = CASE WHEN observed_from LIKE '%applyhome%' THEN observed_from ELSE observed_from || '+applyhome' END
            WHERE complex_id = ? AND exclusive_cents = ? AND resolution_status = 'NO_SOURCE'
              AND EXISTS (SELECT 1 FROM apt_canonical_unit_types c WHERE c.unit_type_id = ? AND c.source = 'applyhome' AND c.supply_cents = ?)`,
      args: [f.complexId, f.exCents, f.unitTypeId, f.supplyCents],
    });
  }
  for (const f of typeFills) {
    statements.push({
      kind: "type_name",
      sql: `UPDATE apt_canonical_unit_types SET type_name = ?, updated_at = ?
            WHERE unit_type_id = ? AND type_name IS NULL AND supply_cents = ?`,
      args: [f.typeName, now, f.unitTypeId, f.supplyCents],
    });
  }

  // 백업: 바뀔 행의 지금 값
  const touched = [...new Set([...supplyFills, ...typeFills].map((f) => f.unitTypeId))];
  const backupRows: unknown[] = [];
  for (const part of chunks(touched, 300)) {
    const rows = await q(`SELECT * FROM apt_canonical_unit_types WHERE unit_type_id IN (${part.map(() => "?").join(",")})`, part);
    backupRows.push(...rows.map((r) => ({ ...r })));
  }
  const pairKeys = supplyFills.map((f) => [f.complexId, f.exCents] as const);
  const backupPairs: unknown[] = [];
  for (const part of chunks(pairKeys, 150)) {
    const rows = await q(
      `SELECT * FROM apt_unit_exclusive_pairs WHERE ${part.map(() => "(complex_id = ? AND exclusive_cents = ?)").join(" OR ")}`,
      part.flat(),
    );
    backupPairs.push(...rows.map((r) => ({ ...r })));
  }

  return { summary, links, heldComplexes, supplyFills, typeFills, rowHolds, watch, statements, backup: { apt_canonical_unit_types: backupRows, apt_unit_exclusive_pairs: backupPairs } };
}

async function main() {
  const mode = process.argv[2] ?? "plan";
  const allowSubset = process.argv.includes("--allow-subset");
  const client = db();
  mkdirSync(OUT, { recursive: true });
  const tag = allowSubset ? "-subset" : "";
  const planPath = join(OUT, `plan${tag}.json`);

  if (mode === "plan") {
    const p = await buildPlan(client, allowSubset);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(planPath, JSON.stringify({ summary: p.summary, statements: p.statements }, null, 1));
    writeFileSync(
      join(OUT, `links${tag}.json`),
      JSON.stringify({ summary: p.summary, watch: p.watch, links: p.links, heldComplexes: p.heldComplexes, supplyFills: p.supplyFills, typeFills: p.typeFills, rowHolds: p.rowHolds }, null, 1),
    );
    if (p.statements.length > 0) writeFileSync(join(OUT, `backup${tag}-${stamp}.json`), JSON.stringify(p.backup));
    const sample = p.links.slice(0, 20).map((l) => `${l.complexName} (${l.complexId}) ↔ ${l.notices.map((n) => `${n.name} [${n.id}${n.remndr ? " 무순위" : ""}] ${n.address}`).join(" | ")}`);
    console.log(JSON.stringify({ mode, ...p.summary, statements: p.statements.length, sample, watch: p.watch.map((w) => ({ ...w, nameCandidates: w.nameCandidates })) }, null, 2));
    return;
  }
  if (mode === "apply") {
    if (allowSubset) throw new Error("--allow-subset 계획은 진단용이라 apply하지 않습니다.");
    if (!existsSync(planPath)) throw new Error("먼저 plan을 돌려 plan.json을 만드세요.");
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as { statements: Array<Stmt & { kind: string }> };
    const done: Record<string, number> = {};
    const planned: Record<string, number> = {};
    for (const s of plan.statements) bump(planned, s.kind);
    // supply 행을 먼저, 그다음 pair(행이 applyhome으로 바뀐 것만), 그다음 type_name.
    const ordered = [...plan.statements].sort((a, b) => ["supply", "pair", "type_name"].indexOf(a.kind) - ["supply", "pair", "type_name"].indexOf(b.kind));
    for (const part of chunks(ordered, 40)) {
      const res = await client.batch(part.map((s) => ({ sql: s.sql, args: s.args })), "write");
      part.forEach((s, i) => bump(done, s.kind, res[i]!.rowsAffected));
    }
    const out = { applied_at: new Date().toISOString(), planned, changed: done };
    writeFileSync(join(OUT, `apply-${out.applied_at.replace(/[:.]/g, "-")}.json`), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
