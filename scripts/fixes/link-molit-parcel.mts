/**
 * 지방 단지 상세가 단지를 못 찾는 문제 — 실거래 단지명(MOLIT) → 단지(complex_id) 연결 채우기.
 * 지방 마스터는 K-apt 이름(옥암3차골드디움)으로 만들어져, 실거래 이름(골드디움3차)으로 들어온 상세 페이지가 이름으로 못 찾는다.
 *
 * 규칙 (이름 비교 없음, 추정 없음):
 *   실거래 (lawd_cd, dong, jibun) = K-apt 단지 기본정보 (lawd_cd, bjdong_name, parcel_address의 지번)  — 필지 정확히 같을 때만.
 *   → kapt_code → 이미 있는 KAPT 연결(apt_complex_source_links source='KAPT')로 complex_id.
 *   보류: 한 필지에 K-apt 단지가 여럿(parcel_multi), 한 이름의 필지들이 서로 다른 단지로 가거나 일부만 맞음,
 *         건축년도 ≠ 사용승인 연도(둘 다 있을 때), 이름이 이미 마스터와 맞음(연결 불필요), 이미 연결 있음.
 * 쓰기: apt_complex_source_links (source='MOLIT', source_key='lawd|norm') 없는 것만 INSERT OR IGNORE. 기존 행은 안 건드린다.
 * 서울(11)·경기(41)는 이미 MOLIT 연결이 있어 뺀다. K-apt API 호출 없음.
 *
 *   npx tsx scripts/fixes/link-molit-parcel.mts            # 계획만 (manifest 파일)
 *   npx tsx scripts/fixes/link-molit-parcel.mts --apply    # 계획대로 쓰기
 *   [--since=YYYYMM]  실거래(매매) 기준 월, 기본 202510 (최근 12개월)
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";

const UNIVERSE_CANDIDATES = [
  "C:/data/fixes/master-jibun-2026-09-26/kapt-complex-universe.jsonl",
  "C:/dev/ziplab-wt/mgmt-fee/data/poc/mgmt-fee-canonical/national-kapt-identity/kapt-complex-universe.jsonl",
];
const OUT = "C:/data/fixes/molit-parcel-link-2026-09-26";
const VERSION = "molit_parcel_kapt_2026_09";
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const APPLY = process.argv.includes("--apply");
const SINCE = arg("since") || "202510";
const SIX_MONTHS = "202604";

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
/** 지번 "148-4" / "920" / "123-0"→"123". 산 지번·숫자 아닌 것은 "" (보류). */
const jibunKey = (s: string) => {
  const m = s.trim().match(/^0*(\d+)(?:-0*(\d+))?$/);
  if (!m) return "";
  return m[2] && m[2] !== "0" && m[2] !== "" ? `${m[1]}-${m[2]}` : m[1]!;
};

type U = { kapt_code: string; lawd_cd: string; bjdong_name: string; parcel_address: string; apt_name: string };
type Pair = {
  lawd: string;
  norm: string;
  names: Set<string>;
  parcels: Set<string>;
  years: Set<number>;
  deals: number;
  deals6: number;
};

const db = getDb()!;
const rows = async (sql: string, args: Array<string | number> = []) => (await db.execute({ sql, args })).rows;

// 1) K-apt 필지 → kapt_code
const uniPath = UNIVERSE_CANDIDATES.find((p) => existsSync(p));
if (!uniPath) throw new Error("kapt-complex-universe.jsonl 없음");
const parcelKapt = new Map<string, Set<string>>();
const kaptName = new Map<string, string>();
let uniRows = 0;
let uniNoJibun = 0;
for (const l of readFileSync(uniPath, "utf8").split("\n")) {
  if (!l.trim()) continue;
  const u = JSON.parse(l) as U;
  uniRows++;
  kaptName.set(u.kapt_code, u.apt_name);
  const bj = (u.bjdong_name ?? "").trim();
  // "… 동패동 2305,경기도 파주시 동패동 2305- 단지명" 처럼 필지가 쉼표로 여럿 — 같은 법정동 필지만, 끝 "-"는 본번만.
  const jbs = new Set<string>();
  for (const seg of bj ? u.parcel_address.split(",") : []) {
    const at = seg.indexOf(` ${bj} `);
    if (at < 0) continue;
    const tok = (seg.slice(at + bj.length + 2).trim().split(/\s+/)[0] ?? "").replace(/-$/, "");
    const jb = jibunKey(tok);
    if (jb) jbs.add(jb);
  }
  if (!u.lawd_cd || !jbs.size) {
    uniNoJibun++;
    continue;
  }
  for (const jb of jbs) {
    const k = `${u.lawd_cd}|${bj}|${jb}`;
    if (!parcelKapt.has(k)) parcelKapt.set(k, new Set());
    parcelKapt.get(k)!.add(u.kapt_code);
  }
}

