/**
 * rail_stations 빠진 역 채우기 (2026-09-26) — 전국도시철도역사정보표준데이터(공공데이터포털)에 아예 없는 행.
 *   - GTX-A 전 역 (지금 운행: 운정중앙~서울역, 수서~동탄. 창릉·삼성은 아직 서지 않아 뺐다)
 *   - 2호선(신정지선) 까치산 — 5호선 까치산 행이 2호선 환승이라 적어 두었는데 2호선 행이 없음
 *   - 수인분당선 청량리 — 2020-09 왕십리→청량리 연장, 원천 분당선 행은 왕십리에서 끝남
 *
 * 값은 다른 공식 원천에서 가져왔다 (행마다 source·evidence):
 *   A. 철도데이터포털(KRIC, data.kric.go.kr) "전국 도시광역철도 역사정보" id=1294, 파일 20260701
 *      https://data.kric.go.kr/rips/M_01_01/detail.do?id=1294
 *      — GTX-A 운정중앙·킨텍스·대곡·연신내·서울역 행과 2호선 까치산 행은 경도·위도 칸이 뒤바뀌어 있어 바로잡아 넣었다.
 *   B. 공공데이터포털 "한국철도공사_역 위치 정보_20240401" (data.go.kr 15127532) — 청량리
 * 좌표마다 도로명·지번 주소 지오코딩(NAVER·VWorld)과 같은 이름 기존 행(400m 안이면 한 역으로 묶임)으로 맞춰 봤다.
 *
 *   npx tsx scripts/fixes/fill-rail-stations-missing.mts           # dry-run (기본)
 *   npx tsx scripts/fixes/fill-rail-stations-missing.mts --apply   # 넣기 — 다시 돌리면 0건
 *
 * station_key 가 없는 행만 넣는다 (INSERT … ON CONFLICT DO NOTHING). 기존 행은 바꾸거나 지우지 않는다.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const apply = process.argv.includes("--apply");

const SRC_KRIC = "철도데이터포털(KRIC) 전국 도시광역철도 역사정보 id=1294 (2026-07-01)";
const SRC_KORAIL_LOC = "공공데이터포털 한국철도공사_역 위치 정보 15127532 (2024-04-01)";

type Row = {
  station_key: string;
  station_no: string;
  name: string;
  line_no: string;
  line_name: string;
  transfer_type: string;
  transfer_lines: string | null;
  lat: number;
  lng: number;
  operator: string;
  road_address: string | null;
  base_date: string;
  source: string;
  /** 같은 이름 기존 행과 한 역으로 묶여야 하면 true (400m 안이 아니면 넣지 않는다) */
  expectMerge: boolean;
  evidence: string[];
};

// GTX-A: 원천에 노선번호가 없어 line_no 는 "GTXA" 로 둔다. line_name "GTX-A" 는 railLineLabel 에서 그대로, 색은 subwayLineColor("GTX").
const gtx = (r: Omit<Row, "line_no" | "line_name" | "source" | "station_key">): Row => ({
  ...r,
  station_key: `${r.station_no}|GTXA|GTX-A`,
  line_no: "GTXA",
  line_name: "GTX-A",
  source: SRC_KRIC,
});

