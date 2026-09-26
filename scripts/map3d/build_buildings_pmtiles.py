"""
서울 3D 지도 건물 타일 — 국토교통부 GIS건물통합정보(AL_D010, SHP, EPSG:5186) → PMTiles(벡터 타일 MVT). DB 쓰기 없음.

  python scripts/map3d/build_buildings_pmtiles.py C:/data/gis/AL_D010_11_20260909.zip public/map3d/seoul-buildings.pmtiles

왜 이렇게:
- gis_buildings(DB)는 단지 주변 400m만 적재돼 서울 전체가 아니다 → 원천 SHP(서울 11 파일)를 직접 쓴다.
- tippecanoe가 Windows에 없어 파이썬(pyshp·pyproj·shapely, 기존 build-gis-buildings.py와 같은 도구)으로
  타일을 자르고, MVT 인코딩과 PMTiles v3 쓰기는 이 파일 안에 직접 구현했다 (외부 패키지 추가 없음).
- 속성은 화면에 필요한 것만: h(높이 m, 정수), a(공동주택=1). 이름·지번·용도명 등은 싣지 않는다.
- 줌: 12(40m 이상 고층만) · 13(15m 이상 또는 바닥 1,500㎡ 이상) · 14 · 15(전부). 16 이상은 지도에서 15를 확대해 쓴다.
- 높이: A16 높이 > 0 이면 그대로, 없으면 지상층수×3.3m, 둘 다 없으면 3.5m.
- 결과 하나(.pmtiles)를 Vercel Blob(또는 public/)에 올리면 브라우저가 HTTP Range로 필요한 타일만 읽는다.
"""
import gzip
import hashlib
import io
import json
import math
import shutil
import struct
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np
import shapefile
import shapely
from pyproj import Transformer

args = sys.argv[1:]
if len(args) < 2:
    raise SystemExit(__doc__)
SRC = Path(args[0])
OUT = Path(args[1])
LIMIT = int(args[args.index("--limit") + 1]) if "--limit" in args else 0  # 시험용: 앞 N건만
# 도로명주소 건물(DB gis_buildings change_type='SPBD') GeoJSON — scripts/map3d/export_spbd_buildings.mts로 만든다
SPBD = Path(args[args.index("--spbd") + 1]) if "--spbd" in args else None
OVERLAP = 0.3  # AL_D010 건물이 SPBD 건물과 (작은 쪽 면적의) 30% 이상 겹치면 뺀다 — 철거된 옛 건물·같은 건물 중복
OUT.parent.mkdir(parents=True, exist_ok=True)

EXTENT = 4096
BUFFER = 16  # 타일 경계 밖 여유(타일 단위) — 벽이 경계에서 끊기지 않게
ZOOMS = [12, 13, 14, 15]
HALF = 20037508.342789244
LAYER = "buildings"

t0 = time.time()


def log(msg: str) -> None:
    print(f"[{time.time() - t0:7.1f}s] {msg}", flush=True)


# ───────────── 1) SHP 읽기 → 웹 메르카토르 정규 좌표(0..1) 폴리곤 ─────────────

def shp_path(root: Path, tmp: Path) -> Path:
    if root.suffix.lower() == ".zip":
        with zipfile.ZipFile(root) as zf:
            zf.extractall(tmp)
        hits = sorted(tmp.rglob("*.shp"))
        if not hits:
            raise SystemExit("zip 안에 .shp가 없습니다")
        return hits[0]
    return root


def merc_norm(lon: float, lat: float) -> tuple[float, float]:
    x = (lon + 180) / 360
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2
    return x, y


# 서울(+여유) 범위, 정규 좌표 [minX, minY, maxX, maxY] — 위도는 북쪽이 Y 작음
_a = merc_norm(126.70, 37.75)
_b = merc_norm(127.25, 37.38)
CLIP = (_a[0], _a[1], _b[0], _b[1])

to_merc = Transformer.from_crs("EPSG:5186", "EPSG:3857", always_xy=True)

