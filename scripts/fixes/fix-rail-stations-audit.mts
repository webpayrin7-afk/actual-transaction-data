/**
 * 전국 도시철도 역 좌표 전수조사(2026-09-26) 정정 — rail_stations 중 좌표가 다른 역 자리에 찍힌 행.
 * 두 가지 이상 서로 다른 근거가 맞아떨어진 것만 넣었다 (근거는 각 항목 evidence).
 * 수정 전 값은 data/fixes/rail-stations-audit-before.json 에 남긴다.
 *
 *   npx tsx scripts/fixes/fix-rail-stations-audit.mts           # dry-run (기본)
 *   npx tsx scripts/fixes/fix-rail-stations-audit.mts --apply   # 적용 — 다시 돌리면 0건
 *
 * UPDATE 는 station_key + 이름 + 노선 + 지금 좌표가 조사 때 값과 같을 때만 바뀐다(가드).
 * 이촌(4호선)은 scripts/fixes/fix-rail-ichon.mts 와 같은 정정 — 어느 쪽을 먼저 돌려도 다른 쪽은 0건.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";

config({ path: ".env.local", quiet: true });
const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const apply = process.argv.includes("--apply");

type Fix = {
  stationKey: string;
  name: string;
  lineName: string;
  /** 조사 때 값 — 지금 값이 이것과 같아야 바꾼다 */
  oldLat: number;
  oldLng: number;
  newLat: number;
  newLng: number;
  evidence: string[];
};

const FIXES: Fix[] = [
  {
    stationKey: "0430|I1104|4호선",
    name: "이촌(국립중앙박물관)",
    lineName: "4호선",
    oldLat: 37.52919,
    oldLng: 126.9679818,
    // 같은 역 경원선(경의중앙선) 이촌역 행 좌표
    newLat: 37.522476,
    newLng: 126.973816,
    evidence: [
      "지금 좌표는 신용산(4호선) 행에서 14m — 신용산 자리",
      "같은 역 경원선 '이촌역' 행 좌표 = 제안값",
      "도로명주소(서빙고로 지하83) NAVER 지오코딩 37.522520,126.973683 — 제안값에서 13m",
      "서울교통공사 1-8호선 역사 좌표 CSV 37.522525,126.97335 — 제안값에서 41m",
    ],
  },
  {
    stationKey: "0514|S1105|5호선",
    name: "마곡",
    lineName: "5호선",
    oldLat: 37.55865,
    oldLng: 126.837693,
    // 도로명주소 NAVER 지오코딩
    newLat: 37.5601985,
    newLng: 126.825548,
    evidence: [
      "지금 좌표는 발산(5호선) 행에서 7m — 발산 자리",
      "도로명주소(공항대로 지하163) NAVER 지오코딩 = 제안값",
      "서울교통공사 역주소 CSV 지번(마곡동 769-3) VWorld 지오코딩 37.560301,126.824815 — 제안값에서 66m",
      "서울교통공사 1-8호선 역사 좌표 CSV 37.562182,126.82693 — 제안값에서 252m (그 CSV도 마곡·발산 좌표가 같아 참고만)",
    ],
  },
  {
    stationKey: "1204|I4108|경의중앙선",
    name: "양원역",
    lineName: "경의중앙선",
    oldLat: 36.963729,
    oldLng: 129.091321,
    // 도로명주소 지오코딩 (NAVER·VWorld 같은 값)
    newLat: 37.6065532,
    newLng: 127.1079177,
    evidence: [
      "지금 좌표는 경북 봉화(영동선 양원역) — 서울 중랑구 역에서 약 190km",
      "도로명주소(서울 중랑구 송림길 147) NAVER 지오코딩 37.6065532,127.1079178",
      "같은 주소 VWorld 지오코딩 37.6065532,127.1079177 (두 지오코더 일치)",
      "제안값은 같은 노선 이웃 역 망우(1.6km)·구리(3.1km) 사이",
    ],
  },
];

const eq = (a: unknown, b: number) => Math.abs(Number(a) - b) < 1e-9;

const rows = (
  await db.execute({
    sql: `SELECT station_key, name, line_name, lat, lng FROM rail_stations WHERE station_key IN (${FIXES.map(() => "?").join(",")})`,
    args: FIXES.map((f) => f.stationKey),
  })
).rows;

const todo: Array<{ fix: Fix; before: Record<string, unknown> }> = [];
for (const f of FIXES) {
  const r = rows.find((x) => x.station_key === f.stationKey);
  const tag = `${f.name} (${f.lineName})`;
  if (!r || r.name !== f.name || r.line_name !== f.lineName) {
    console.log(`건너뜀 ${tag}: 행이 없거나 이름·노선이 다름`);
    continue;
  }
  if (eq(r.lat, f.newLat) && eq(r.lng, f.newLng)) {
    console.log(`이미 정정됨 ${tag}`);
    continue;
  }
  if (!eq(r.lat, f.oldLat) || !eq(r.lng, f.oldLng)) {
    console.log(`건너뜀 ${tag}: 지금 좌표 ${r.lat},${r.lng} 가 조사 때 값과 다름 — 사람이 확인`);
    continue;
  }
  console.log(`${tag}  ${f.oldLat},${f.oldLng} → ${f.newLat},${f.newLng}`);
  for (const e of f.evidence) console.log(`    - ${e}`);
  todo.push({ fix: f, before: { ...r } });
}

if (todo.length === 0) {
  console.log("바꿀 행 0건");
  process.exit(0);
}
if (!apply) {
  console.log(`dry-run: ${todo.length}건 바뀔 예정 (--apply 로 적용)`);
  process.exit(0);
}

mkdirSync("data/fixes", { recursive: true });
writeFileSync(
  "data/fixes/rail-stations-audit-before.json",
  JSON.stringify(
    { at: new Date().toISOString(), rows: todo.map((t) => ({ before: t.before, after: { lat: t.fix.newLat, lng: t.fix.newLng }, evidence: t.fix.evidence })) },
    null,
    2,
  ),
);
const res = await db.batch(
  todo.map(({ fix: f }) => ({
    sql: `UPDATE rail_stations SET lat = ?, lng = ?
            WHERE station_key = ? AND name = ? AND line_name = ? AND lat = ? AND lng = ?`,
    args: [f.newLat, f.newLng, f.stationKey, f.name, f.lineName, f.oldLat, f.oldLng],
  })),
  "write",
);
const n = res.reduce((s, r) => s + r.rowsAffected, 0);
console.log(`적용: ${n}건 / ${todo.length}건 (수정 전 값: data/fixes/rail-stations-audit-before.json)`);