const ROWS: Row[] = [
  gtx({
    station_no: "X101",
    name: "운정중앙",
    transfer_type: "일반역",
    transfer_lines: null,
    lat: 37.716044,
    lng: 126.728133,
    operator: "지티엑스에이운영",
    road_address: null,
    base_date: "2026-07-01",
    expectMerge: false,
    evidence: [
      "KRIC 경도칸 37.716044·위도칸 126.728133 (뒤바뀜) 신설 20241228",
      "지번 파주시 동패동 409-1 VWorld 37.716461,126.728383 — 51m",
      "NAVER 지오코딩 같은 지번 → '운정중앙로 60 운정중앙역' 37.716513,126.728339 — 55m",
    ],
  }),
  gtx({
    station_no: "X102",
    name: "킨텍스",
    transfer_type: "일반역",
    transfer_lines: null,
    lat: 37.66528,
    lng: 126.748166,
    operator: "지티엑스에이운영",
    road_address: null,
    base_date: "2026-07-01",
    expectMerge: false,
    evidence: [
      "KRIC 경도칸 37.66528·위도칸 126.748166 (뒤바뀜) 신설 20241228",
      "VWorld 장소 '킨텍스역5번출구' 58m, '킨텍스역2번출구' 78m, '킨텍스역1번출구' 80m (버스정류장)",
    ],
  }),
  gtx({
    station_no: "X103",
    name: "대곡",
    transfer_type: "환승역",
    transfer_lines: "3호선,서해선,경의중앙",
    lat: 37.63237,
    lng: 126.81043,
    operator: "지티엑스에이운영",
    road_address: "경기도 고양시 대주로 107번길 71-81",
    base_date: "2026-07-01",
    expectMerge: true,
    evidence: [
      "KRIC 경도칸 37.63237·위도칸 126.81043 (뒤바뀜) 신설 20241228",
      "도로명 대주로107번길 71-81 NAVER 63m · VWorld 63m",
      "VWorld 장소 '대곡역'(지하철역) 84m",
    ],
  }),
  gtx({
    station_no: "X105",
    name: "연신내",
    transfer_type: "환승역",
    transfer_lines: "3호선,6호선",
    lat: 37.618855,
    lng: 126.920859,
    operator: "지티엑스에이운영",
    road_address: "서울특별시 은평구 통일로 지하849(갈현동)",
    base_date: "2026-07-01",
    expectMerge: true,
    evidence: [
      "KRIC 경도칸 37.618855·위도칸 126.920859 (뒤바뀜) 신설 20241228",
      "지번 갈현동 397 VWorld 16m",
      "VWorld 장소 '연신내역'(지하철역) 29m",
    ],
  }),
  gtx({
    station_no: "X106",
    name: "서울역",
    transfer_type: "환승역",
    transfer_lines: "1호선,4호선",
    lat: 37.55585,
    lng: 126.9726803,
    operator: "지티엑스에이운영",
    road_address: "서울시 중구 통일로 1",
    base_date: "2026-07-01",
    expectMerge: true,
    evidence: [
      "KRIC 경도칸 37.55585·위도칸 126.9726803 (뒤바뀜) 신설 20241228",
      "도로명 통일로 1 NAVER 95m · VWorld 98m, 지번 봉래동2가 122-28 VWorld 100m",
    ],
  }),
  gtx({
    station_no: "X108",
    name: "수서역",
    transfer_type: "환승역",
    transfer_lines: "3호선",
    lat: 37.486944,
    lng: 127.101944,
    operator: "지티엑스에이운영",
    road_address: "서울 강남구 광평로 지하270",
    base_date: "2024-04-12",
    expectMerge: true,
    evidence: [
      "KRIC 위도 37.486944·경도 127.101944 신설 20240329",
      "VWorld 장소 '수서역'(지하철역, 광평로 270) 44m",
      "지번 수서동 728 VWorld 207m (필지 넓음)",
    ],
  }),
  gtx({
    station_no: "X109",
    name: "성남역",
    transfer_type: "환승역",
    transfer_lines: "경강선",
    lat: 37.394192,
    lng: 127.120544,
    operator: "지티엑스에이운영",
    road_address: null,
    base_date: "2024-04-12",
    expectMerge: true,
    evidence: [
      "KRIC 위도 37.394192·경도 127.120544 신설 20240329 (도로명 칸에 지번 '이매동 153-1'만 있어 주소는 비움)",
      "지번 이매동 153-1 VWorld 60m",
      "VWorld 장소 '성남역'(지하철역) 112m",
    ],
  }),
  gtx({
    station_no: "X110",
    name: "구성역",
    transfer_type: "환승역",
    transfer_lines: "수인분당선",
    lat: 37.298611,
    lng: 127.105556,
    operator: "지티엑스에이운영",
    road_address: "경기도 용인시 기흥구 용구대로 2403",
    base_date: "2024-07-15",
    expectMerge: true,
    evidence: [
      "KRIC 위도 37.298611·경도 127.105556 신설 20240629",
      "도로명 용구대로 2403 NAVER 35m · VWorld 35m, 지번 마북동 460-3 VWorld 36m",
    ],
  }),
  gtx({
    station_no: "X111",
    name: "동탄역",
    transfer_type: "일반역",
    transfer_lines: null,
    lat: 37.200067,
    lng: 127.095737,
    operator: "㈜SR",
    road_address: "경기도 화성시 동탄역로 지하 151(오산동, 동탄역사)",
    base_date: "2024-04-12",
    expectMerge: false,
    evidence: [
      "KRIC 위도 37.200067·경도 127.095737 (운영 ㈜SR, 신설 20161115)",
      "도로명 동탄역로 151 NAVER 32m · VWorld 32m",
      "VWorld 장소 '동탄역(동측)' 54m",
    ],
  }),
  {
    // 신정지선 기존 행 2341 도림천·2342 양천구청·2343 신정네거리 (S1122) 다음 번호
    station_key: "2344|S1122|2호선",
    station_no: "2344",
    name: "까치산",
    line_no: "S1122",
    line_name: "2호선",
    transfer_type: "환승역",
    transfer_lines: "5호선",
    lat: 37.53142,
    lng: 126.84694,
    operator: "서울교통공사",
    road_address: "서울특별시 강서구 강서로 지하54",
    base_date: "2026-07-01",
    source: SRC_KRIC,
    expectMerge: true,
    evidence: [
      "KRIC 2호선 234-4 까치산 (칸이 한 칸 밀려 위도 37.53142·경도 126.84694)",
      "서울교통공사 1-8호선 역사 좌표 CSV(20250814) 2호선 까치산 37.53181,126.846706 — 48m",
      "VWorld 장소 '까치산역'(지하철역) 60m",
    ],
  },
  {
    // 기존 코레일 행은 청량리를 역코드 1014 로 쓴다 (1014|I4102|경원선, 1014|I4108|경의중앙선). 분당선은 I4105.
    station_key: "1014|I4105|분당선",
    station_no: "1014",
    name: "청량리역",
    line_no: "I4105",
    line_name: "분당선",
    transfer_type: "환승역",
    transfer_lines: "1호선, 경의중앙선, 경춘선",
    lat: 37.580543,
    lng: 127.047259,
    operator: "한국철도공사",
    road_address: "서울특별시 동대문구 왕산로 214",
    base_date: "2024-04-01",
    source: SRC_KORAIL_LOC,
    expectMerge: true,
    evidence: [
      "한국철도공사 역 위치 정보 '청량리' 37.580543,127.047259",
      "KRIC 코레일 청량리역(K209) 37.580543,127.046516 — 65m",
      "지번 전농동 588-1 VWorld 91m, 도로명 왕산로 214 NAVER 139m",
    ],
  },
];

