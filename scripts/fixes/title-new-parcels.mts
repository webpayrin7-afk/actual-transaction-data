/**
 * 지번이 새로 채워진 지방 단지(건물 체크포인트 title_status = NO_PARCEL)의 건축물대장 표제부를 불러 동(건물)을 채운다.
 * fill-master-jibun.mts 다음 단계. 건축HUB(BldRgstHubService/getBrTitleInfo, MOLIT_API_KEY) — K-apt 한도와 무관.
 *
 * 건물 만들기·저장은 건물 토폴로지 작업(C:/dev/ziplab-wt/topology, PR #115, 아직 main 아님)의 코드를 그대로 쓴다:
 *   isMainBuilding(주건축물만) → buildingFromTitleRow → upsertBuildings(빈 칸만·다른 단지 건물 키는 건너뜀) → upsertCheckpoint.
 * 규칙:
 *   ① 필지 = 마스터 lawd_cd + bjdong_cd + jibun (산이면 platGbCd 1).
 *   ② 같은 필지를 가리키는 단지가 둘 이상이면(1단지·2단지가 한 지번 등) 건물을 누구에게 줄지 모르니 보류 — NO_PARCEL 그대로.
 *   ③ 표제부에 공동주택 주건축물이 하나도 없으면 건물은 넣지 않고 체크포인트만 EMPTY/PARTIAL로 남긴다(원래 러너와 같음).
 *
 *   npx tsx scripts/fixes/title-new-parcels.mts                          # 대상 수만 (API·DB 쓰기 없음)
 *   npx tsx scripts/fixes/title-new-parcels.mts --apply --max-api 2500 [--sido 부산]
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDb } from "../../src/lib/db/client";
// 토폴로지 작업트리의 건물 라이브러리 (상대 import만 쓰는 파일들이라 경로로 바로 불러도 된다)
const TOPO = "C:/dev/ziplab-wt/topology/src/lib/buildings";
const lib = async (name: string) => import(pathToFileURL(`${TOPO}/${name}.ts`).href);
const { hubPnu, parcelFromParts, parcelKey, priorityForSido } = await lib("parcel");
const { fetchTitleParcel } = await lib("title-client");
const { buildingFromTitleRow } = await lib("from-title");
const { isMainBuilding } = await lib("residential");
const { upsertBuildings, upsertCheckpoint } = await lib("repository");

type TitleRow = Record<string, unknown>;
type Building = { officialBuildingKey: string; residentialFlag: boolean };

const OUT = "C:/data/fixes/master-jibun-2026-09-26";
const LOG = join(OUT, "title-new-parcels.jsonl");
const APPLY = process.argv.includes("--apply");
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const MAX_API = Number(arg("--max-api") ?? 2500);
const SIDO = arg("--sido") ?? null;

type Target = { complexId: string; sido: string; sidoCode: string; aptName: string; lawd: string; bjdong: string; jibun: string };

async function targets(): Promise<{ ready: Target[]; shared: Target[] }> {
  const db = getDb()!;
  const res = await db.execute(`
    SELECT m.complex_id, m.sido, m.sido_code, m.apt_name, m.lawd_cd, m.bjdong_cd, m.jibun
    FROM complex_building_checkpoint c
    JOIN apt_complex_master m ON m.complex_id = c.complex_id
    WHERE c.title_status = 'NO_PARCEL' AND m.jibun IS NOT NULL AND m.jibun <> ''`);
  const all = res.rows.map((r) => ({
    complexId: String(r.complex_id),
    sido: String(r.sido ?? ""),
    sidoCode: String(r.sido_code ?? ""),
    aptName: String(r.apt_name ?? ""),
    lawd: String(r.lawd_cd ?? ""),
    bjdong: String(r.bjdong_cd ?? ""),
    jibun: String(r.jibun ?? ""),
  }));
  // 같은 필지를 가진 단지 — 전국 마스터 전체에서 센다 (이미 지번 있던 서울·경기 단지와 겹칠 수도 있다)
  const dup = await db.execute(`
    SELECT lawd_cd || '|' || bjdong_cd || '|' || jibun AS k FROM apt_complex_master
    WHERE jibun IS NOT NULL AND jibun <> '' GROUP BY lawd_cd, bjdong_cd, jibun HAVING count(*) > 1`);
  const sharedKeys = new Set(dup.rows.map((r) => String(r.k)));
  const isShared = (t: Target) => sharedKeys.has(`${t.lawd}|${t.bjdong}|${t.jibun}`);
  const scoped = SIDO ? all.filter((t) => t.sido.startsWith(SIDO)) : all;
  return { ready: scoped.filter((t) => !isShared(t)), shared: scoped.filter(isShared) };
}

async function run() {
  const { ready, shared } = await targets();
  const bySido = ready.reduce<Record<string, number>>((a, t) => ((a[t.sido] = (a[t.sido] ?? 0) + 1), a), {});
  console.log(JSON.stringify({ ready: ready.length, sharedParcelHeld: shared.length, bySido }));
  if (!APPLY) return;
  mkdirSync(OUT, { recursive: true });
  const db = getDb()!;
  const tot = { apiCalls: 0, done: 0, success: 0, empty: 0, residentialComplexes: 0, buildingsInserted: 0, skippedPositive: 0, errors: 0 };
  let i = 0;
  let stop = "";
  const worker = async () => {
    while (i < ready.length && !stop) {
      if (tot.apiCalls >= MAX_API) {
        stop = "MAX_API";
        break;
      }
      const t = ready[i++]!;
      const parcel = parcelFromParts(t.lawd, t.bjdong, t.jibun);
      if (!parcel) continue;
      try {
        const title = await fetchTitleParcel(parcel);
        tot.apiCalls += title.apiCalls;
        const main = (title.items as TitleRow[]).filter(isMainBuilding);
        const unique = new Map<string, Building>();
        for (const row of main) {
          const b = buildingFromTitleRow(row, t.complexId, title.sourceAsOf) as Building | null;
          if (b && !unique.has(b.officialBuildingKey)) unique.set(b.officialBuildingKey, b);
        }
        const deduped = [...unique.values()];
        const residential = deduped.filter((b) => b.residentialFlag);
        const stats = await upsertBuildings(db, deduped);
        await upsertCheckpoint(db, {
          complexId: t.complexId,
          parcelKey: parcelKey(parcel),
          pnu: hubPnu(parcel),
          priority: priorityForSido(t.sidoCode),
          titleStatus: deduped.length ? (title.fromCache ? "SKIP_CACHED" : "SUCCESS") : "EMPTY",
          buildingStatus: residential.length ? "EXACT" : deduped.length ? "PARTIAL" : "NO_SOURCE",
          geometryStatus: "NO_GEOMETRY",
          linkStatus: "NO_SOURCE",
          titleTotalCount: title.totalCount,
          residentialCount: residential.length,
          apiCalls: title.apiCalls,
          detail: `main=${main.length} residential=${residential.length} unique=${deduped.length} jibun_fill=kapt_parcel_2026_09`,
        });
        tot.done++;
        if (deduped.length) tot.success++;
        else tot.empty++;
        if (residential.length) tot.residentialComplexes++;
        tot.buildingsInserted += stats.inserted;
        tot.skippedPositive += stats.skippedPositive;
        appendFileSync(LOG, JSON.stringify({ ...t, pnu: hubPnu(parcel), main: main.length, residential: residential.length, ...stats }) + "\n");
      } catch (e) {
        tot.errors++;
        const msg = e instanceof Error ? e.message : String(e);
        appendFileSync(LOG, JSON.stringify({ ...t, error: msg.slice(0, 160) }) + "\n");
        // 한도 초과·키 오류면 바로 멈춘다 (계속 두드리지 않게)
        if (/title API (22|30|31)\b|LIMITED|EXCEEDS|SERVICE_KEY/i.test(msg) || tot.errors > 20) stop = `API_ERROR ${msg.slice(0, 80)}`;
      }
      if (tot.done % 200 === 0 && tot.done) console.log(JSON.stringify(tot));
    }
  };
  await Promise.all([worker(), worker()]);
  console.log(JSON.stringify({ ...tot, stop: stop || null, remaining: ready.length - i }));
}

await run();
