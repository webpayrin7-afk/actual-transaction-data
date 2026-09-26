import { LngLat, Point, type Map as MlMap } from "maplibre-gl";

/** 화면에서 가려지는 곳 (px) — 위: 필터 줄, 아래: 단지 카드·독 */
export type SafeInsets = { top: number; bottom: number; left: number; right: number };

type Tr = {
  setZoom(z: number): void;
  setCenter(c: LngLat): void;
  setPitch(p: number): void;
  setBearing(b: number): void;
  setPadding(p: { top: number; bottom: number; left: number; right: number }): void;
  locationToScreenPoint(l: LngLat): Point;
  screenPointToLocation(p: Point): LngLat;
  get zoom(): number;
  get width(): number;
  get height(): number;
};

/**
 * 단지를 비스듬히 한 화면에 담는 카메라 — 기울기·원근·건물 높이까지 넣어 계산한다.
 * cameraForBounds 는 땅 사각형만 보고(기울이면 먼 쪽이 작아지는 원근·건물 높이는 모름) 큰 단지는 잘리고
 * 높은 탑상형은 너무 멀어졌다. 지도 카메라를 복제해 화면 밖에서 맞춰 본다 (지도는 움직이지 않음).
 *
 * - 점: 땅 네 모서리 + 지붕 네 모서리(높이 h 인 점은 카메라 반대쪽으로 h·tan(기울기) 떨어진 땅과 겹쳐 보인다)
 * - 줌: 점들의 화면 범위가 보이는 곳의 `fill` 만큼 차게 (원근 때문에 몇 번 되풀이)
 * - 가운데: 점들의 화면 범위 가운데가 보이는 곳 가운데에 오게
 */
export function fitComplexCamera(
  map: MlMap,
  bbox: [number, number, number, number],
  heightM: number,
  safe: SafeInsets,
  opts: { pitch: number; bearing: number; fill?: number; minZoom: number; maxZoom: number; biasY?: number },
): { center: LngLat; zoom: number } | null {
  const src = map.transform as unknown as { clone?: () => Tr };
  if (typeof src.clone !== "function") return null;
  const tr = src.clone();
  const fill = opts.fill ?? 0.8;
  const [w, s, e, n] = bbox;
  const midLat = (s + n) / 2;
  const kx = 111_320 * Math.cos((midLat * Math.PI) / 180);
  const b = (opts.bearing * Math.PI) / 180;
  const d = Math.max(0, heightM) * Math.tan((Math.min(opts.pitch, 75) * Math.PI) / 180);
  const dLng = (d * Math.sin(b)) / kx;
  const dLat = (d * Math.cos(b)) / 111_320;
  const ground: Array<[number, number]> = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ];
  const pts = [...ground, ...ground.map(([x, y]) => [x + dLng, y + dLat] as [number, number])].map(
    ([x, y]) => new LngLat(x, y),
  );

  const W = tr.width;
  const H = tr.height;
  const box = { l: safe.left, r: W - safe.right, t: safe.top, b: H - safe.bottom };
  if (box.r - box.l < 40 || box.b - box.t < 40) return null;
  const boxCx = (box.l + box.r) / 2;
  // biasY: 보이는 곳 높이에 대한 비율만큼 가운데를 올린다(음수) — 아래 카드 쪽으로 무겁게 보이지 않게
  const boxCy = (box.t + box.b) / 2 + (opts.biasY ?? 0) * (box.b - box.t);

  tr.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  tr.setPitch(opts.pitch);
  tr.setBearing(opts.bearing);
  tr.setCenter(new LngLat((w + e) / 2 + dLng / 2, (s + n) / 2 + dLat / 2));
  tr.setZoom(Math.min(opts.maxZoom, Math.max(opts.minZoom, map.getZoom())));

  const measure = () => {
    let l = Infinity, r = -Infinity, t = Infinity, bt = -Infinity;
    for (const p of pts) {
      const q = tr.locationToScreenPoint(p);
      if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return null;
      l = Math.min(l, q.x); r = Math.max(r, q.x); t = Math.min(t, q.y); bt = Math.max(bt, q.y);
    }
    return { l, r, t, b: bt };
  };

  for (let i = 0; i < 6; i++) {
    const m = measure();
    if (!m) return null;
    const sw = (box.r - box.l) * fill / Math.max(1, m.r - m.l);
    const sh = (box.b - box.t) * fill / Math.max(1, m.b - m.t);
    const dz = Math.log2(Math.min(sw, sh));
    // 범위 가운데를 보이는 곳 가운데로
    const cx = (m.l + m.r) / 2;
    const cy = (m.t + m.b) / 2;
    tr.setCenter(tr.screenPointToLocation(new Point(W / 2 + (cx - boxCx), H / 2 + (cy - boxCy))));
    const z = Math.min(opts.maxZoom, Math.max(opts.minZoom, tr.zoom + dz));
    const done = Math.abs(z - tr.zoom) < 0.02;
    tr.setZoom(z);
    if (done && Math.abs(cx - boxCx) < 2 && Math.abs(cy - boxCy) < 2) break;
  }
  const last = measure();
  if (last) {
    tr.setCenter(
      tr.screenPointToLocation(new Point(W / 2 + ((last.l + last.r) / 2 - boxCx), H / 2 + ((last.t + last.b) / 2 - boxCy))),
    );
  }
  return { center: tr.screenPointToLocation(new Point(W / 2, H / 2)), zoom: tr.zoom };
}