// 2) DB: KAPT 연결, 마스터 이름, 기존 MOLIT 연결
const kaptComplex = new Map<string, string>();
for (const r of await rows(`SELECT source_key, complex_id FROM apt_complex_source_links WHERE source = 'KAPT'`))
  kaptComplex.set(String(r.source_key), String(r.complex_id));
const masterNames = new Set<string>();
const masterName = new Map<string, string>();
const lawds = new Set<string>();
for (const r of await rows(`SELECT complex_id, lawd_cd, apt_name_norm, apt_name FROM apt_complex_master`)) {
  masterNames.add(`${r.lawd_cd}|${norm(String(r.apt_name_norm))}`);
  masterName.set(String(r.complex_id), String(r.apt_name));
  if (!/^(11|41)/.test(String(r.lawd_cd))) lawds.add(String(r.lawd_cd));
}
const molitLinks = new Set<string>();
for (const r of await rows(`SELECT source_key FROM apt_complex_source_links WHERE source = 'MOLIT'`))
  molitLinks.add(String(r.source_key));

// 3) 실거래 (지방, 매매) — 시군구별 인덱스(lawd_cd, year_month, deal_type) 조회
const pairs = new Map<string, Pair>();
for (const lawd of [...lawds].sort()) {
  const rs = await rows(
    `SELECT apt_name, apt_name_norm, dong, jibun, build_year, year_month >= ? AS recent, count(*) AS n
     FROM transactions
     WHERE lawd_cd = ? AND year_month >= ? AND deal_type = 'trade'
     GROUP BY apt_name, apt_name_norm, dong, jibun, build_year, recent`,
    [SIX_MONTHS, lawd, SINCE],
  );
  for (const r of rs) {
    const n = norm(String(r.apt_name_norm));
    const key = `${lawd}|${n}`;
    let p = pairs.get(key);
    if (!p) {
      p = { lawd, norm: n, names: new Set(), parcels: new Set(), years: new Set(), deals: 0, deals6: 0 };
      pairs.set(key, p);
    }
    p.names.add(String(r.apt_name));
    const jb = jibunKey(String(r.jibun ?? ""));
    p.parcels.add(jb ? `${lawd}|${String(r.dong ?? "").trim()}|${jb}` : "");
    if (r.build_year != null && Number(r.build_year) > 0) p.years.add(Number(r.build_year));
    p.deals += Number(r.n);
    if (Number(r.recent) === 1) p.deals6 += Number(r.n);
  }
}

// 4) 판정
type Plan = {
  key: string;
  complexId: string;
  kaptCode: string;
  molitName: string;
  masterName: string;
  kaptName: string;
  parcel: string;
  years: number[];
  approvalYear: number | null;
  deals: number;
  deals6: number;
};
const cand: Array<Omit<Plan, "approvalYear">> = [];
const held: Record<string, { pairs: number; deals6: number }> = {};
const hold = (why: string, p: Pair) => {
  held[why] ??= { pairs: 0, deals6: 0 };
  held[why].pairs++;
  held[why].deals6 += p.deals6;
};
const nameMatched = { pairs: 0, deals: 0, deals6: 0 };
const linked = { pairs: 0, deals: 0, deals6: 0 };
const total = { pairs: 0, deals: 0, deals6: 0 };
const pairs6 = { total: 0, name: 0, linked: 0, added: 0 };
for (const [key, p] of pairs) {
  total.pairs++;
  total.deals += p.deals;
  total.deals6 += p.deals6;
  if (p.deals6 > 0) pairs6.total++;
  if (masterNames.has(key)) {
    nameMatched.pairs++;
    nameMatched.deals += p.deals;
    nameMatched.deals6 += p.deals6;
    if (p.deals6 > 0) pairs6.name++;
    continue;
  }
  if (molitLinks.has(key)) {
    linked.pairs++;
    linked.deals += p.deals;
    linked.deals6 += p.deals6;
    if (p.deals6 > 0) pairs6.linked++;
    continue;
  }
  if (p.parcels.has("")) {
    hold("no_jibun", p);
    continue;
  }
  const complexes = new Map<string, string>(); // complex_id → kapt_code
  let why = "";
  for (const pc of p.parcels) {
    const ks = parcelKapt.get(pc);
    if (!ks) {
      why = p.parcels.size > 1 ? "pair_partial_parcel_miss" : "parcel_miss";
      break;
    }
    if (ks.size > 1) {
      why = "parcel_multi";
      break;
    }
    const kc = [...ks][0]!;
    const cx = kaptComplex.get(kc);
    if (!cx) {
      why = "kapt_not_in_master";
      break;
    }
    complexes.set(cx, kc);
  }
  if (!why && complexes.size > 1) why = "pair_multi_complex";
  if (why) {
    hold(why, p);
    continue;
  }
  const [cx, kc] = [...complexes][0]!;
  cand.push({
    key,
    complexId: cx,
    kaptCode: kc,
    molitName: [...p.names].join(" / "),
    masterName: masterName.get(cx) ?? "",
    kaptName: kaptName.get(kc) ?? "",
    parcel: [...p.parcels].join(" ; "),
    years: [...p.years].sort(),
    deals: p.deals,
    deals6: p.deals6,
  });
}