tmpdir = Path(tempfile.mkdtemp(prefix="map3d_"))
polys: list = []
heights: list[int] = []
apts: list[int] = []
try:
    shp = shp_path(SRC, tmpdir)
    r = shapefile.Reader(str(shp.with_suffix("")), encoding="cp949")
    names = [f[0] for f in r.fields[1:]]
    for need in ("A8", "A16", "A26"):
        if need not in names:
            raise SystemExit(f"필드 {need} 없음: {names}")
    log(f"read {shp.name}: {len(r)} records")
    bad = 0
    outside = 0
    for n, sr in enumerate(r.iterShapeRecords(fields=["A8", "A16", "A26"])):
        if LIMIT and n >= LIMIT:
            break
        rec = sr.record
        pts = sr.shape.points
        if not pts:
            bad += 1
            continue
        parts = list(sr.shape.parts) + [len(pts)]
        xy = np.asarray(pts, dtype=np.float64)
        mx, my = to_merc.transform(xy[:, 0], xy[:, 1])
        X = (np.asarray(mx) + HALF) / (2 * HALF)
        Y = (HALF - np.asarray(my)) / (2 * HALF)
        rings = [np.column_stack([X[parts[k]:parts[k + 1]], Y[parts[k]:parts[k + 1]]]) for k in range(len(parts) - 1)]
        rings = [rg for rg in rings if len(rg) >= 4]
        if not rings:
            bad += 1
            continue
        # 좌표가 서울 밖으로 튄 원천 오류(수백 km 떨어진 외곽선)는 뺀다
        cx, cy = float(X.mean()), float(Y.mean())
        if not (CLIP[0] <= cx <= CLIP[2] and CLIP[1] <= cy <= CLIP[3]):
            outside += 1
            continue
        # SHP: 바깥 고리 = 시계방향(원 좌표, y 위) / 구멍 = 반시계. 고리들을 바깥/구멍으로 묶는다.
        shells: list = []
        holes: list = []
        for rg in rings:
            # 정규 좌표는 y가 아래로 → 방향이 뒤집힘. 원 좌표 기준 부호로 판단.
            a = 0.5 * float(np.sum(rg[:-1, 0] * rg[1:, 1] - rg[1:, 0] * rg[:-1, 1]))
            (shells if a > 0 else holes).append(rg)  # y 반전 뒤 시계방향 = 양수
        if not shells:
            shells, holes = holes, []
        try:
            hole_polys = [shapely.Polygon(h) for h in holes]
            for s in shells:
                sp = shapely.Polygon(s)
                inner = [h.exterior.coords for h in hole_polys if sp.contains(h.representative_point())]
                g = shapely.Polygon(s, inner) if inner else sp
                if not g.is_valid:
                    g = shapely.make_valid(g)
                for part in shapely.get_parts(g):
                    if isinstance(part, shapely.Polygon) and not part.is_empty:
                        polys.append(part)
                        h = rec[1]
                        fl = rec[2]
                        try:
                            h = float(h or 0)
                        except (TypeError, ValueError):
                            h = 0.0
                        try:
                            fl = int(fl or 0)
                        except (TypeError, ValueError):
                            fl = 0
                        if not (0 < h < 700):
                            h = fl * 3.3 if fl > 0 else 3.5
                        heights.append(max(1, int(round(h))))
                        apts.append(1 if str(rec[0] or "").startswith("02") else 0)
        except Exception:
            bad += 1
        if n and n % 100000 == 0:
            log(f"  {n} read, {len(polys)} polygons")
    log(f"done: {len(polys)} polygons, bad={bad}, outside={outside}")
finally:
    shutil.rmtree(tmpdir, ignore_errors=True)

geoms = np.array(polys, dtype=object)
H = np.array(heights, dtype=np.int32)
A = np.array(apts, dtype=np.int8)
merge_stats: dict = {}
if SPBD:
    # SPBD 도형(경위도 고리들) → 정규 좌표 폴리곤. 첫 고리 안에 들어가는 고리는 구멍, 아니면 따로 바깥 고리.
    fc = json.loads(SPBD.read_text(encoding="utf-8"))
    s_polys: list = []
    s_h: list[int] = []
    for ft in fc["features"]:
        rings = [np.array([merc_norm(float(p[0]), float(p[1])) for p in rg]) for rg in ft["geometry"]["coordinates"] if len(rg) >= 4]
        cand = sorted((shapely.Polygon(rg) for rg in rings), key=lambda g: -g.area)
        shells: list = []
        for g in cand:
            if not g.is_valid:
                g = shapely.make_valid(g)
            host = next((k for k, s in enumerate(shells) if s.contains(g.representative_point())), None)
            if host is None:
                shells.append(g)
            else:
                shells[host] = shapely.make_valid(shells[host].difference(g))
        for s in shells:
            for part in shapely.get_parts(s):
                if isinstance(part, shapely.Polygon) and not part.is_empty and part.area > 0:
                    s_polys.append(part)
                    s_h.append(int(ft["properties"]["h"]))
    S = np.array(s_polys, dtype=object)
    tree = shapely.STRtree(S)
    ai, si = tree.query(geoms, predicate="intersects")  # (AL_D010 번호, SPBD 번호) 쌍
    inter = shapely.area(shapely.intersection(geoms[ai], S[si]))
    smaller = np.minimum(shapely.area(geoms[ai]), shapely.area(S[si]))
    ratio = np.divide(inter, smaller, out=np.zeros_like(inter), where=smaller > 0)
    drop = np.zeros(len(geoms), dtype=bool)
    drop[ai[ratio >= OVERLAP]] = True
    keep = ~drop
    merge_stats = {
        "al_d010_total": int(len(geoms)),
        "al_d010_dropped": int(drop.sum()),
        "al_d010_kept": int(keep.sum()),
        "spbd_features": len(fc["features"]),
        "spbd_polygons_added": int(len(S)),
        "overlap_threshold": OVERLAP,
    }
    log(f"SPBD merge: {merge_stats}")
    geoms = np.concatenate([geoms[keep], S])
    H = np.concatenate([H[keep], np.array(s_h, dtype=np.int32)])
    A = np.concatenate([A[keep], np.ones(len(S), dtype=np.int8)])
