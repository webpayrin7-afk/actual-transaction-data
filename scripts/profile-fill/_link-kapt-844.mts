/**
 * Scoped K-apt link for the 844 bjdong-remap complexes. Same exact rules as link-kapt.mts
 * (10-digit 법정동 + 본번/부번 from K-apt 지번주소, or road address equality; >1 candidate → none;
 * a code matching >1 complex → none; existing KAPT links untouched). Uniqueness is checked against
 * every master complex in the affected lawd codes, but inserts are only for the 844.
 *   tsx scripts/profile-fill/_link-kapt-844.mts list|address|plan|apply
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { createClient } from "@libsql/client";
import { jibunToken, keyFromParts, masterJibun, normalizeAddress, parcelKeyString } from "./kapt-match";
config({ path: ".env.local", quiet: true });

const IDS = new Set<string>(JSON.parse(readFileSync("C:/dev/ziplab-wt/topology/scratch844/ids.json", "utf8")));
const LAWDS = ["41194", "41196", "41591", "41593", "41595", "41597"];
const PREFIXES = [...LAWDS, "41190", "41192", "41195", "41197", "41590"];
const LIST = "data/profile-fill-cache/kapt-list-844.jsonl";
const KAPT_DIR = "data/profile-fill-cache/kapt";
const OUT = "data/poc/profile";
const str = (v: unknown) => (v == null ? "" : String(v).trim());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
class QuotaError extends Error {}
let calls = 0;
async function fetchJson(path: string, qs: Record<string, string>) {
  const u = new URL(`https://apis.data.go.kr/1613000${path}`);
  u.searchParams.set("serviceKey", process.env.MOLIT_API_KEY!.trim());
  for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v);
  u.searchParams.set("_type", "json");
  let last = "";
  for (let a = 0; a < 6; a++) {
    await sleep(300);
    calls++;
    let text = "";
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
      text = await res.text();
      if (!res.ok) {
        last = `HTTP ${res.status}`;
        await sleep(1500 * (a + 1));
        continue;
      }
    } catch {
      last = "network";
      await sleep(1500 * (a + 1));
      continue;
    }
    if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS|SERVICE_REQUESTS_EXCEEDS|"returnReasonCode"\s*:\s*"(22|04)"|openapi_04/.test(text) && !/PER_SECOND/.test(text)) {
      throw new QuotaError(text.slice(0, 120));
    }
    if (/PER_SECOND/.test(text)) {
      await sleep(3000);
      last = "per-second";
      continue;
    }
    try {
      const p = JSON.parse(text);
      const code = str(p.response?.header?.resultCode);
      if (code === "00" || code === "03") {
        const it = p.response?.body?.items;
        const raw = it && !Array.isArray(it) ? it.item : it;
        return {
          total: Number(p.response?.body?.totalCount ?? 0),
          items: (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<string, unknown>[],
        };
      }
      last = `API ${code}`;
    } catch {
      last = "bad-json";
    }
    await sleep(1000 * (a + 1));
  }
  throw new Error(last);
}
const readList = () =>
  existsSync(LIST)
    ? readFileSync(LIST, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kaptCode: string; bjdCode: string })
    : [];
const db = createClient({ url: process.env.TURSO_DATABASE_URL!.trim(), authToken: process.env.TURSO_AUTH_TOKEN!.trim() });
const phase = process.argv[2] ?? "plan";
try {
  if (phase === "list") {
    const keep: string[] = [];
    let page = 1;
    let total = Infinity;
    let seen = 0;
    while ((page - 1) * 1000 < total && page <= 40) {
      const got = await fetchJson("/AptListService4/getSidoAptList4", { sidoCode: "41", pageNo: String(page), numOfRows: "1000" });
      total = got.total;
      if (!got.items.length) break;
      seen += got.items.length;
      for (const it of got.items) {
        if (PREFIXES.some((p) => str(it.bjdCode).startsWith(p))) keep.push(JSON.stringify({ kaptCode: str(it.kaptCode), bjdCode: str(it.bjdCode) }));
      }
      page++;
    }
    mkdirSync("data/profile-fill-cache", { recursive: true });
    writeFileSync(LIST, keep.join("\n") + "\n");
    const byP: Record<string, number> = {};
    for (const l of keep) {
      const b = JSON.parse(l).bjdCode.slice(0, 5);
      byP[b] = (byP[b] ?? 0) + 1;
    }
    console.log(JSON.stringify({ sido41: total, seen, kept: keep.length, byPrefix: byP, calls }));
  } else if (phase === "address") {
    const linked = new Set((await db.execute(`SELECT source_key FROM apt_complex_source_links WHERE source='KAPT'`)).rows.map((r) => str(r.source_key)));
    mkdirSync(KAPT_DIR, { recursive: true });
    let fetched = 0, cached = 0, skipped = 0, failed = 0;
    for (const row of readList()) {
      if (linked.has(row.kaptCode)) {
        skipped++;
        continue;
      }
      const file = `${KAPT_DIR}/${row.kaptCode}.json`;
      const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      if (prev.bassOk) {
        cached++;
        continue;
      }
      try {
        const got = await fetchJson("/AptBasisInfoServiceV5/getAphusBassInfoV5", { kaptCode: row.kaptCode });
        writeFileSync(file, JSON.stringify({ ...prev, bass: got.items[0] ?? null, bassOk: true, dtl: prev.dtl ?? null, dtlOk: Boolean(prev.dtlOk) }));
        fetched++;
      } catch (e) {
        if (e instanceof QuotaError) throw e;
        failed++;
      }
    }
    console.log(JSON.stringify({ fetched, cached, skipped, failed, calls }));
  } else {
    const apply = phase === "apply";
    const existing = new Map<string, string>();
    for (const r of (await db.execute(`SELECT source_key, complex_id FROM apt_complex_source_links WHERE source='KAPT'`)).rows) {
      existing.set(str(r.source_key), str(r.complex_id));
    }
    const byParcel = new Map<string, string[]>();
    const byRoad = new Map<string, string[]>();
    let addressed = 0;
    for (const row of readList()) {
      if (existing.has(row.kaptCode)) continue;
      const file = `${KAPT_DIR}/${row.kaptCode}.json`;
      if (!existsSync(file)) continue;
      const bass = JSON.parse(readFileSync(file, "utf8")).bass;
      if (!bass) continue;
      addressed++;
      const bjd = str(bass.bjdCode) || row.bjdCode;
      const tok = jibunToken(str(bass.kaptAddr));
      const k = tok && /^\d{10}$/.test(bjd) ? keyFromParts(bjd, tok.san, tok.bun, tok.ji) : null;
      if (k) {
        const s = parcelKeyString(k);
        byParcel.set(s, [...(byParcel.get(s) ?? []), row.kaptCode]);
      }
      const road = normalizeAddress(str(bass.doroJuso));
      if (road) byRoad.set(road, [...(byRoad.get(road) ?? []), row.kaptCode]);
    }
    const have = new Set(existing.values());
    const masters = await db.execute({
      sql: `SELECT complex_id, lawd_cd, bjdong_cd, jibun, road_address FROM apt_complex_master WHERE lawd_cd IN (${LAWDS.map(() => "?").join(",")})`,
      args: LAWDS,
    });
    const links: { complexId: string; kaptCode: string; via: string }[] = [];
    let noCand = 0, multi = 0, already = 0;
    for (const r of masters.rows) {
      const id = str(r.complex_id);
      if (have.has(id)) {
        already++;
        continue;
      }
      const mj = masterJibun(str(r.jibun));
      const mk = mj ? keyFromParts(str(r.lawd_cd) + str(r.bjdong_cd), mj.san, mj.bun, mj.ji) : null;
      const codes = new Set<string>();
      const vias = new Set<string>();
      if (mk) for (const c of byParcel.get(parcelKeyString(mk)) ?? []) { codes.add(c); vias.add("jibun"); }
      const road = normalizeAddress(str(r.road_address));
      if (road) for (const c of byRoad.get(road) ?? []) { codes.add(c); vias.add("road"); }
      if (codes.size === 0) { if (IDS.has(id)) noCand++; }
      else if (codes.size > 1) { if (IDS.has(id)) multi++; }
      else links.push({ complexId: id, kaptCode: [...codes][0]!, via: [...vias].sort().join("+") });
    }
    const byCode = new Map<string, number>();
    for (const l of links) byCode.set(l.kaptCode, (byCode.get(l.kaptCode) ?? 0) + 1);
    const unique = links.filter((l) => byCode.get(l.kaptCode) === 1 && IDS.has(l.complexId));
    const shared = links.filter((l) => byCode.get(l.kaptCode)! > 1 && IDS.has(l.complexId)).length;
    const summary = {
      list: readList().length,
      addressed,
      masters6lawd: masters.rows.length,
      alreadyLinked6lawd: already,
      target844NoCandidate: noCand,
      target844Multi: multi,
      target844CodeShared: shared,
      insert: unique.length,
      via: unique.reduce<Record<string, number>>((m, l) => ((m[l.via] = (m[l.via] ?? 0) + 1), m), {}),
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/kapt-link-plan-844.json`, JSON.stringify({ summary, links: unique }, null, 1));
    console.log(JSON.stringify(summary, null, 1));
    if (apply) {
      const now = new Date().toISOString();
      let applied = 0;
      for (const l of unique) {
        applied += (await db.execute({
          sql: `INSERT INTO apt_complex_source_links (source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at)
                VALUES ('KAPT', ?, ?, ?, 'profile_fill_kapt_exact_2026_09', ?, ?) ON CONFLICT DO NOTHING`,
          args: [l.kaptCode, l.complexId, JSON.stringify({ via: l.via, match: "exact_bjd_jibun_or_road", scope: "bjdong-remap-2026-09-25" }), now, now],
        })).rowsAffected;
      }
      console.log(JSON.stringify({ applied }));
    }
  }
} catch (e) {
  if (e instanceof QuotaError) {
    console.log(JSON.stringify({ quotaStop: true, calls, msg: e.message }));
    process.exit(3);
  }
  throw e;
}
