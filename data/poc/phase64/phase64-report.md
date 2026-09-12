## Phase 6.4 — Public GIS GEO bootstrap proof

### dataset
source: 국토교통부 GIS건물통합정보 (data.go.kr 15083092 → VWorld dsId=18)
version/date: 20260809
license: 공공누리 제1유형 (출처표시)
original CRS: EPSG:5179 (typical; read from .prj when present)
acquisition: BLOCKED_VWORLD_502

### parcel key
READY: 14966
AMBIGUOUS: 0
INVALID: 0

### sample
sample: 200
EXACT-PARCEL: 0
MULTI-BUILDING: 0
NO-MATCH: 0
AMBIGUOUS: 0
sanity failures: {}

### full local dry-run
eligible: 14966
matched: 0
unmatched: 14966
ambiguous: 0
coverage %: 0.0

### GEO method
representative point: largest-ring centroid if on-surface, else ring vertex0
output CRS: EPSG:4326

### provenance
master coordinates: apt_complex_master.latitude/longitude
source link: source=MOLIT_GIS_BUILDING, source_key=PNU
enrichment state: domain=GEO, data_version=1 (lazy rows only on write)

### expected production mutations
master coordinate updates: 0
source-link inserts: 0
GEO state inserts: 0
total: 0

### fallback requirement
VWorld candidates: 14966

### production writes
0

### decision
HOLD

### next
Acquire MOLIT GIS건물통합정보 SHP (Seoul+Gyeonggi) into data/cache/gis-building/ (VWorld dsId=18 currently 502), then re-run this proof