# 바닥 면적(대략, m²): 정규 좌표 면적 × (지구둘레)² × cos²(위도)
lat0 = math.radians(37.55)
AREA_M2 = shapely.area(geoms) * (2 * HALF) ** 2 * math.cos(lat0) ** 2
del polys

# ───────────── 2) MVT 인코딩 ─────────────

def varint(n: int, out: bytearray) -> None:
    while n > 0x7F:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)


def zz(n: int) -> int:
    return (n << 1) ^ (n >> 31)


def field_bytes(num: int, payload: bytes, out: bytearray) -> None:
    varint((num << 3) | 2, out)
    varint(len(payload), out)
    out += payload


def field_varint(num: int, v: int, out: bytearray) -> None:
    varint((num << 3) | 0, out)
    varint(v, out)


def packed(vals) -> bytes:
    b = bytearray()
    for v in vals:
        varint(v, b)
    return bytes(b)


def ring_cmds(ring: np.ndarray, want_positive: bool, cursor: list, cmds: list) -> bool:
    # ring: 정수 타일 좌표 (닫힘 점 포함 가능)
    pts = [tuple(p) for p in ring]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    dedup = []
    for p in pts:
        if not dedup or dedup[-1] != p:
            dedup.append(p)
    if len(dedup) > 1 and dedup[0] == dedup[-1]:
        dedup.pop()
    if len(dedup) < 3:
        return False
    a = 0
    for k in range(len(dedup)):
        x1, y1 = dedup[k]
        x2, y2 = dedup[(k + 1) % len(dedup)]
        a += x1 * y2 - x2 * y1
    if a == 0:
        return False
    if (a > 0) != want_positive:
        dedup.reverse()
    cx, cy = cursor
    x, y = dedup[0]
    cmds += [9, zz(x - cx), zz(y - cy)]
    cx, cy = x, y
    cmds.append(2 | ((len(dedup) - 1) << 3))
    for x, y in dedup[1:]:
        cmds += [zz(x - cx), zz(y - cy)]
        cx, cy = x, y
    cmds.append(15)
    cursor[0], cursor[1] = cx, cy
    return True


def poly_cmds(poly, z: int, tx: int, ty: int) -> list:
    scale = (1 << z) * EXTENT
    cursor = [0, 0]
    cmds: list = []

    def q(coords) -> np.ndarray:
        c = np.asarray(coords)
        return np.column_stack([np.round(c[:, 0] * scale - tx * EXTENT), np.round(c[:, 1] * scale - ty * EXTENT)]).astype(np.int64)

    if not ring_cmds(q(poly.exterior.coords), True, cursor, cmds):
        return []
    for inner in poly.interiors:
        ring_cmds(q(inner.coords), False, cursor, cmds)
    return cmds