// 5) 건축년도 = 사용승인 연도 (둘 다 있을 때)
const approval = new Map<string, number>();
const ids = [...new Set(cand.map((c) => c.complexId))];
for (let i = 0; i < ids.length; i += 400) {
  const part = ids.slice(i, i + 400);
  for (const r of await rows(
    `SELECT complex_id, approval_date FROM apt_complex_profile WHERE complex_id IN (${part.map(() => "?").join(",")})`,
    part,
  )) {
    const y = Number(String(r.approval_date ?? "").slice(0, 4));
    if (y > 1900) approval.set(String(r.complex_id), y);
  }
}
const plan: Plan[] = [];
let noYear = 0;
for (const c of cand) {
  const ay = approval.get(c.complexId) ?? null;
  if (ay != null && c.years.length && c.years.some((y) => y !== ay)) {
    hold(c.years.length > 1 ? "year_multi_mismatch" : "year_mismatch", { deals6: c.deals6 } as Pair);
    continue;
  }
  if (ay == null || !c.years.length) noYear++;
  plan.push({ ...c, approvalYear: ay });
}
for (const p of plan) if (p.deals6 > 0) pairs6.added++;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "plan.jsonl"), plan.map((p) => JSON.stringify(p)).join("\n") + (plan.length ? "\n" : ""));
const added6 = plan.reduce((a, p) => a + p.deals6, 0);
const summary = {
  built_at: new Date().toISOString(),
  universe: { file: uniPath, rows: uniRows, noJibun: uniNoJibun, parcels: parcelKapt.size },
  since: SINCE,
  pairs: total,
  alreadyNameMatched: nameMatched,
  alreadyLinked: linked,
  plan: { pairs: plan.length, complexes: new Set(plan.map((p) => p.complexId)).size, withoutYearCheck: noYear, deals: plan.reduce((a, p) => a + p.deals, 0), deals6: added6 },
  held,
  coverage6m: {
    pairs: pairs6,
    dealsTotal: total.deals6,
    before: nameMatched.deals6 + linked.deals6,
    after: nameMatched.deals6 + linked.deals6 + added6,
    beforePct: +((100 * (nameMatched.deals6 + linked.deals6)) / Math.max(1, total.deals6)).toFixed(1),
    afterPct: +((100 * (nameMatched.deals6 + linked.deals6 + added6)) / Math.max(1, total.deals6)).toFixed(1),
  },
};
writeFileSync(join(OUT, APPLY ? "summary-apply.json" : "summary-dry-run.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));

if (APPLY && plan.length) {
  const now = new Date().toISOString();
  let inserted = 0;
  for (let i = 0; i < plan.length; i += 200) {
    const part = plan.slice(i, i + 200);
    const res = await db.batch(
      part.map((p) => {
        const [lawd, dong, jibun] = p.parcel.split(" ; ")[0]!.split("|");
        return {
          sql: `INSERT OR IGNORE INTO apt_complex_source_links
                  (source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at)
                VALUES ('MOLIT', ?, ?, ?, ?, ?, ?)`,
          args: [
            p.key,
            p.complexId,
            JSON.stringify({
              lawd_cd: lawd,
              apt_name_norm: p.key.slice(p.key.indexOf("|") + 1),
              basis: "PARCEL_EXACT_KAPT",
              kapt_code: p.kaptCode,
              dong,
              jibun,
              parcels: p.parcel.split(" ; ").length,
              build_years: p.years,
              approval_year: p.approvalYear,
            }),
            VERSION,
            now,
            now,
          ],
        };
      }),
      "write",
    );
    inserted += res.reduce((a, r) => a + r.rowsAffected, 0);
  }
  console.log(JSON.stringify({ planned: plan.length, inserted }));
}
