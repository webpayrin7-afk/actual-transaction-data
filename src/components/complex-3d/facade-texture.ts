/**
 * 3D 단지 외벽 무늬 — 사진·외부 모형 없이 캔버스로 직접 그린다 (저작권 걱정 없는 우리 그림).
 *
 * 무늬 한 장 = 창 한 칸(가로) × 한 층(세로). 벽 UV를 미터 기준으로 잡아 반복시킨다:
 *  - u = 벽 한 면 안에서 창 칸 수 (벽 길이 ÷ 창 간격을 반올림 — 모서리에서 창이 잘리지 않게)
 *  - v = 바닥에서부터 층 수 (높이 ÷ 층 높이) → 실제 층수만큼 층 띠가 생긴다
 * 벽 종류는 u에 1000 단위로 싣는다 (반복 무늬라 정수 더하기는 모양을 바꾸지 않는다):
 *  0 = 창이 있는 벽, 1 = 옆벽(짧은 끝면 — 창을 흐리게), 2 = 창 없는 자투리 벽.
 * 텍스처는 (시대 × 주거 여부) 조합마다 한 장만 만들어 모든 동이 나눠 쓴다. 한 번 그리면 다시 그리지 않는다.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type FacadeEra = "old" | "mid" | "new";

type Look = {
  wall: string;
  slab: string;
  glass: string;
  glassHi: string;
  frame: string;
  /** 창 가로·세로 비율 (한 칸·한 층 대비) */
  winW: number;
  winH: number;
  /** 창 아래 끝 (층 바닥에서의 비율) */
  winY: number;
  /** 창 간격 (m) */
  bay: number;
  rail?: string;
  fin?: string;
};

const LOOKS: Record<FacadeEra, Look> = {
  // ~1989 — 칠한 콘크리트, 따뜻한 미색, 작은 창
  old: { wall: "#ece4d6", slab: "#d6ccbb", glass: "#6a7780", glassHi: "#8a979f", frame: "#c9bfad", winW: 0.46, winH: 0.46, winY: 0.3, bay: 2.6 },
  // 1990~2009 — 밝은 회색·아이보리, 큰 창, 발코니 난간
  mid: { wall: "#eef0ed", slab: "#d4d9dc", glass: "#7a8f9c", glassHi: "#9fb1bd", frame: "#dfe3e4", winW: 0.72, winH: 0.58, winY: 0.24, bay: 2.8, rail: "#aab4bb" },
  // 2010~ — 유리가 많은 청회색, 세로 핀
  new: { wall: "#e3e8ec", slab: "#cfd7dd", glass: "#7892a6", glassHi: "#a3b8c7", frame: "#c3ced6", winW: 0.82, winH: 0.72, winY: 0.14, bay: 3.0, rail: "#9fb0bc", fin: "#b3c0ca" },
};