def encode_tile(feats: list) -> bytes:
    # feats: [(h, a, cmds)]
    keys = ["h", "a"]
    values: list = []
    vidx: dict = {}

    def val(v: int) -> int:
        if v not in vidx:
            vidx[v] = len(values)
            values.append(v)
        return vidx[v]

    layer = bytearray()
    field_varint(15, 2, layer)
    field_bytes(1, LAYER.encode(), layer)
    for h, a, cmds in feats:
        f = bytearray()
        tags = [0, val(int(h))]
        if a:
            tags += [1, val(1)]
        field_bytes(2, packed(tags), f)
        field_varint(3, 3, f)
        field_bytes(4, packed(cmds), f)
        field_bytes(2, bytes(f), layer)
    for k in keys:
        field_bytes(3, k.encode(), layer)
    for v in values:
        vb = bytearray()
        field_varint(5, v, vb)  # uint_value
        field_bytes(4, bytes(vb), layer)
    field_varint(5, EXTENT, layer)
    tile = bytearray()
    field_bytes(3, bytes(layer), tile)
    return bytes(tile)


# ───────────── 3) 줌별 타일 자르기 ─────────────

def keep_mask(z: int) -> np.ndarray:
    if z == 12:
        return H >= 40
    if z == 13:
        return (H >= 15) | (AREA_M2 >= 1500)
    if z == 14:
        return AREA_M2 >= 12
    return np.ones(len(H), dtype=bool)


def tile_id(z: int, x: int, y: int) -> int:
    acc = ((1 << (2 * z)) - 1) // 3
    d = 0
    s = 1 << (z - 1) if z > 0 else 0
    tx, ty = x, y
    while s > 0:
        rx = 1 if (tx & s) > 0 else 0
        ry = 1 if (ty & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                tx = s - 1 - tx
                ty = s - 1 - ty
            tx, ty = ty, tx
        s >>= 1
    return acc + d


tiles: dict[int, bytes] = {}
tile_counts: dict[int, int] = {}
bytes_by_zoom: dict[int, int] = {}
features_by_zoom: dict[int, int] = {}
minX = minY = 1.0
maxX = maxY = 0.0

for z in ZOOMS:
    n = 1 << z
    m = keep_mask(z)
    idx = np.nonzero(m)[0]
    tol = 0.7 / (n * EXTENT)  # 0.7 타일 단위
    simp = shapely.simplify(geoms[idx], tol, preserve_topology=True)
    b = shapely.bounds(simp)
    buf = BUFFER / EXTENT
    per_tile: dict[tuple[int, int], list] = {}
    nfeat = 0
    for j in range(len(idx)):
        g = simp[j]
        if g is None or g.is_empty:
            continue
        x0, y0, x1, y1 = b[j]
        if z == ZOOMS[-1]:
            minX, minY, maxX, maxY = min(minX, x0), min(minY, y0), max(maxX, x1), max(maxY, y1)
        tx0, tx1 = int(math.floor(x0 * n - buf)), int(math.floor(x1 * n + buf))
        ty0, ty1 = int(math.floor(y0 * n - buf)), int(math.floor(y1 * n + buf))
        gi = idx[j]
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                inside = (x0 * n >= tx - buf and x1 * n <= tx + 1 + buf and y0 * n >= ty - buf and y1 * n <= ty + 1 + buf)
                parts = [g]
                if not inside:
                    c = shapely.clip_by_rect(g, (tx - buf) / n, (ty - buf) / n, (tx + 1 + buf) / n, (ty + 1 + buf) / n)
                    if c.is_empty:
                        continue
                    parts = [p for p in shapely.get_parts(c) if isinstance(p, shapely.Polygon) and not p.is_empty]
                for p in parts:
                    cmds = poly_cmds(p, z, tx, ty)
                    if cmds:
                        per_tile.setdefault((tx, ty), []).append((int(H[gi]), int(A[gi]), cmds))
                        nfeat += 1
    zbytes = 0
    for (tx, ty), feats in per_tile.items():
        # 높은 건물을 나중에 → 겹칠 때 위에 그려짐 (의미 없지만 결정적 순서)
        feats.sort(key=lambda f: f[0])
        raw = encode_tile(feats)
        gz = gzip.compress(raw, compresslevel=9, mtime=0)
        tiles[tile_id(z, tx, ty)] = gz
        zbytes += len(gz)
    tile_counts[z] = len(per_tile)
    bytes_by_zoom[z] = zbytes
    features_by_zoom[z] = nfeat
    log(f"z{z}: {len(idx)} buildings → {len(per_tile)} tiles, {nfeat} features, {zbytes / 1e6:.1f} MB gz")

# ───────────── 4) PMTiles v3 쓰기 ─────────────

def serialize_dir(entries: list) -> bytes:
    # entries: [(tile_id, offset, length, run_length)]
    b = bytearray()
    varint(len(entries), b)
    last = 0
    for e in entries:
        varint(e[0] - last, b)
        last = e[0]
    for e in entries:
        varint(e[3], b)
    for e in entries:
        varint(e[2], b)
    for k, e in enumerate(entries):
        if k > 0 and e[1] == entries[k - 1][1] + entries[k - 1][2]:
            varint(0, b)
        else:
            varint(e[1] + 1, b)
    return gzip.compress(bytes(b), compresslevel=9, mtime=0)


ids = sorted(tiles)
data = io.BytesIO()
entries: list = []
seen_hash: dict[str, tuple[int, int]] = {}
contents = 0
for tid in ids:
    blob = tiles[tid]
    hsh = hashlib.sha1(blob).hexdigest()
    if hsh in seen_hash:
        off, ln = seen_hash[hsh]
        if entries and entries[-1][1] == off and entries[-1][0] + entries[-1][3] == tid:
            entries[-1] = (entries[-1][0], off, ln, entries[-1][3] + 1)
        else:
            entries.append((tid, off, ln, 1))
        continue
    off = data.tell()
    data.write(blob)
    seen_hash[hsh] = (off, len(blob))
    contents += 1
    entries.append((tid, off, len(blob), 1))
tile_data = data.getvalue()

root = serialize_dir(entries)
leaves = b""
if 127 + len(root) > 16384:
    leaf_size = 4096
    while True:
        leaf_buf = bytearray()
        root_entries = []
        for k in range(0, len(entries), leaf_size):
            chunk = entries[k:k + leaf_size]
            ser = serialize_dir(chunk)
            root_entries.append((chunk[0][0], len(leaf_buf), len(ser), 0))
            leaf_buf += ser
        root = serialize_dir(root_entries)
        if 127 + len(root) <= 16384:
            leaves = bytes(leaf_buf)
            break
        leaf_size *= 2

lon = lambda X: X * 360 - 180  # noqa: E731
lat = lambda Y: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * Y))))  # noqa: E731
bbox = [lon(minX), lat(maxY), lon(maxX), lat(minY)]
metadata = json.dumps(
    {
        "name": "ziplab-seoul-buildings",
        "format": "pbf",
        "attribution": "건물: 국토교통부 GIS건물통합정보" + (", 행정안전부 도로명주소 건물(브이월드)" if SPBD else ""),
        "source": SRC.name + (f" + {SPBD.name}" if SPBD else ""),
        "vector_layers": [
            {"id": LAYER, "fields": {"h": "Number", "a": "Number"}, "minzoom": ZOOMS[0], "maxzoom": ZOOMS[-1]}
        ],
    },
    ensure_ascii=False,
).encode()
metadata_gz = gzip.compress(metadata, compresslevel=9, mtime=0)

