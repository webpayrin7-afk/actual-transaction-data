/**
 * 지방 단지 마스터 지번(apt_complex_master.jibun) 빈 칸 채우기 — K-apt 단지 기본정보의 지번주소(parcel_address)만.
 * 지방 마스터 행은 K-apt에서 왔는데 지번이 비어 PNU를 못 만들어서, 건축물대장(표제부)·필지 좌표·학교/생활 계산이 시작조차 안 됐다.
 *
 * 규칙 (추정·이름 유사 매칭 없음):
 *   ① 단지 ↔ K-apt 연결은 apt_complex_source_links(source='KAPT')의 source_key = K-apt kapt_code 정확 일치만.
 *   ② K-apt 행의 lawd_cd·bjdong_code가 마스터의 lawd_cd·bjdong_cd와 둘 다 같아야 한다.
 *   ③ 지번주소에서 법정동 이름(bjdong_name) 바로 뒤 토큰만 지번으로 읽는다: "175", "592-39", "산12-3".
 *      끝이 "316-"처럼 부번 없이 끝나면 본번 316. 그 밖의 모양은 보류.
 *   ④ 같은 kapt_code가 파일에 여러 줄이면 모든 줄의 (lawd, bjdong, 지번)이 같을 때만.
 *   ⑤ 지도 앵커(complex_map_anchor.matched_jibun, 도로명 지오코딩이 돌려준 지번)가 있으면 그 지번과 같아야 한다.
 *      다르면(K-apt 지번이 환지 전 옛 지번인 신축 등) 보류 — 틀린 필지로 건축물대장을 부르지 않게.
 *      "N,…" 처럼 필지가 여럿 적힌 주소도 보류.
 * 빈 칸만: UPDATE ... WHERE jibun IS NULL OR jibun = ''. 시도별로 나눠서 쓴다(Turso 쓰기 한도 — 바뀌는 행만).
 *
 *   npx tsx scripts/fixes/fill-master-jibun.mts                       # 계획만(dry-run): plan.json·보류 통계 (DB 쓰기 없음)
 *   npx tsx scripts/fixes/fill-master-jibun.mts --apply [--sido 부산]  # 계획대로 쓰기 (--sido는 이름 앞부분 일치로 범위 제한)
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";

const OUT = "C:/data/fixes/master-jibun-2026-09-26";
// K-apt 20260918 단지 기본정보 스냅샷 (mgmt-fee 작업트리의 national-kapt-identity 산출물을 복사해 둔 것)
const UNIVERSE = join(OUT, "kapt-complex-universe.jsonl");
const PLAN = join(OUT, "plan.json");

type Universe = { kapt_code: string; lawd_cd: string; bjdong_code: string; bjdong_name: string; parcel_address: string };
type Fill = { complexId: string; sido: string; aptName: string; kaptCode: string; jibun: string; parcel: string; anchorChecked: boolean };

/** 법정동 이름 바로 뒤 토큰 → "175" / "592-39" / "산12-3". 못 읽으면 null. */
export function lotFromParcel(parcel: string, bjdongName: string): string | null {
  const addr = parcel.replace(/\s+/g, " ").trim();
  const name = bjdongName.replace(/\s+/g, " ").trim();
  if (!name) return null;
  const at = addr.indexOf(` ${name} `);
  // 단지 이름에 동 이름이 또 나올 수 있어("옥동 651-3 옥동 경남아너스빌") 첫 번째만 본다
  if (at < 0) return null;
  const token = addr.slice(at + name.length + 2).split(" ")[0] ?? "";
  const m = /^(산)?(\d{1,4})(?:-(\d{1,4})?)?(?:번지)?$/.exec(token);
  if (!m) return null;
  const bun = String(Number(m[2]));
  const ji = m[3] ? String(Number(m[3])) : "0";
  if (bun === "0") return null;
  return `${m[1] ?? ""}${bun}${ji === "0" ? "" : `-${ji}`}`;
}