/** 사용승인일(YYYY-MM-DD 등) → 연도 */
export function approvalYear(date: string | null | undefined): number | null {
  const m = date?.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

export function eraOf(year: number | null): FacadeEra {
  if (year == null) return "mid";
  return year < 1990 ? "old" : year < 2010 ? "mid" : "new";
}

export function bayOf(era: FacadeEra): number {
  return LOOKS[era].bay;
}

/** 층 높이 — 층수를 알면 높이 ÷ 층수 (2.6~4.5m), 모르면 3m */
export function floorHeightOf(h: number, floors: number | null): number {
  if (!floors || floors <= 0) return 3;
  return Math.min(4.5, Math.max(2.6, h / floors));
}

/**
 * ExtrudeGeometry 벽 UV — 미터 기준 (위 설명). maxEdge: 이 외곽선의 가장 긴 변 (옆벽 판단용).
 * 지붕·바닥 UV는 쓰지 않으니 0으로.
 */
export function facadeUv(floorH: number, bay: number, maxEdge: number): THREE.UVGenerator {
  return {
    generateTopUV: () => [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()],
    generateSideWallUV: (_g, v, a, b, c, d) => {
      const len = Math.hypot(v[b * 3]! - v[a * 3]!, v[b * 3 + 1]! - v[a * 3 + 1]!);
      const kind = len < bay * 0.7 ? 2 : len < maxEdge * 0.5 && len <= 20 ? 1 : 0;
      const n = kind === 2 ? 1 : Math.max(1, Math.round(len / bay));
      const off = kind * 1000;
      const vz = (i: number) => v[i * 3 + 2]! / floorH;
      return [
        new THREE.Vector2(off, vz(a)),
        new THREE.Vector2(off + n, vz(b)),
        new THREE.Vector2(off + n, vz(c)),
        new THREE.Vector2(off, vz(d)),
      ];
    },
  };
}

/** 한 칸 × 한 층 무늬 그리기 (캔버스 위가 v=1 — 층 바닥 슬래브는 아래에) */
function drawTile(size: number, look: Look, residential: boolean, cheap: boolean): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d")!;
  const s = size;
  const Y = (v: number) => s - v * s; // v(아래→위) → 캔버스 y
  g.fillStyle = look.wall;
  g.fillRect(0, 0, s, s);
  // 층 슬래브 띠
  g.fillStyle = look.slab;
  g.fillRect(0, Y(0.07), s, 0.07 * s);
  // 주거 아닌 건물(상가·관리동)은 가로로 긴 띠창
  const winW = residential ? look.winW : 0.9;
  const winH = residential ? look.winH : 0.46;
  const winY = residential ? look.winY : 0.3;
  const x0 = ((1 - winW) / 2) * s;
  const w = winW * s;
  const top = Y(winY + winH);
  const h = winH * s;
  if (!cheap) {
    g.fillStyle = look.frame;
    g.fillRect(x0 - 0.03 * s, top - 0.03 * s, w + 0.06 * s, h + 0.06 * s);
  }
  // 유리 — 위가 조금 밝게 (하늘 반사)
  const grad = g.createLinearGradient(0, top, 0, top + h);
  grad.addColorStop(0, look.glassHi);
  grad.addColorStop(1, look.glass);
  g.fillStyle = grad;
  g.fillRect(x0, top, w, h);
  if (!cheap) {
    // 창틀 가운데 세로 문설주
    g.fillStyle = look.frame;
    g.fillRect(s / 2 - 0.012 * s, top, 0.024 * s, h);
  }
  if (residential && look.rail && !cheap) {
    // 발코니 난간 — 창 아래쪽을 가로지르는 얇은 선 두 줄
    g.fillStyle = look.rail;
    g.fillRect(x0 - 0.03 * s, Y(winY + winH * 0.32), w + 0.06 * s, 0.022 * s);
    g.fillRect(x0 - 0.03 * s, Y(winY + 0.02), w + 0.06 * s, 0.016 * s);
  } else if (residential && !cheap) {
    // 옛 아파트 — 발코니 콘크리트 난간벽 (창 아래 조금 어두운 띠)
    g.fillStyle = look.slab;
    g.globalAlpha = 0.55;
    g.fillRect(0, Y(winY), s, (winY - 0.07) * s);
    g.globalAlpha = 1;
  }
  if (look.fin && !cheap) {
    // 세로 핀 — 칸 양 끝
    g.fillStyle = look.fin;
    g.fillRect(0, 0, 0.05 * s, s);
    g.fillRect(s - 0.05 * s, 0, 0.05 * s, s);
  }
  return cv;
}

const FACADE_SHADER_KEY = "ziplab-facade-v1";

/** 외벽 재질 — 표준 재질 + 벽 종류(옆벽·자투리)와 1층(필로티) 어둡게를 셰이더에서 */
function facadeMaterial(tex: THREE.Texture, wall: string, tint: number, opts: { transparent?: boolean; opacity?: number; roughness: number }) {
  const m = new THREE.MeshStandardMaterial({
    map: tex,
    color: tint,
    roughness: opts.roughness,
    metalness: 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
  });
  const wallColor = new THREE.Color(wall);
  m.onBeforeCompile = (p) => {
    p.uniforms.uFacadeWall = { value: wallColor };
    p.fragmentShader = p.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uFacadeWall;")
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  float fKind = floor(vMapUv.x / 1000.0);
  vec3 fCol = texture2D(map, vMapUv).rgb;
  fCol = mix(fCol, uFacadeWall, fKind > 1.5 ? 1.0 : (fKind > 0.5 ? 0.72 : 0.0));
  fCol *= vMapUv.y < 1.0 ? 0.8 : 1.0;
  diffuseColor.rgb *= fCol;
#endif`,
      );
  };
  m.customProgramCacheKey = () => FACADE_SHADER_KEY;
  return m;
}

/** 동 이름에서 벽에 칠할 글자 — "101동" → "101". 너무 길면 칠하지 않는다 */
export function dongPaintText(dong: string | null): string | null {
  if (!dong) return null;
  const t = dong.trim().replace(/동$/, "").trim();
  return t && t.length <= 5 ? t : null;
}

/**
 * 외벽 텍스처·재질 모음 — 장면 하나에 하나. 같은 조합은 한 번만 만들고 나눠 쓴다.
 * 우리 단지: 128px 무늬 (시대 3 × 주거/비주거 2 = 최대 6장), 주변 건물: 64px 단순 무늬 1장, 동 번호: 번호마다 128×64 한 장.
 */
export class FacadeKit {
  private textures = new Map<string, THREE.Texture>();
  private materials = new Map<string, THREE.Material[]>();
  private labels = new Map<string, THREE.Material>();
  constructor(private anisotropy: number) {}

