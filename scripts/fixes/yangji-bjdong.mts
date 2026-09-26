/**
 * 용인 처인구 양지(41461) 단지의 법정동 뒷자리(bjdong_cd) 바로잡기.
 * 양지면이 양지읍이 되면서 양지리 36021→26221, 남곡리 36022→26222로 코드가 바뀌었는데
 * 단지 마스터는 옛 코드로 남아 건축물대장 조회가 비었다(옛 코드로 물으면 0건).
 *
 * 규칙 (추정·이름 유사 매칭 없음): 단지마다 지번(본번·부번)은 그대로 두고 법정동만 새 코드로 바꿨을 때
 *   ① GIS 건물(gis_buildings)에 그 필지의 공동주택이 있거나, ② 건축물대장 표제부가 그 필지에서 공동주택을 돌려줄 때만 바꾼다.
 *   둘 다 없으면 보류.
 *
 *   npx tsx scripts/fixes/yangji-bjdong.mts            # 계획만: 확인 결과·백업 파일 (DB 쓰기 없음)
 *   npx tsx scripts/fixes/yangji-bjdong.mts --apply    # 계획 파일대로 고친다 (행마다 옛 값 조건을 걸어서)
 *
 * --apply가 고치는 표는 bjdong-remap.mts와 같다: apt_complex_master, complex_building_checkpoint(PENDING으로 되돌려 다시 조회),
 *   apt_supply_identity_residual, apt_unit_acquisition_manifest.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";

const OUT = "C:/data/fixes/yangji-bjdong-2026-09-25";
const LAWD = "41461";
const MAP: Record<string, string> = { "36021": "26221", "36022": "26222" };

type Fix = { complex_id: string; apt_name: string; bjdong_cd: string; new_bjdong: string; pnu: string; basis: string };

async function titleApts(bjdong: string, bun: string, ji: string, plat: string): Promise<string[] | null> {
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) return null;
  const qs = new URLSearchParams({
    serviceKey: key,
    sigunguCd: LAWD,
    bjdongCd: bjdong,
    platGbCd: plat,
    bun,
    ji,
    numOfRows: "100",
    pageNo: "1",
    _type: "json",
  });
  // 게이트웨이가 가끔 빈 본문이나 빈 목록을 돌려줘서, 공동주택이 나올 때까지 몇 번 다시 묻는다
  let answered = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(`https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?${qs}`);
      const j = JSON.parse(await res.text());
      answered = true;
      const it = j.response?.body?.items?.item;
      const items: Array<Record<string, unknown>> = Array.isArray(it) ? it : it ? [it] : [];
      const apts = [
        ...new Set(items.filter((i) => String(i.mainPurpsCdNm ?? "").includes("공동주택")).map((i) => String(i.bldNm ?? ""))),
      ];
      if (apts.length) return apts;
    } catch {
      /* 다시 */
    }
  }
  return answered ? [] : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  mkdirSync(OUT, { recursive: true });
  const planPath = join(OUT, "mapping.json");

  if (apply) {
    if (!existsSync(planPath)) throw new Error("먼저 --apply 없이 돌려 계획 파일을 만드세요.");
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as { fixes: Fix[] };
    const now = new Date().toISOString();
    const stmts = plan.fixes.flatMap((f) => {
      const oldPrefix = `${LAWD}${f.bjdong_cd}`;
      const newPrefix = `${LAWD}${f.new_bjdong}`;
      return [
        {
          sql: `UPDATE apt_complex_master SET bjdong_cd = ? WHERE complex_id = ? AND lawd_cd = ? AND bjdong_cd = ?`,
          args: [f.new_bjdong, f.complex_id, LAWD, f.bjdong_cd],
        },
        {
          sql: `UPDATE complex_building_checkpoint
                SET parcel_key = replace(parcel_key, ?, ?), pnu = ? || substr(pnu, 11),
                    title_status = 'PENDING', building_status = 'PENDING', geometry_status = 'PENDING',
                    link_status = 'PENDING', detail = 'yangji bjdong 2026-09-25', updated_at = ?
                WHERE complex_id = ? AND substr(pnu, 1, 10) = ?`,
          args: [`${LAWD}|${f.bjdong_cd}|`, `${LAWD}|${f.new_bjdong}|`, newPrefix, now, f.complex_id, oldPrefix],
        },
        {
          sql: `UPDATE apt_supply_identity_residual
                SET bjdong_cd = ?, pnu = CASE WHEN substr(pnu, 1, 10) = ? THEN ? || substr(pnu, 11) ELSE pnu END
                WHERE complex_id = ? AND bjdong_cd = ?`,
          args: [f.new_bjdong, oldPrefix, newPrefix, f.complex_id, f.bjdong_cd],
        },
        {
          sql: `UPDATE apt_unit_acquisition_manifest SET bjdong_cd = ? WHERE complex_id = ? AND bjdong_cd = ?`,
          args: [f.new_bjdong, f.complex_id, f.bjdong_cd],
        },
      ];
    });
    const res = await db.batch(stmts, "write");
    const sum = [0, 0, 0, 0];
    res.forEach((r, i) => (sum[i % 4] += r.rowsAffected));
    console.log(
      JSON.stringify(
        { mode: "apply", planned: plan.fixes.length, master: sum[0], checkpoint: sum[1], residual: sum[2], manifest: sum[3] },
        null,
        2,
      ),
    );
    return;
  }

  const res = await db.execute({
    sql: `SELECT m.complex_id, m.apt_name, m.bjdong_cd, c.pnu
          FROM apt_complex_master m LEFT JOIN complex_building_checkpoint c USING (complex_id)
          WHERE m.lawd_cd = ? AND m.bjdong_cd IN (${Object.keys(MAP).map(() => "?").join(",")})`,
    args: [LAWD, ...Object.keys(MAP)],
  });
  const fixes: Fix[] = [];
  const held: Array<{ complex_id: string; apt_name: string; reason: string }> = [];
  for (const r of res.rows) {
    const complex_id = String(r.complex_id);
    const apt_name = String(r.apt_name);
    const bjdong_cd = String(r.bjdong_cd);
    const pnu = String(r.pnu ?? "");
    const new_bjdong = MAP[bjdong_cd]!;
    if (pnu.length !== 19) {
      held.push({ complex_id, apt_name, reason: "필지(pnu) 없음" });
      continue;
    }
    // 체크포인트 pnu 11번째 자리는 건축물대장 대지구분(0 대지, 1 산), GIS pnu는 토지 구분(1 일반, 2 산)
    const plat = pnu[10]!;
    const bun = pnu.slice(11, 15);
    const ji = pnu.slice(15, 19);
    const gisPnu = `${LAWD}${new_bjdong}${plat === "1" ? "2" : "1"}${bun}${ji}`;
    const g = await db.execute({
      sql: `SELECT group_concat(DISTINCT name) names, count(*) n FROM gis_buildings WHERE pnu = ? AND use_code = '02000'`,
      args: [gisPnu],
    });
    if (Number(g.rows[0]!.n) > 0) {
      fixes.push({ complex_id, apt_name, bjdong_cd, new_bjdong, pnu, basis: `GIS ${gisPnu} 공동주택 ${g.rows[0]!.names ?? ""}` });
      continue;
    }
    const apts = await titleApts(new_bjdong, bun, ji, plat);
    if (apts?.length) {
      fixes.push({ complex_id, apt_name, bjdong_cd, new_bjdong, pnu, basis: `건축물대장 ${new_bjdong} ${bun}-${ji} 공동주택 ${apts.join("/")}` });
    } else {
      held.push({ complex_id, apt_name, reason: apts ? "새 코드 필지에 공동주택 없음" : "건축물대장 응답 없음" });
    }
  }

  const ids = fixes.map((f) => f.complex_id);
  const backup: Record<string, unknown[]> = {};
  for (const t of ["apt_complex_master", "complex_building_checkpoint", "apt_supply_identity_residual", "apt_unit_acquisition_manifest"]) {
    backup[t] = ids.length
      ? (
          await db.execute({ sql: `SELECT * FROM ${t} WHERE complex_id IN (${ids.map(() => "?").join(",")})`, args: ids })
        ).rows.map((x) => ({ ...x }))
      : [];
  }
  if (fixes.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(OUT, `backup-${stamp}.json`), JSON.stringify(backup));
    writeFileSync(planPath, JSON.stringify({ built_at: new Date().toISOString(), fixes, held }, null, 1));
  }
  console.log(
    JSON.stringify(
      {
        mode: "plan",
        complexes: res.rows.length,
        fix: fixes.length,
        held: held.length,
        backup_rows: Object.fromEntries(Object.entries(backup).map(([k, v]) => [k, v.length])),
        fixes: fixes.map((f) => `${f.apt_name} ${f.bjdong_cd}→${f.new_bjdong} (${f.basis})`),
        held_list: held.map((h) => `${h.apt_name}: ${h.reason}`),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
