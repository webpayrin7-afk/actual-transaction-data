-- 3D 걷기 경로 — 새 테이블만. 요청 때 Overpass를 기다리지 않게 단지별 OSM 보행망 추출본과 기본 경로 결과를 둔다.
-- complex_walk_osm: 단지 중심 ±1.1km Overpass 결과를 걷기에 필요한 태그만 남겨 gzip JSON(BLOB)으로. 원천 © OpenStreetMap contributors (ODbL).
--   format_version 이 바뀌면 다시 받는다. 서버 안에서만 읽고 브라우저에는 보내지 않는다.
-- complex_walk_routes: 기본 출발(단지 가운데 동)·모드별 계산 결과 JSON. algo_version 이 다르면 무시하고 다시 계산한다.
CREATE TABLE IF NOT EXISTS complex_walk_osm (
  complex_id TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL,
  bbox TEXT NOT NULL,
  osm_gz BLOB NOT NULL,
  bytes INTEGER NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS complex_walk_routes (
  complex_id TEXT NOT NULL,
  from_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  algo_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  built_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, from_key, mode)
);
