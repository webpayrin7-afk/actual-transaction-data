/**
 * 3D 단지 탐색 바닥 — 브이월드 위성영상 타일(웹 메르카토르, 256px)을 이어 붙여 한 장으로 (브라우저).
 * 바닥은 단지 중심을 가운데로 한 변 sizeM 미터 정사각형(북쪽 위) — NAVER 지도 바닥과 같은 자리·크기.
 * 브이월드 키는 도메인(서비스 URL)에 묶인 브라우저용이라 화면에 실려도 된다. 타일은 CORS 허용(*).
 * 타일이 많이 빠지면(키·도메인 불일치 등) null — 부르는 쪽이 NAVER 바닥을 그대로 둔다.
 */

const ZOOM = 17; // 서울에서 약 0.95 m/px (넓은 바닥은 zoom 인자로 낮춰 받는다)
const TILE = 256;
const MAX_FAIL_SHARE = 0.2;

function worldPx(lat: number, lng: number, z: number): [number, number] {
  const n = TILE * 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return [x, y];
}

function loadTile(url: string, signal?: AbortSignal): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    const done = (v: HTMLImageElement | null) => {
      signal?.removeEventListener("abort", abort);
      resolve(v);
    };
    const abort = () => {
      img.src = "";
      done(null);
    };
    signal?.addEventListener("abort", abort);
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = url;
  });
}

export async function satelliteGround(
  center: { lat: number; lng: number },
  sizeM: number,
  key: string,
  signal?: AbortSignal,
  zoom: number = ZOOM,
): Promise<string | null> {
  const mpp = (40075016.686 * Math.cos((center.lat * Math.PI) / 180)) / (TILE * 2 ** zoom);
  const half = sizeM / 2 / mpp;
  const [cx, cy] = worldPx(center.lat, center.lng, zoom);
  const x0 = cx - half;
  const y0 = cy - half;
  const side = Math.round(half * 2);
  const tx0 = Math.floor(x0 / TILE);
  const ty0 = Math.floor(y0 / TILE);
  const tx1 = Math.floor((cx + half) / TILE);
  const ty1 = Math.floor((cy + half) / TILE);

  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const jobs: Array<Promise<boolean>> = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const url = `https://api.vworld.kr/req/wmts/1.0.0/${encodeURIComponent(key)}/Satellite/${zoom}/${ty}/${tx}.jpeg`;
      jobs.push(
        loadTile(url, signal).then((img) => {
          if (!img) return false;
          ctx.drawImage(img, Math.round(tx * TILE - x0), Math.round(ty * TILE - y0), TILE, TILE);
          return true;
        }),
      );
    }
  }
  const ok = await Promise.all(jobs);
  if (signal?.aborted) return null;
  if (ok.filter((x) => !x).length > ok.length * MAX_FAIL_SHARE) return null;
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.88));
  return blob ? URL.createObjectURL(blob) : null;
}