root_off = 127
meta_off = root_off + len(root)
leaf_off = meta_off + len(metadata_gz)
data_off = leaf_off + len(leaves)
e7 = lambda v: int(round(v * 1e7))  # noqa: E731
header = b"PMTiles" + bytes([3])
header += struct.pack(
    "<QQQQQQQQQQQ",
    root_off, len(root), meta_off, len(metadata_gz), leaf_off, len(leaves), data_off, len(tile_data),
    len(ids), len(entries), contents,
)
header += bytes([1, 2, 2, 1, ZOOMS[0], ZOOMS[-1]])  # clustered, internal=gzip, tile=gzip, type=mvt
header += struct.pack("<iiii", e7(bbox[0]), e7(bbox[1]), e7(bbox[2]), e7(bbox[3]))
header += bytes([14]) + struct.pack("<ii", e7((bbox[0] + bbox[2]) / 2), e7((bbox[1] + bbox[3]) / 2))
assert len(header) == 127, len(header)

with OUT.open("wb") as f:
    f.write(header)
    f.write(root)
    f.write(metadata_gz)
    f.write(leaves)
    f.write(tile_data)

summary = {
    "src": str(SRC),
    "out": str(OUT),
    "bytes": OUT.stat().st_size,
    "buildings": int(len(H)),
    "merge": merge_stats,
    "tiles": len(ids),
    "tile_contents": contents,
    "tiles_by_zoom": tile_counts,
    "bytes_by_zoom": bytes_by_zoom,
    "features_by_zoom": features_by_zoom,
    "max_tile_bytes": max(len(t) for t in tiles.values()),
    "bbox": [round(v, 5) for v in bbox],
    "root_dir_bytes": len(root),
    "leaf_dir_bytes": len(leaves),
    "seconds": round(time.time() - t0, 1),
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