function loadUniverse() {
  const byCode = new Map<string, Universe[]>();
  for (const l of readFileSync(UNIVERSE, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const u = JSON.parse(l) as Universe;
    const list = byCode.get(u.kapt_code) ?? [];
    list.push(u);
    byCode.set(u.kapt_code, list);
  }
  return byCode;
}

async function plan() {
  const db = getDb()!;
  const universe = loadUniverse();
  const res = await db.execute(`
    SELECT m.complex_id, m.sido, m.apt_name, m.lawd_cd, m.bjdong_cd, l.source_key, a.matched_jibun
    FROM apt_complex_master m
    JOIN apt_complex_source_links l ON l.complex_id = m.complex_id AND l.source = 'KAPT'
    LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
    WHERE m.jibun IS NULL OR m.jibun = ''`);
  const fills: Fill[] = [];
  const held: Record<string, number> = {};
  const heldSamples: Record<string, unknown[]> = {};
  const hold = (k: string, s: unknown) => {
    held[k] = (held[k] ?? 0) + 1;
    if ((heldSamples[k] ??= []).length < 5) heldSamples[k]!.push(s);
  };
  for (const r of res.rows) {
    const complexId = String(r.complex_id);
    const code = String(r.source_key);
    const rows = universe.get(code);
    if (!rows?.length) {
      hold("NO_KAPT_ROW", { complexId, code });
      continue;
    }
    const lawd = String(r.lawd_cd ?? "");
    const bjd = String(r.bjdong_cd ?? "");
    const lots = new Set<string>();
    let bad = "";
    for (const u of rows) {
      if (u.lawd_cd !== lawd || u.bjdong_code !== bjd) bad = "REGION_MISMATCH";
      const lot = lotFromParcel(u.parcel_address ?? "", u.bjdong_name ?? "");
      if (!lot) bad ||= "LOT_PARSE_FAILED";
      else lots.add(lot);
    }
    if (!bad && lots.size > 1) bad = "DUPLICATE_CODE_LOT_CONFLICT";
    const anchor = String(r.matched_jibun ?? "");
    const anchorLot = /(?:동|리|가)\s+(산\s?)?(\d+(?:-\d+)?)(?:\s|$)/.exec(anchor);
    const anchorJibun = anchorLot ? `${anchorLot[1] ? "산" : ""}${anchorLot[2]}`.replace(/-0$/, "") : null;
    if (!bad && anchor && anchorJibun !== [...lots][0]) bad = "ANCHOR_JIBUN_DIFFERS";
    if (bad) {
      hold(bad, { complexId, code, lawd, bjd, uni: rows.map((u) => [u.lawd_cd, u.bjdong_code, u.parcel_address]), anchor });
      continue;
    }
    fills.push({ complexId, sido: String(r.sido ?? ""), aptName: String(r.apt_name), kaptCode: code, jibun: [...lots][0]!, parcel: rows[0]!.parcel_address, anchorChecked: Boolean(anchor) });
  }
  const bySido = fills.reduce<Record<string, number>>((a, f) => ((a[f.sido] = (a[f.sido] ?? 0) + 1), a), {});
  mkdirSync(OUT, { recursive: true });
  writeFileSync(PLAN, JSON.stringify({ built_at: new Date().toISOString(), fills }));
  writeFileSync(join(OUT, "held-samples.json"), JSON.stringify(heldSamples, null, 1));
  console.log(
    JSON.stringify(
      {
        emptyJibunWithKapt: res.rows.length,
        fill: fills.length,
        mountain: fills.filter((f) => f.jibun.startsWith("산")).length,
        anchorChecked: fills.filter((f) => f.anchorChecked).length,
        bySido,
        held,
        samples: fills.filter((_, i) => i % Math.max(1, Math.floor(fills.length / 8)) === 0).slice(0, 8),
      },
      null,
      1,
    ),
  );
}

async function apply(sidoPrefix: string | null) {
  const db = getDb()!;
  const { fills } = JSON.parse(readFileSync(PLAN, "utf8")) as { fills: Fill[] };
  const scoped = sidoPrefix ? fills.filter((f) => f.sido.startsWith(sidoPrefix)) : fills;
  const now = new Date().toISOString();
  let updated = 0;
  for (let i = 0; i < scoped.length; i += 200) {
    const part = scoped.slice(i, i + 200);
    const out = await db.batch(
      part.map((f) => ({
        sql: `UPDATE apt_complex_master SET jibun = ?, updated_at = ? WHERE complex_id = ? AND (jibun IS NULL OR jibun = '')`,
        args: [f.jibun, now, f.complexId],
      })),
      "write",
    );
    updated += out.reduce((a, r) => a + r.rowsAffected, 0);
  }
  console.log(JSON.stringify({ sido: sidoPrefix ?? "ALL", planned: scoped.length, updated }));
}

const ai = process.argv.indexOf("--sido");
if (process.argv.includes("--apply")) await apply(ai > 0 ? process.argv[ai + 1]! : null);
else await plan();