const R = 6_371_000;
function meters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
const baseName = (n: string) => n.trim().replace(/\(.*?\)/g, "").replace(/\s+/g, "").replace(/역$/u, "");

const existingKeys = new Set(
  (
    await db.execute({
      sql: `SELECT station_key FROM rail_stations WHERE station_key IN (${ROWS.map(() => "?").join(",")})`,
      args: ROWS.map((r) => r.station_key),
    })
  ).rows.map((r) => String(r.station_key)),
);

const todo: Row[] = [];
for (const r of ROWS) {
  const tag = `${r.name} (${r.line_name}) ${r.station_key}`;
  if (existingKeys.has(r.station_key)) {
    console.log(`이미 있음 ${tag}`);
    continue;
  }
  // 같은 이름 기존 행 (반경 2km 사각형)
  const near = (
    await db.execute({
      sql: `SELECT station_key, name, line_name, lat, lng FROM rail_stations
              WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
      args: [r.lat - 0.02, r.lat + 0.02, r.lng - 0.025, r.lng + 0.025],
    })
  ).rows
    .filter((x) => baseName(String(x.name)) === baseName(r.name))
    .map((x) => ({ key: String(x.station_key), line: String(x.line_name), d: meters(r.lat, r.lng, Number(x.lat), Number(x.lng)) }))
    .sort((a, b) => a.d - b.d);
  const nearest = near[0];
  if (r.expectMerge && (!nearest || nearest.d > 400)) {
    console.log(`건너뜀 ${tag}: 같은 이름 기존 행이 400m 안에 없음 — 사람이 확인`);
    continue;
  }
  if (!r.expectMerge && nearest && nearest.d <= 400) {
    console.log(`건너뜀 ${tag}: 같은 이름 행 ${nearest.key} 가 ${nearest.d}m — 예상과 다름, 사람이 확인`);
    continue;
  }
  console.log(`${tag}  ${r.lat},${r.lng}`);
  console.log(`    같은 이름 기존 행: ${near.length ? near.map((x) => `${x.line} ${x.d}m`).join(", ") : "없음"}`);
  for (const e of r.evidence) console.log(`    - ${e}`);
  todo.push(r);
}

if (todo.length === 0) {
  console.log("넣을 행 0건");
  process.exit(0);
}
if (!apply) {
  console.log(`dry-run: ${todo.length}건 넣을 예정 (--apply 로 적용)`);
  process.exit(0);
}

const loadedAt = new Date().toISOString();
const res = await db.batch(
  todo.map((r) => ({
    sql: `INSERT INTO rail_stations
            (station_key, station_no, name, line_no, line_name, transfer_type, transfer_lines,
             lat, lng, operator, road_address, base_date, source, loaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(station_key) DO NOTHING`,
    args: [
      r.station_key,
      r.station_no,
      r.name,
      r.line_no,
      r.line_name,
      r.transfer_type,
      r.transfer_lines,
      r.lat,
      r.lng,
      r.operator,
      r.road_address,
      r.base_date,
      r.source,
      loadedAt,
    ],
  })),
  "write",
);
const n = res.reduce((s, x) => s + x.rowsAffected, 0);
console.log(`적용: ${n}건 / ${todo.length}건`);