  private tex(key: string, draw: () => HTMLCanvasElement): THREE.Texture {
    let t = this.textures.get(key);
    if (!t) {
      t = new THREE.CanvasTexture(draw());
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = this.anisotropy;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      this.textures.set(key, t);
    }
    return t;
  }

  /** 우리 단지 동 — [지붕, 벽]. 벽은 옅은 청록을 곱해 주변 회색 건물과 구분, 지붕은 단지 색 */
  own(era: FacadeEra, residential: boolean, roofColor: number): THREE.Material[] {
    const key = `own:${era}:${residential ? 1 : 0}`;
    let mats = this.materials.get(key);
    if (!mats) {
      const look = LOOKS[era];
      const tex = this.tex(key, () => drawTile(128, look, residential, false));
      mats = [
        new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.9, metalness: 0 }),
        facadeMaterial(tex, look.wall, 0xd9f0ed, { roughness: era === "new" ? 0.7 : 0.85 }),
      ];
      this.materials.set(key, mats);
    }
    return mats;
  }

  /** 주변 건물 — 창 대비를 낮춘 싸구려 무늬 한 장 (반투명은 기존과 같게) */
  neighbor(color: number): THREE.Material[] {
    const key = "nb";
    let mats = this.materials.get(key);
    if (!mats) {
      const hex = `#${new THREE.Color(color).getHexString()}`;
      const look: Look = { ...LOOKS.mid, wall: hex, slab: "#d9dde3", glass: "#b7c1cb", glassHi: "#c8d0d8", frame: hex, winW: 0.6, winH: 0.5, winY: 0.26 };
      const tex = this.tex(key, () => drawTile(64, look, true, true));
      mats = [
        new THREE.MeshStandardMaterial({ color, roughness: 0.95, transparent: true, opacity: 0.9 }),
        facadeMaterial(tex, hex, 0xffffff, { roughness: 0.95, transparent: true, opacity: 0.9 }),
      ];
      this.materials.set(key, mats);
    }
    return mats;
  }

  /** 옆벽에 칠하는 동 번호 (글자만, 바탕 투명) */
  label(text: string): THREE.Material {
    let m = this.labels.get(text);
    if (!m) {
      const cv = document.createElement("canvas");
      cv.width = 128;
      cv.height = 64;
      const g = cv.getContext("2d")!;
      g.fillStyle = "#274157";
      g.textAlign = "center";
      g.textBaseline = "middle";
      let px = 56;
      g.font = `800 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      while (px > 20 && g.measureText(text).width > 120) {
        px -= 4;
        g.font = `800 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      }
      g.fillText(text, 64, 34);
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = this.anisotropy;
      this.textures.set(`label:${text}`, t);
      m = new THREE.MeshLambertMaterial({
        map: t,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      this.labels.set(text, m);
    }
    return m;
  }

  /** 장면을 다시 지을 때 버리지 말아야 할 것 */
  shared(): unknown[] {
    return [...[...this.materials.values()].flat(), ...this.labels.values()];
  }

  dispose() {
    for (const t of this.textures.values()) t.dispose();
    for (const m of [...[...this.materials.values()].flat(), ...this.labels.values()]) m.dispose();
    this.textures.clear();
    this.materials.clear();
    this.labels.clear();
  }
}

/**
 * 여러 조각을 합치되 지붕(0)·벽(1) 재질 구분은 남긴다 — ExtrudeGeometry의 그룹 0 = 지붕·바닥, 1 = 벽.
 * 결과: 그룹 0 = 모든 지붕, 그룹 1 = 모든 벽.
 */
export function mergeWithGroups(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const parts: [THREE.BufferGeometry[], THREE.BufferGeometry[]] = [[], []];
  for (const g0 of geos) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const count = g.attributes.position!.count;
    const groups = g.groups.length ? g.groups : [{ start: 0, count, materialIndex: 1 }];
    for (const gr of groups) {
      const part = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(g.attributes)) {
        const a = attr as THREE.BufferAttribute;
        part.setAttribute(name, new THREE.BufferAttribute(a.array.slice(gr.start * a.itemSize, (gr.start + gr.count) * a.itemSize), a.itemSize));
      }
      parts[gr.materialIndex === 0 ? 0 : 1].push(part);
    }
    if (g !== g0) g.dispose();
    g0.dispose();
  }
  const caps = parts[0].length ? mergeGeometries(parts[0]) : null;
  const sides = parts[1].length ? mergeGeometries(parts[1]) : null;
  for (const p of [...parts[0], ...parts[1]]) p.dispose();
  if (!caps || !sides) {
    const one = sides ?? caps;
    one?.addGroup(0, one.attributes.position!.count, sides ? 1 : 0);
    return one;
  }
  const out = mergeGeometries([caps, sides], true);
  caps.dispose();
  sides.dispose();
  return out;
}
