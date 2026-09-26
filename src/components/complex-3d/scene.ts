/**
 * 3D 단지 장면 (three.js) — React 밖에서 캔버스 하나를 맡는다.
 * 좌표: 단지 중심 기준 미터. x = 동쪽, y = 위, z = 남쪽(북쪽이 -z).
 * 높이: 원천 높이(m)가 있으면 그대로, 없으면 지상층수 × 3m (화면에 "층수로 표시"라고 알린다).
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import type { Complex3d, Complex3dBuilding, FloorBand, Poi3d, Ring } from "@/lib/complex-3d/read";
import type { TerrainGridPayload } from "@/lib/complex-3d/ground";
import { WALKER_LOOK, type WalkerId, type WalkerLook } from "@/lib/complex-3d/walker-profiles";
import { facadeSunColor, firstPrismHit, makePrism, prismsInFront, sunBlocked, type Prism } from "@/components/complex-3d/facade-sun";

export const FLOOR_M = 3;
/** 평소 둘러보기에서 가장 가까이 다가갈 수 있는 거리 (m) — 걷기 따라가기 중에는 풀어 둔다 */
const MIN_DIST = 40;
/** 카메라가 보는 곳은 단지에서 이만큼까지 */
const PAN_LIMIT_M = 1600;
/** 가장 멀리 (m) */
const MAX_DIST = 2200;
/** 안개 — 이 거리부터 흐려져 이 거리에서 하늘색 */
const FOG_NEAR = 1800;
const FOG_FAR = 3600;
const FOLLOW_MIN_DIST = 20;
const TEAL = 0x0e9aa0;
const TEAL_DARK = 0x087f83;
const OWN = 0x9fd9d6; // 단지 동 — 주변 회색 건물과 구분되는 중간 톤 청록
const OWN_EDGE = 0x0e9aa0;
const NEIGHBOR = 0xe6e9ee;

export type SceneMode = "base" | "floors" | "types" | "sun" | "view" | "around" | "walk";

/** 걷기 경로 하나 (API 응답 중 그리는 데 필요한 것만) */
export type WalkRouteDraw = {
  points: Array<[number, number]>;
  marks: Array<{ lng: number; lat: number; kind: string; major?: boolean; signal?: boolean }>;
  target: { lng: number; lat: number };
  name: string;
  totalSec: number;
  /** 기본 속도(4.5km/h)로 걸었을 때 — 빨리 감기 배율을 걷는 사람과 상관없이 같게 */
  baseSec?: number;
  walker?: WalkerId;
};

/** 동의 주력 평형 (세대가 가장 많은 평형) */
export function dominantUnit(b: Complex3dBuilding): { label: string; share: number } | null {
  const total = b.units.reduce((s, u) => s + u.households, 0);
  const top = b.units[0];
  return top && total > 0 ? { label: top.label, share: top.households / total } : null;
}

const FACING = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];

export type DongContext = {
  /** "남향", "남동향" … (동 정면 기준) */
  facing: string;
  /** 정면으로 가장 먼저 닿는 단지 동 — 없으면 null (앞이 트임) */
  front: { dong: string | null; meters: number } | null;
  /** 외곽선 사이 가장 가까운 동 */
  near: { dong: string | null; meters: number } | null;
};

export type SunHours = {
  /** 해가 드는 시간 합계 (분) */
  totalMin: number;
  /** 9~15시 사이 연속으로 해가 드는 가장 긴 시간 (분) */
  best9to15Min: number;
  /** 7시부터 10분 간격, 해가 들면 true (해가 없으면 null) */
  slots: Array<boolean | null>;
};

export type ViewResult = {
  /** 72방향(5°) 첫 가림까지 거리(m), 막힘 없으면 null */
  rays: Array<{ azimuth: number; distance: number | null }>;
  openShare: number;
};

export function buildingHeight(b: { heightM: number | null; floors: number | null }): { h: number; estimated: boolean } {
  if (b.heightM && b.heightM > 0) return { h: b.heightM, estimated: false };
  return { h: Math.max(1, b.floors ?? 1) * FLOOR_M, estimated: true };
}

/** 태양 고도·방위 (NOAA 간이식). 방위는 북=0°, 시계방향. hour는 KST. */
export function sunPosition(lat: number, lng: number, date: Date, hourKst: number): { altitude: number; azimuth: number } {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const n = Math.floor((date.getTime() - start) / 86_400_000);
  const g = ((2 * Math.PI) / 365) * (n - 1 + (hourKst - 9 - 12) / 24);
  const eqTime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const solarMin = hourKst * 60 + eqTime + 4 * lng - 60 * 9;
  const ha = ((solarMin / 4 - 180) * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const cosZen = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZen)));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI;
  return { altitude: Math.PI / 2 - zen, azimuth: az };
}

export type WindowViewInfo = {
  floor: number;
  /** 창이 난 외벽의 향 ("남향" …) */
  facing: string;
  /** 지금 보는 방향 ("남쪽" …) */
  lookDir: string;
  /** 정면에서 돌아본 각도 (도, +면 오른쪽) */
  yaw: number;
  /** 보는 방향 ±4° 안 첫 건물까지 (m), 500m 안에 없으면 null */
  frontM: number | null;
  frontDong: string | null;
  /** 첫 가림이 건물이 아니라 지형(언덕·산) */
  frontHill: boolean;
  /** 화면에 보이는 가로 폭(°) 중 200m 안에서 막힌 비율 */
  blockedShare: number;
  /** 가림 비율을 잰 가로 폭 (°) — 지금 화면에 보이는 가로 시야 */
  spanDeg: number;
  /** 눈높이 — 동 바닥에서 (m) */
  eyeM: number;
  /** 지형 격자가 거칠어 창 자리 땅이 동 바닥보다 높게 잡힘 (비탈) — 카메라·지형 가림을 그 땅 높이 기준으로 올려 잰다 */
  roughGround: boolean;
};

export type FacadeSunProgress = {
  on: boolean;
  done: number;
  total: number;
  /** 고른 동 — 층 구간별 외벽 구간 중 가장 적게·많이 드는 시간 (아직 계산 전이면 null) */
  selected: Array<{ from: number; to: number; main: number; min: number; max: number }> | null;
};

/** 외벽 일조 계산 결과 — 외벽 구간(segs) × 층 구간(bands), hours[i]는 segs[i]의 하루 해 드는 시간(시간) */
type FacadeSunCells = {
  /** 동 바닥 높이 (지형 가림을 잴 때 기준) */
  base: number;
  segs: Array<{ x0: number; z0: number; x1: number; z1: number; ox: number; oz: number }>;
  bands: Array<{ from: number; to: number; y0: number; y1: number; ys: number; hours: number[] }>;
};

/** 7~18시 10분 간격(가운데 시각)의 해 방향 — 해가 없으면 null (일조 시간 계산과 같은 칸) */
function sunDirs(center: { lat: number; lng: number }, date: Date): Array<THREE.Vector3 | null> {
  const out: Array<THREE.Vector3 | null> = [];
  for (let m = 7 * 60; m < 18 * 60; m += 10) {
    const sp = sunPosition(center.lat, center.lng, date, (m + 5) / 60);
    out.push(
      sp.altitude <= 0.01
        ? null
        : new THREE.Vector3(Math.sin(sp.azimuth) * Math.cos(sp.altitude), Math.sin(sp.altitude), -Math.cos(sp.azimuth) * Math.cos(sp.altitude)),
    );
  }
  return out;
}

/** 지형 가림은 이 거리(m)부터 본다 — 지형 격자(약 15m 칸) 두세 칸 안은 동 바닥 높이와 어긋나 믿지 않는다 */
const TERRAIN_NEAR = 40;

/** 창문 시점 — 좌우로 둘러볼 수 있는 범위(°)와 미리 재는 범위 */
const WIN_YAW = 50;
/** 가림 비율을 재는 가로 폭 상한 (°) — 넓은 가로 화면에서도 이만큼만 */
const WIN_SPAN_MAX = 80;
const WIN_RAY = WIN_YAW + WIN_SPAN_MAX / 2;

type Local = { x: number; z: number };

/**
 * 빨리 감기 재생 길이 — 실제 걷는 시간의 약 1/80, 6~14초.
 * 걷는 사람을 바꿔도 빨리 감기 배율은 같게: 기본 속도 기준 길이를 정한 뒤 걷는 사람 시간 비율만큼 늘이거나 줄인다.
 */
export const walkPlayMs = (baseSec: number, sec = baseSec) =>
  Math.max(6000, Math.min(14000, baseSec * 12)) * (sec / Math.max(1, baseSec));

/**
 * 걷는 사람 — 절차로 만든 저폴리 모형(외부 파일 없음). 캡슐·구로 둥글게, 어깨·팔꿈치·엉덩이·무릎·발목 관절.
 * 기준 키 1.72m로 만들고 걷는 사람 키에 맞춰 몸 전체를 줄이거나 늘린다.
 */
type WalkerRig = {
  root: THREE.Group;
  body: THREE.Group;
  torso: THREE.Group;
  hipL: THREE.Group;
  hipR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  ankleL: THREE.Group;
  ankleR: THREE.Group;
  shoulderL: THREE.Group;
  shoulderR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  ring: THREE.Mesh;
  look: WalkerLook;
};

const RIG_H = 1.72;
const HIP_Y = 0.89;
const THIGH = 0.42;
const SHIN = 0.4;

let walkerParts: {
  geos: THREE.BufferGeometry[];
  head: THREE.BufferGeometry;
  hair: THREE.BufferGeometry;
  torso: THREE.BufferGeometry;
  pelvis: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  foreArm: THREE.BufferGeometry;
  hand: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  foot: THREE.BufferGeometry;
  ring: THREE.BufferGeometry;
  ringMat: THREE.Material;
  mats: Map<number, THREE.Material>;
} | null = null;

function walkerKit() {
  if (walkerParts) return walkerParts;
  // 팔다리는 위 끝이 원점(관절)에 오게 내려 둔다. 캡슐 전체 길이 = 길이 + 2 × 반지름
  const cap = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 3, 10).translate(0, -(len / 2 + r), 0);
  const head = new THREE.SphereGeometry(0.115, 16, 12);
  const hair = new THREE.SphereGeometry(0.122, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.52).rotateX(-0.25);
  const torso = new THREE.CapsuleGeometry(0.16, 0.3, 4, 12).scale(1, 1, 0.66);
  const pelvis = new THREE.SphereGeometry(0.155, 12, 8).scale(1, 0.62, 0.72);
  const upperArm = cap(0.045, 0.2);
  const foreArm = cap(0.04, 0.17);
  const hand = new THREE.SphereGeometry(0.045, 8, 6);
  const thigh = cap(0.07, THIGH - 0.14);
  const shin = cap(0.055, SHIN - 0.11);
  // 둥근 신발 — 발목 아래 앞으로 길게
  const foot = new THREE.SphereGeometry(0.06, 10, 6).scale(0.95, 0.55, 2).translate(0, -0.035, 0.055);
  const ring = new THREE.RingGeometry(0.55, 0.85, 24).rotateX(-Math.PI / 2);
  walkerParts = {
    geos: [head, hair, torso, pelvis, upperArm, foreArm, hand, thigh, shin, foot, ring],
    head,
    hair,
    torso,
    pelvis,
    upperArm,
    foreArm,
    hand,
    thigh,
    shin,
    foot,
    ring,
    // 건물에 가려도 발밑 고리는 보이게 (위치 찾기용)
    ringMat: new THREE.MeshBasicMaterial({ color: 0x1d4ed8, depthTest: false, transparent: true, opacity: 0.85 }),
    mats: new Map(),
  };
  return walkerParts;
}

/** 걷는 사람 공유 자원 — 그룹을 비울 때 남긴다 */
function walkerShared(): unknown[] {
  const k = walkerParts;
  return k ? [...k.geos, k.ringMat, ...k.mats.values()] : [];
}

/** 색마다 한 재질 — transparent: 경로 선(투명 목록·깊이 검사 끔)보다 뒤에 그려 사람이 선 위에 보이게 (불투명도는 1 그대로) */
function walkerMat(color: number): THREE.Material {
  const k = walkerKit();
  let m = k.mats.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, transparent: true });
    k.mats.set(color, m);
  }
  return m;
}

function makeWalker(look: WalkerLook, elder: boolean): WalkerRig {
  const k = walkerKit();
  const skin = walkerMat(0xf3d3bd);
  const hairMat = walkerMat(elder ? 0xd6d6dc : 0x5b4a42);
  const shoe = walkerMat(0x5a6473);
  const shirt = walkerMat(look.shirt);
  const pants = walkerMat(look.pants);
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow = false) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.renderOrder = 6; // 경로 선 위에 그린다
    return m;
  };
  const pivot = (parent: THREE.Object3D, x: number, y: number, z = 0) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };
  const root = new THREE.Group();
  const s = look.heightM / RIG_H;
  const body = new THREE.Group();
  body.scale.setScalar(s);
  root.add(body);
  const w = look.build;

  // 골반·다리
  const pel = mesh(k.pelvis, pants, true);
  pel.position.y = HIP_Y + 0.04;
  pel.scale.x = w;
  body.add(pel);
  const leg = (side: number) => {
    const hip = pivot(body, side * 0.09 * w, HIP_Y);
    hip.add(mesh(k.thigh, pants, true));
    const knee = pivot(hip, 0, -THIGH);
    knee.add(mesh(k.shin, pants, true));
    const ankle = pivot(knee, 0, -SHIN);
    ankle.add(mesh(k.foot, shoe));
    return { hip, knee, ankle };
  };
  const L = leg(-1);
  const R = leg(1);

  // 몸통 — 허리를 축으로 (어르신은 조금 숙이고, 걸을 때 비튼다)
  const torso = pivot(body, 0, HIP_Y + 0.06);
  torso.rotation.x = look.stoop;
  const chest = mesh(k.torso, shirt, true);
  chest.position.y = 0.3;
  chest.scale.x = w;
  torso.add(chest);
  const neck = pivot(torso, 0, 0.6, look.stoop * 0.1);
  const head = mesh(k.head, skin, true);
  head.position.y = 0.13;
  head.scale.setScalar(look.head);
  neck.add(head);
  const hair = mesh(k.hair, hairMat);
  hair.position.y = 0.135;
  hair.scale.setScalar(look.head);
  neck.add(hair);
  const arm = (side: number) => {
    const shoulder = pivot(torso, side * 0.2 * w, 0.52);
    shoulder.rotation.z = side * 0.06;
    shoulder.add(mesh(k.upperArm, shirt));
    const elbow = pivot(shoulder, 0, -0.29);
    elbow.add(mesh(k.foreArm, skin));
    const hand = mesh(k.hand, skin);
    hand.position.y = -0.27;
    elbow.add(hand);
    return { shoulder, elbow };
  };
  const AL = arm(-1);
  const AR = arm(1);

  // 유모차 — 간단한 바구니·차양·손잡이·바퀴 (몸과 같은 비율, 몸 흔들림은 따라가지 않게 root에)
  if (look.stroller) {
    const cart = new THREE.Group();
    cart.scale.setScalar(s);
    root.add(cart);
    const frame = walkerMat(0x4b5563);
    const cloth = walkerMat(0x7fa8d8);
    const basket = mesh(new THREE.BoxGeometry(0.42, 0.3, 0.62), cloth, true);
    basket.position.set(0, 0.52, 0.72);
    cart.add(basket);
    const hood = mesh(new THREE.SphereGeometry(0.26, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.85, 0.9, 1), cloth, true);
    hood.position.set(0, 0.66, 0.56);
    hood.rotation.x = -0.35;
    cart.add(hood);
    const bar = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.48, 8).rotateZ(Math.PI / 2), frame);
    bar.position.set(0, 0.98, 0.3);
    cart.add(bar);
    for (const side of [-1, 1]) {
      const rod = mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.62, 6), frame);
      rod.position.set(side * 0.21, 0.72, 0.42);
      rod.rotation.x = -0.72;
      cart.add(rod);
      for (const z of [0.5, 0.95]) {
        const wheel = mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.04, 12).rotateZ(Math.PI / 2), frame);
        wheel.position.set(side * 0.2, 0.1, z);
        cart.add(wheel);
      }
    }
  }

  const ring = mesh(k.ring, k.ringMat);
  ring.position.y = 0.08;
  ring.renderOrder = 5;
  root.add(ring);
  return {
    root,
    body,
    torso,
    hipL: L.hip,
    hipR: R.hip,
    kneeL: L.knee,
    kneeR: R.knee,
    ankleL: L.ankle,
    ankleR: R.ankle,
    shoulderL: AL.shoulder,
    shoulderR: AR.shoulder,
    elbowL: AL.elbow,
    elbowR: AR.elbow,
    ring,
    look,
  };
}

/**
 * 걷는 자세 — phase(라디안, 2π = 두 걸음), swing 0이면 서 있는 자세.
 * 다리는 앞뒤로 엇갈리고 앞으로 나가는 다리는 무릎을 굽힌다. 팔은 반대 다리와 같이, 몸은 발이 모일 때 살짝 올라가고 좌우로 흔들린다.
 */
function poseWalker(w: WalkerRig, phase: number, swing: number) {
  const A = 0.42 * w.look.swing * swing;
  const sin = Math.sin(phase);
  const cos = Math.cos(phase);
  // 앞으로 = rotation.x 음수 (모형은 +z를 본다)
  w.hipL.rotation.x = -A * sin;
  w.hipR.rotation.x = A * sin;
  // 앞으로 내딛는 동안(다리가 앞으로 움직일 때) 무릎을 굽힌다
  const K = 0.95 * w.look.swing * swing;
  const kl = K * Math.max(0, cos) + 0.08 * swing;
  const kr = K * Math.max(0, -cos) + 0.08 * swing;
  w.kneeL.rotation.x = kl;
  w.kneeR.rotation.x = kr;
  w.ankleL.rotation.x = -kl * 0.35 + A * sin * 0.3;
  w.ankleR.rotation.x = -kr * 0.35 - A * sin * 0.3;
  if (w.look.stroller) {
    // 두 손으로 유모차 손잡이를 잡고 민다 — 팔은 앞으로 고정, 몸은 비틀지 않는다
    w.shoulderL.rotation.x = -0.62;
    w.shoulderR.rotation.x = -0.62;
    w.elbowL.rotation.x = -0.28;
    w.elbowR.rotation.x = -0.28;
    w.torso.rotation.y = 0;
  } else {
    const Aa = 0.5 * w.look.swing * swing;
    w.shoulderL.rotation.x = Aa * sin;
    w.shoulderR.rotation.x = -Aa * sin;
    w.elbowL.rotation.x = -(0.22 + 0.3 * swing * Math.max(0, -sin));
    w.elbowR.rotation.x = -(0.22 + 0.3 * swing * Math.max(0, sin));
    w.torso.rotation.y = 0.08 * swing * sin;
  }
  w.body.position.y = 0.035 * swing * (Math.abs(cos) - 0.6);
  w.body.rotation.z = 0.035 * swing * sin;
}

/**
 * 그룹 비우기 — 모양·재질을 GPU에서 내리고(keep에 든 공유 자원은 남김), CSS2D 이름표는 장면에서 빼도 화면에 남으니 요소도 지운다.
 */
function disposeGroup(g: THREE.Group, keep?: Set<unknown>) {
  g.traverse((o) => {
    if (o instanceof CSS2DObject) {
      o.element.remove();
      return;
    }
    const m = o as THREE.Mesh;
    if (m.geometry && !keep?.has(m.geometry)) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) if (!keep?.has(x)) x.dispose();
  });
  g.clear();
}

export class Complex3dScene {
  private renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private sun = new THREE.DirectionalLight(0xffffff, 1.6);
  private ambient = new THREE.HemisphereLight(0xffffff, 0xdfe7ee, 1.1);
  private ground: THREE.Mesh;
  private groups = {
    own: new THREE.Group(),
    floors: new THREE.Group(),
    types: new THREE.Group(),
    neighbors: new THREE.Group(),
    labels: new THREE.Group(),
    view: new THREE.Group(),
    pois: new THREE.Group(),
    walk: new THREE.Group(),
    facadeSun: new THREE.Group(),
  };
  private ownMeshes = new Map<string, THREE.Mesh>();
  private ownMaterial = new THREE.MeshStandardMaterial({ color: OWN, roughness: 0.85, metalness: 0 });
  private raycaster = new THREE.Raycaster();
  private data: Complex3d | null = null;
  private mPerLat = 111_320;
  private mPerLng = 111_320;
  private raf = 0;
  private selectedId: string | null = null;
  private mode: SceneMode = "base";
  private disposed = false;
  onSelect: (id: string | null) => void = () => {};
  /** 카메라가 북쪽에서 몇 도 돌아 있는지 (나침반용, 도) */
  onHeading: (deg: number) => void = () => {};
  private lastHeading = NaN;
  private labelsFar = false;
  /** 아래 시트가 가리는 높이(px) — 화면 중심을 그만큼 위로 올려 보이는 영역 가운데에 모형이 오게 */
  private insetTarget = 0;
  private inset = 0;
  private bounds = { radius: 150, maxH: 20, cx: 0, cz: 0, halfW: 100, halfD: 100 };
  private anim: { p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; start: number; ms: number } | null = null;

  constructor(private host: HTMLElement) {
    const w = host.clientWidth;
    const h = host.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0xf4f7f9);
    // 먼 곳은 하늘색으로 흐리게 — 넓은 바닥의 가장자리가 끊겨 보이지 않게
    this.scene.fog = new THREE.Fog(0xf4f7f9, FOG_NEAR, FOG_FAR);
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.setSize(w, h);
    Object.assign(this.labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    host.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 1, 14000);
    this.camera.position.set(220, 260, 320);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.minDistance = MIN_DIST;
    // 넓은 바닥(OUTER_GROUND_M) 가장자리가 보이지 않을 만큼만 멀어지게
    this.controls.maxDistance = MAX_DIST;

    this.sun.castShadow = true;
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -450;
    cam.right = cam.top = 450;
    cam.near = 1;
    cam.far = 2400;
    this.sun.shadow.mapSize.set(w < 640 ? 1024 : 2048, w < 640 ? 1024 : 2048);
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target, this.ambient);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 3000),
      new THREE.MeshStandardMaterial({ color: 0xf1f4f6, roughness: 1 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    const grid = new THREE.GridHelper(1200, 24, 0xdde3e8, 0xe8ecf0);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    this.scene.add(grid);
    this.grid = grid;
    for (const g of Object.values(this.groups)) this.scene.add(g);
    // 모드별 그룹을 처음부터 숨겨 둔다 (페이지가 모드를 넘기기 전 첫 화면에 주변 핀이 잠깐 보이지 않게)
    this.setMode(this.mode);

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointercancel", this.onPointerCancel);
    // 사용자가 직접 돌리면 진행 중인 이동은 멈춘다
    this.controls.addEventListener("start", () => {
      this.anim = null;
      // 따라가기 중에 직접 돌리면 따라가기를 끈다
      if (this.walkFollow) {
        // 따라가던 거리(약 30m)에서 그대로 이어 돌리게 — 40m 밖으로 나가면 loop에서 다시 40m로
        this.controls.minDistance = FOLLOW_MIN_DIST;
        this.walkFollow = false;
        this.onWalkFollow(false);
      }
    });
    this.setSun(new Date(), 14);
    this.loop();
  }

  private grid: THREE.GridHelper | null = null;
  private mapPlane: THREE.Mesh | null = null;
  private mapTex: THREE.Texture | null = null;
  private mapSize = 0;
  /** 지형 — 단지 중심 기준 상대 높이(m), n×n, 북쪽 행부터 */
  private terrain: { size: number; n: number; h: Float32Array; min: number; max: number } | null = null;

  /**
   * 바닥에 실제 지도 이미지를 깐다 — 단지 중심이 이미지 가운데, 한 변 sizeM 미터(웹 메르카토르라 가로·세로 축척 같음).
   * 지도가 뜨면 격자는 숨긴다. 그림자는 지도 위에 그대로 떨어진다. 지형이 있으면 지도가 지형을 따라 휜다.
   */
  /** 바닥 이미지 요청 차례 — 늦게 끝난 옛 요청(NAVER 지도)이 새 바닥(위성영상)을 덮지 않게 */
  private groundSeq = 0;

  /** 넓은 바닥 — 단지 둘레 몇 km 위성영상 (낮은 해상도). 자세한 바닥(setGroundMap) 밖을 채운다 */
  setOuterGround(url: string, sizeM: number) {
    new THREE.TextureLoader().load(url, (tex) => {
      if (this.disposed) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this.ground.geometry.dispose();
      this.ground.geometry = new THREE.PlaneGeometry(sizeM, sizeM);
      const old = this.ground.material as THREE.Material;
      this.ground.material = new THREE.MeshLambertMaterial({ map: tex });
      old.dispose();
      if (this.grid) this.grid.visible = false;
    });
  }

  setGroundMap(url: string, sizeM: number) {
    this.mapSize = sizeM;
    const seq = ++this.groundSeq;
    new THREE.TextureLoader().load(url, (tex) => {
      if (this.disposed || seq !== this.groundSeq) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this.mapTex?.dispose();
      this.mapTex = tex;
      this.buildGround();
      if (this.grid) this.grid.visible = false;
    });
  }

  /** 지형 격자를 받는다 — 바닥을 휘고, 동·주변 건물을 땅 높이에 올려 다시 짓는다 */
  /** 지형을 입혀 다시 지은 뒤 */
  onTerrain: () => void = () => {};
  private terrainSrc: TerrainGridPayload | null = null;

  setTerrain(t: TerrainGridPayload) {
    if (this.terrainSrc === t) return;
    this.terrainSrc = t;
    const bin = atob(t.heights);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const raw = new Int16Array(bytes.buffer, 0, t.n * t.n);
    const h = new Float32Array(t.n * t.n);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < h.length; i++) {
      h[i] = raw[i]! / 10;
      min = Math.min(min, h[i]!);
      max = Math.max(max, h[i]!);
    }
    this.terrain = { size: t.sizeM, n: t.n, h, min, max };
    if (!this.mapSize) this.mapSize = t.sizeM;
    this.buildGround();
    this.ground.position.y = Math.min(0, min) - 0.6;
    if (this.grid) this.grid.visible = false;
    if (this.data) this.rebuild();
    this.onTerrain();
  }

  /** 땅 높이 (지형 없으면 0) — 로컬 x(동), z(남) */
  groundAt(x: number, z: number): number {
    const t = this.terrain;
    if (!t) return 0;
    const f = (v: number) => Math.max(0, Math.min(t.n - 1.001, ((v + t.size / 2) / t.size) * (t.n - 1)));
    const fx = f(x);
    const fz = f(z);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const ax = fx - ix;
    const az = fz - iz;
    const v = (c: number, r: number) => t.h[r * t.n + c]!;
    return v(ix, iz) * (1 - ax) * (1 - az) + v(ix + 1, iz) * ax * (1 - az) + v(ix, iz + 1) * (1 - ax) * az + v(ix + 1, iz + 1) * ax * az;
  }

  private buildGround() {
    const size = this.mapSize || this.terrain?.size || 0;
    if (!size || (!this.mapTex && !this.terrain)) return;
    if (this.mapPlane) {
      this.scene.remove(this.mapPlane);
      this.mapPlane.geometry.dispose();
      (this.mapPlane.material as THREE.Material).dispose();
    }
    const t = this.terrain;
    const seg = t ? t.n - 1 : 1;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2); // 0번 행 = 북쪽(z = -size/2)
    if (t) {
      const pos = geo.attributes.position!;
      for (let i = 0; i < pos.count; i++) pos.setY(i, this.groundAt(pos.getX(i), pos.getZ(i)));
      geo.computeVertexNormals();
    }
    const plane = new THREE.Mesh(
      geo,
      new THREE.MeshLambertMaterial(this.mapTex ? { map: this.mapTex } : { color: 0xf1f4f6 }),
    );
    plane.position.y = 0.05;
    plane.receiveShadow = true;
    this.scene.add(plane);
    this.mapPlane = plane;
  }

  /** 외곽선 아래 가장 낮은 땅 높이 — 비탈에서도 건물이 뜨지 않게 (높은 쪽은 땅에 묻힌다) */
  private baseOf(rings: Ring[] | null): number {
    if (!this.terrain || !rings?.length) return 0;
    let min = Infinity;
    for (const [lng, lat] of rings[0] ?? []) {
      const p = this.toLocal(lng, lat);
      min = Math.min(min, this.groundAt(p.x, p.z));
    }
    const c = this.ringCenter(rings);
    min = Math.min(min, this.groundAt(c.x, c.z));
    return Number.isFinite(min) ? min : 0;
  }
  private baseById = new Map<string, number>();
  private base(id: string): number {
    return this.baseById.get(id) ?? 0;
  }

  private lastBands: FloorBand[] | null = null;
  private lastTypeColor: ((label: string) => string) | null = null;
  private lastPois: Poi3d[] | null = null;

  /** 지형이 늦게 도착했을 때 — 카메라는 그대로 두고 모두 다시 짓는다 */
  private rebuild() {
    if (!this.data) return;
    this.setData(this.data, true);
    this.setMode(this.mode);
    if (this.lastBands) this.setFloorBands(this.lastBands);
    if (this.lastTypeColor) this.setTypeColors(this.lastTypeColor);
    if (this.lastPois) this.setPois(this.lastPois);
    if (this.walkDraw) this.showWalk(this.walkDraw, this.walkReduced, false);
    this.paint();
    // 외벽 일조 — 땅 높이가 바뀌었으니 처음부터 다시
    this.refreshFacadeSun();
    // 창문 시점이면 땅 높이가 바뀐 동에 다시 선다
    if (this.win) this.onWindowInfo(this.enterWindowView(this.win.id, this.win.floor, true)!);
  }

  private toLocal(lng: number, lat: number): Local {
    const c = this.data!.center;
    return { x: (lng - c.lng) * this.mPerLng, z: -(lat - c.lat) * this.mPerLat };
  }

  private extrude(rings: Ring[], from: number, to: number): THREE.BufferGeometry | null {
    const geos: THREE.BufferGeometry[] = [];
    for (const ring of rings) {
      if (ring.length < 4) continue;
      const shape = new THREE.Shape(
        ring.map(([lng, lat]) => {
          const p = this.toLocal(lng, lat);
          return new THREE.Vector2(p.x, -p.z);
        }),
      );
      const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.5, to - from), bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      g.translate(0, from, 0);
      geos.push(g);
    }
    if (!geos.length) return null;
    return geos.length === 1 ? geos[0]! : mergeGeometries(geos);
  }

  setData(data: Complex3d, keepCamera = false) {
    this.data = data;
    this.mPerLng = 111_320 * Math.cos((data.center.lat * Math.PI) / 180);
    // 다시 지을 때 (지형이 늦게 오면) 이전 모양·재질과 이름표 요소를 버린다 — 함께 쓰는 재질·사람 모형은 남긴다
    const keep = new Set<unknown>([
      this.ownMaterial,
      this.hiMaterial,
      this.dimMaterial,
      this.facadeSunMat,
      this.walkLineMat,
      this.walkCaseMat,
      ...walkerShared(),
    ]);
    for (const g of Object.values(this.groups)) disposeGroup(g, keep);
    this.walker = null;
    this.ownMeshes.clear();
    this.labelEls.clear();
    this.baseById.clear();
    this.prisms = null;
    for (const b of data.buildings) this.baseById.set(b.id, this.baseOf(b.rings));

    // 우리 단지 동
    const edgeMat = new THREE.LineBasicMaterial({ color: OWN_EDGE, transparent: true, opacity: 0.55 });
    let maxH = 20;
    for (const b of data.buildings) {
      if (!b.rings) continue;
      const { h } = buildingHeight(b);
      maxH = Math.max(maxH, h);
      const y0 = this.base(b.id);
      const geo = this.extrude(b.rings, y0, y0 + h);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, this.ownMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.id = b.id;
      this.ownMeshes.set(b.id, mesh);
      this.groups.own.add(mesh);
      this.groups.own.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), edgeMat));
      // 동 라벨
      if (b.dong) {
        const el = document.createElement("div");
        el.textContent = b.dong;
        el.className = "complex3d-label";
        const c = this.ringCenter(b.rings);
        const obj = new CSS2DObject(el);
        obj.position.set(c.x, y0 + h + 4, c.z);
        this.groups.labels.add(obj);
        this.labelEls.set(b.id, { el, x: c.x, y: y0 + h + 4, z: c.z });
      }
    }

    // 주변 건물 — 한 덩어리로 합쳐 가볍게 (그림자·조망 계산에 쓴다)
    const neighborGeos: THREE.BufferGeometry[] = [];
    for (const n of data.neighbors) {
      const { h } = buildingHeight(n);
      const y0 = this.baseOf(n.rings);
      const g = this.extrude(n.rings, y0, y0 + h);
      if (g) neighborGeos.push(g.index ? g.toNonIndexed() : g);
    }
    if (neighborGeos.length) {
      const merged = mergeGeometries(neighborGeos);
      if (merged) {
        const mesh = new THREE.Mesh(
          merged,
          new THREE.MeshStandardMaterial({ color: NEIGHBOR, roughness: 0.95, transparent: true, opacity: 0.9 }),
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.groups.neighbors.add(mesh);
      }
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const b of data.buildings) {
      for (const [lng, lat] of (b.rings ?? []).flat()) {
        const p = this.toLocal(lng, lat);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
    }
    if (!Number.isFinite(minX)) minX = maxX = minZ = maxZ = 0;
    const halfW = Math.max(40, (maxX - minX) / 2);
    const halfD = Math.max(40, (maxZ - minZ) / 2);
    this.bounds = { radius: Math.hypot(halfW, halfD), maxH, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, halfW, halfD };
    if (keepCamera) return;
    const home = this.homeView();
    this.controls.target.copy(home.target);
    this.camera.position.copy(home.position);
    this.controls.update();
  }

  /** 단지 전체가 화면에 들어오는 시점 — 남쪽 위에서 비스듬히, 화면 비율(세로 모바일)까지 맞춰 거리 계산 */
  private homeView(): { position: THREE.Vector3; target: THREE.Vector3 } {
    const { maxH, cx, cz, halfW, halfD } = this.bounds;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const polar = (48 * Math.PI) / 180;
    const azimuth = (15 * Math.PI) / 180;
    // 가로는 단지 폭, 세로는 기울어진 깊이 + 건물 높이가 화면에 들어오게 (여백 약 20%).
    // 동이 몇 개뿐인 작은 단지도 주변이 보이게 반경 최소 110m로 잡는다 (너무 확대되지 않게)
    const hw = Math.max(halfW, 110);
    const hd = Math.max(halfD, 110);
    const needW = hw / Math.tan(hfov / 2);
    const needH = (hd * Math.cos(polar) + maxH * Math.sin(polar) * 0.5) / Math.tan(vfov / 2);
    const dist = Math.min(this.controls.maxDistance, Math.max(260, Math.max(needW, needH) * 1.2));
    const target = new THREE.Vector3(cx, this.groundAt(cx, cz) + maxH * 0.25, cz);
    const position = new THREE.Vector3(
      target.x + dist * Math.sin(polar) * Math.sin(azimuth),
      target.y + dist * Math.cos(polar),
      target.z + dist * Math.sin(polar) * Math.cos(azimuth),
    );
    return { position, target };
  }

  /** ms가 0이면 바로 옮긴다 (움직임 줄이기) */
  private flyTo(position: THREE.Vector3, target: THREE.Vector3, ms = 450) {
    if (ms <= 0) {
      this.anim = null;
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
      return;
    }
    this.anim = {
      p0: this.camera.position.clone(),
      p1: position,
      t0: this.controls.target.clone(),
      t1: target,
      start: performance.now(),
      ms,
    };
  }

  /** 처음 시점으로 */
  resetView() {
    const home = this.homeView();
    this.flyTo(home.position, home.target);
  }

  /** 위에서 내려다보기 (북쪽이 위) */
  topView() {
    const { cx, cz, halfW, halfD } = this.bounds;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = Math.min(this.controls.maxDistance, Math.max(halfW / Math.tan(hfov / 2), halfD / Math.tan(vfov / 2)) * 1.1);
    const gy = this.groundAt(cx, cz);
    const target = new THREE.Vector3(cx, gy, cz);
    this.flyTo(new THREE.Vector3(cx, gy + dist, cz + 0.01), target);
  }

  /** 지금 기울기·거리 그대로 북쪽이 화면 위로 */
  northUp() {
    const t = this.controls.target.clone();
    const off = this.camera.position.clone().sub(t);
    const flat = Math.hypot(off.x, off.z);
    this.flyTo(new THREE.Vector3(t.x, t.y + off.y, t.z + Math.max(0.01, flat)), t);
  }

  /** 동 하나로 다가가기 — 지금 보는 방향은 유지 (reduced면 날아가지 않고 바로) */
  focus(id: string, reduced = false) {
    const b = this.data?.buildings.find((x) => x.id === id);
    if (!b?.rings) return;
    const c = this.ringCenter(b.rings);
    const { h } = buildingHeight(b);
    // 동 꼭대기보다 위를 보며(바닥이 화면 아래쪽으로 더 내려가게), 지금 방위는 유지하고 위에서 비스듬히(천정에서 50°) — 옆 동까지 조금 보이게 여유 있게
    const target = new THREE.Vector3(c.x, this.base(id) + h * 1.1 + 8, c.z);
    const off = this.camera.position.clone().sub(this.controls.target);
    const az = Math.atan2(off.x, off.z);
    const polar = (50 * Math.PI) / 180;
    // 아래 패널이 화면을 가리면 보이는 높이가 줄어드니 그만큼 멀리서
    const visible = Math.max(0.35, 1 - this.insetTarget / Math.max(1, this.host.clientHeight));
    const dist = Math.max(240, h * 5.5) / visible;
    const dir = new THREE.Vector3(Math.sin(polar) * Math.sin(az), Math.cos(polar), Math.sin(polar) * Math.cos(az));
    this.flyTo(target.clone().add(dir.multiplyScalar(dist)), target, reduced ? 0 : 450);
  }

  private ringCenter(rings: Ring[]): Local {
    let x = 0;
    let z = 0;
    let n = 0;
    for (const [lng, lat] of rings[0] ?? []) {
      const p = this.toLocal(lng, lat);
      x += p.x;
      z += p.z;
      n++;
    }
    return { x: x / Math.max(1, n), z: z / Math.max(1, n) };
  }

  /** 모드 바꾸기 — 층별 시세 색칠·조망 부채꼴·주변 핀은 각 모드에서만 보인다 */
  setMode(mode: SceneMode) {
    this.mode = mode;
    this.groups.walk.visible = mode === "walk";
    this.groups.facadeSun.visible = mode === "sun" && this.facadeSun.on;
    this.groups.floors.visible = mode === "floors";
    this.groups.types.visible = mode === "types";
    this.groups.own.visible = mode !== "floors" && mode !== "types";
    this.groups.view.visible = mode === "view" && !this.win;
    this.groups.pois.visible = mode === "around";
    this.groups.labels.visible = mode !== "around";
    this.applyWalkXray();
  }

  /**
   * 걷기 모드에서는 건물을 반투명하게 — 경로·걷는 사람이 건물 뒤로 가도 가려지지 않게.
   * 재질마다 원래 값을 기억해 두었다가 다른 모드에서 되돌린다 (재질을 여러 동이 함께 써도 안전).
   */
  private applyWalkXray() {
    const on = this.mode === "walk";
    const seen = new Set<THREE.Material>();
    for (const g of [this.groups.own, this.groups.neighbors]) {
      g.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          if (!m || seen.has(m)) continue;
          seen.add(m);
          const ud = m.userData as { xray?: { transparent: boolean; opacity: number; depthWrite: boolean } };
          if (on) {
            if (!ud.xray) ud.xray = { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite };
            m.transparent = true;
            m.opacity = Math.min(ud.xray.opacity, 0.38);
            m.depthWrite = false;
          } else if (ud.xray) {
            m.transparent = ud.xray.transparent;
            m.opacity = ud.xray.opacity;
            m.depthWrite = ud.xray.depthWrite;
            delete ud.xray;
          }
          m.needsUpdate = true;
        }
      });
    }
  }

  /** 층별 시세 — 각 동을 저·중·고 구간으로 잘라 구간 평당가에 따라 색을 입힌다 */
  setFloorBands(bands: FloorBand[]) {
    this.lastBands = bands;
    disposeGroup(this.groups.floors);
    if (!this.data) return;
    const prices = bands.map((b) => b.perPyeong).filter((v): v is number => v != null);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const color = (v: number | null) => {
      if (v == null) return new THREE.Color(0xd5dbe1);
      const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
      return new THREE.Color(0xcfeeee).lerp(new THREE.Color(TEAL_DARK), 0.15 + t * 0.85);
    };
    for (const b of this.data.buildings) {
      if (!b.rings) continue;
      const { h } = buildingHeight(b);
      const floors = b.floors ?? Math.max(1, Math.round(h / FLOOR_M));
      const perFloor = h / floors;
      for (const band of bands) {
        if (band.fromFloor > floors) continue;
        const from = this.base(b.id) + (band.fromFloor - 1) * perFloor;
        const to = this.base(b.id) + Math.min(band.toFloor, floors) * perFloor;
        const geo = this.extrude(b.rings, from, to);
        if (!geo) continue;
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: color(band.perPyeong), roughness: 0.8 }));
        mesh.castShadow = true;
        mesh.userData.id = b.id;
        this.groups.floors.add(mesh);
      }
    }
  }

  /** 평형 — 각 동을 주력 평형 색으로 (colorOf: 평형 이름 → 색). 평형 정보가 없는 동은 회색 */
  setTypeColors(colorOf: (label: string) => string) {
    this.lastTypeColor = colorOf;
    disposeGroup(this.groups.types);
    if (!this.data) return;
    for (const b of this.data.buildings) {
      if (!b.rings) continue;
      const { h } = buildingHeight(b);
      const geo = this.extrude(b.rings, this.base(b.id), this.base(b.id) + h);
      if (!geo) continue;
      const dom = dominantUnit(b);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: dom ? colorOf(dom.label) : "#d5dbe1", roughness: 0.8 }),
      );
      mesh.castShadow = true;
      mesh.userData.id = b.id;
      this.groups.types.add(mesh);
    }
  }

  /** 해 위치 — date: 날짜(연·월·일만 씀), hour: KST 시각 */
  setSun(date: Date, hour: number): { altitude: number; azimuth: number } {
    const c = this.data?.center ?? { lat: 37.5, lng: 127 };
    const p = sunPosition(c.lat, c.lng, date, hour);
    const r = 900;
    const up = Math.max(0.02, Math.sin(p.altitude));
    this.sun.position.set(Math.sin(p.azimuth) * Math.cos(p.altitude) * r, up * r, -Math.cos(p.azimuth) * Math.cos(p.altitude) * r);
    this.sun.intensity = p.altitude > 0 ? 1.6 : 0.05;
    return p;
  }

  setShadows(on: boolean) {
    this.sun.castShadow = on;
  }

  /** 조망 — 고른 동의 floor층 눈높이에서 72방향으로 가장 가까운 건물까지 거리 */
  computeView(buildingId: string, floor: number): ViewResult | null {
    if (!this.data) return null;
    const b = this.data.buildings.find((x) => x.id === buildingId);
    if (!b?.rings) return null;
    const { h } = buildingHeight(b);
    const floors = b.floors ?? Math.max(1, Math.round(h / FLOOR_M));
    const eyeY = this.base(buildingId) + Math.min(h - 1, ((floor - 0.5) * h) / floors) + 1.2;
    const c = this.ringCenter(b.rings);
    const targets: THREE.Object3D[] = [...this.groups.neighbors.children];
    for (const [id, mesh] of this.ownMeshes) if (id !== buildingId) targets.push(mesh);
    const self = this.ownMeshes.get(buildingId);
    const rays: ViewResult["rays"] = [];
    const MAX = 500;
    for (let i = 0; i < 72; i++) {
      const az = (i * 5 * Math.PI) / 180;
      const dir = new THREE.Vector3(Math.sin(az), 0, -Math.cos(az));
      // 자기 동 벽 밖에서 출발
      let start = new THREE.Vector3(c.x, eyeY, c.z);
      if (self) {
        this.raycaster.set(start, dir);
        this.raycaster.far = 200;
        const own = this.raycaster.intersectObject(self, false);
        if (own[0]) start = own[0].point.clone().add(dir.clone().multiplyScalar(0.5));
      }
      this.raycaster.set(start, dir);
      this.raycaster.far = MAX;
      const hit = this.raycaster.intersectObjects(targets, false)[0];
      rays.push({ azimuth: i * 5, distance: hit ? Math.round(hit.distance) : null });
    }
    // 부채꼴 그리기 — 이전 부채꼴 72개의 모양·재질은 버린다 (층을 바꿀 때마다 다시 그린다)
    disposeGroup(this.groups.view);
    for (const r of rays) {
      const d = r.distance ?? MAX;
      const a0 = ((r.azimuth - 2.5) * Math.PI) / 180;
      const a1 = ((r.azimuth + 2.5) * Math.PI) / 180;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(c.x, eyeY, c.z),
        new THREE.Vector3(c.x + Math.sin(a0) * d, eyeY, c.z - Math.cos(a0) * d),
        new THREE.Vector3(c.x + Math.sin(a1) * d, eyeY, c.z - Math.cos(a1) * d),
      ]);
      const open = r.distance == null || r.distance >= 200;
      const mat = new THREE.MeshBasicMaterial({
        color: open ? 0x0ea5e9 : r.distance! >= 80 ? 0xf59e0b : 0xef4444,
        transparent: true,
        opacity: open ? 0.28 : 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.groups.view.add(new THREE.Mesh(geo, mat));
    }
    const openShare = rays.filter((r) => r.distance == null || r.distance >= 200).length / rays.length;
    return { rays, openShare };
  }

  /** 주변 — 단지와 표시한 학교·역이 모두 들어오게 위에서 비스듬히 */
  fitPois() {
    if (!this.data) return;
    const { cx, cz, halfW, halfD } = this.bounds;
    let minX = cx - halfW;
    let maxX = cx + halfW;
    let minZ = cz - halfD;
    let maxZ = cz + halfD;
    for (const q of this.data.pois) {
      const l = this.toLocal(q.lng, q.lat);
      if (Math.hypot(l.x, l.z) > 900) continue;
      minX = Math.min(minX, l.x);
      maxX = Math.max(maxX, l.x);
      minZ = Math.min(minZ, l.z);
      maxZ = Math.max(maxZ, l.z);
    }
    const hw = (maxX - minX) / 2 + 30;
    const hd = (maxZ - minZ) / 2 + 30;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const polar = (30 * Math.PI) / 180;
    const visible = Math.max(0.35, 1 - this.insetTarget / Math.max(1, this.host.clientHeight));
    const dist = Math.min(this.controls.maxDistance, (Math.max(hw / Math.tan(hfov / 2), (hd * Math.cos(polar)) / (Math.tan(vfov / 2) * visible)) * 1.25));
    const target = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    target.y = this.groundAt(target.x, target.z);
    this.flyTo(new THREE.Vector3(target.x, target.y + dist * Math.cos(polar), target.z + dist * Math.sin(polar)), target, 550);
  }

  /**
   * 일조 시간 — 고른 동의 정면(긴 변 중 남쪽을 향한 벽) 가운데, floor층 창 높이에서 7~18시를 10분마다 해 쪽으로 광선을 쏴
   * 다른 건물(단지 동·주변 건물)에 막히지 않으면 해가 드는 것으로 센다. 해가 벽 뒤쪽이면 들지 않는 것으로 본다.
   */
  computeSunHours(buildingId: string, floor: number, date: Date): SunHours | null {
    if (!this.data) return null;
    const b = this.data.buildings.find((x) => x.id === buildingId);
    if (!b?.rings?.[0]) return null;
    const pts = b.rings[0].map(([lng, lat]) => this.toLocal(lng, lat));
    const mx = pts.reduce((a, q) => a + q.x, 0) / pts.length;
    const mz = pts.reduce((a, q) => a + q.z, 0) / pts.length;
    let sxx = 0, szz = 0, sxz = 0;
    for (const q of pts) {
      sxx += (q.x - mx) ** 2;
      szz += (q.z - mz) ** 2;
      sxz += (q.x - mx) * (q.z - mz);
    }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    // 정면 = 긴 축에 수직, 남쪽(z+) 쪽
    let nx = -Math.sin(ang);
    let nz = Math.cos(ang);
    if (nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const face = Math.max(...pts.map((q) => (q.x - mx) * nx + (q.z - mz) * nz));
    const { h } = buildingHeight(b);
    const floors = b.floors ?? Math.max(1, Math.round(h / FLOOR_M));
    const y = this.base(buildingId) + Math.min(h - 0.5, ((Math.min(floor, floors) - 0.5) * h) / floors);
    const origin = new THREE.Vector3(mx + nx * (face + 0.6), y, mz + nz * (face + 0.6));
    const targets: THREE.Object3D[] = [...this.groups.neighbors.children];
    for (const [id, mesh] of this.ownMeshes) if (id !== buildingId) targets.push(mesh);
    const c = this.data.center;
    const slots: Array<boolean | null> = [];
    for (let m = 7 * 60; m < 18 * 60; m += 10) {
      const sp = sunPosition(c.lat, c.lng, date, (m + 5) / 60);
      if (sp.altitude <= 0.01) {
        slots.push(null);
        continue;
      }
      const dir = new THREE.Vector3(Math.sin(sp.azimuth) * Math.cos(sp.altitude), Math.sin(sp.altitude), -Math.cos(sp.azimuth) * Math.cos(sp.altitude));
      if (dir.x * nx + dir.z * nz <= 0) {
        slots.push(false);
        continue;
      }
      this.raycaster.set(origin, dir);
      this.raycaster.far = 1500;
      slots.push(this.raycaster.intersectObjects(targets, false).length === 0 && !this.terrainBlocks(origin.x, origin.y, origin.z, dir, this.base(buildingId)));
    }
    const totalMin = slots.filter((x) => x === true).length * 10;
    let best = 0;
    let run = 0;
    slots.forEach((x, i) => {
      const t = 7 * 60 + i * 10;
      if (x === true && t >= 9 * 60 && t < 15 * 60) {
        run += 10;
        best = Math.max(best, run);
      } else run = 0;
    });
    return { totalMin, best9to15Min: best, slots };
  }

  /**
   * 땅(언덕·산)이 햇빛을 막는지 — 해 쪽으로 8m마다 지형 높이와 광선 높이를 비교한다.
   * 지형 격자는 약 15m 칸이라 동 바로 옆 땅 높이는 거칠다 (비탈에서는 동 바닥보다 10m 넘게 높게 나오기도 한다).
   * 그래서 가까운 TERRAIN_NEAR m 안은 보지 않고(가까운 가림은 건물 광선이 맡는다), 출발 높이는 동 바닥(base) 기준 높이를
   * 제자리 격자 땅에 얹어 잰다 (격자 땅이 바닥보다 높으면 그만큼 올림) — 모형에서 땅에 묻힌 낮은 층이 격자 오차 때문에
   * 0시간이 되지 않고, 층마다 높이 차이는 그대로 남는다. 광선이 지형 최고점보다 높아지거나 격자 밖으로 나가면 그만둔다.
   */
  private terrainBlocks(ox: number, oy: number, oz: number, dir: { x: number; y: number; z: number }, base: number): boolean {
    const t = this.terrain;
    if (!t) return false;
    const h = Math.hypot(dir.x, dir.z);
    if (h < 1e-6) return false;
    const ux = dir.x / h;
    const uz = dir.z / h;
    const slope = dir.y / h;
    const half = t.size / 2;
    const y0 = oy + Math.max(0, this.groundAt(ox, oz) - base);
    for (let s = TERRAIN_NEAR; s < 1500; s += 8) {
      const y = y0 + slope * s;
      if (y > t.max) return false;
      const x = ox + ux * s;
      const z = oz + uz * s;
      if (Math.abs(x) > half || Math.abs(z) > half) return false;
      if (this.groundAt(x, z) > y) return true;
    }
    return false;
  }

  // ── 외벽 일조 색칠 ────────────────────────────────────────────────────────
  /** 몇 동까지 계산했는지 (done === total이면 끝) */
  onFacadeSunProgress: (p: FacadeSunProgress) => void = () => {};
  private emitFacadeSun() {
    const f = this.facadeSun;
    this.onFacadeSunProgress({
      on: f.on,
      done: f.total - f.queue.length - (f.job ? 1 : 0),
      total: f.total,
      selected: this.selectedId ? this.facadeSunOf(this.selectedId) : null,
    });
  }
  private prisms: Prism[] | null = null;
  private facadeSun: {
    on: boolean;
    key: string;
    date: Date | null;
    /** 계절 → 동 → 계산 결과 */
    cache: Map<string, Map<string, FacadeSunCells>>;
    queue: string[];
    total: number;
    /** 하루 10분 간격 해 방향 (date가 바뀔 때만 다시) */
    suns: Array<THREE.Vector3 | null>;
    /** 계산 중인 동 — 외벽 구간(si)마다 나눠 한 화면에 조금씩 */
    job: { id: string; cells: FacadeSunCells; si: number } | null;
  } = { on: false, key: "", date: null, cache: new Map(), queue: [], total: 0, suns: [], job: null };

  /** 단지 동·주변 건물을 기둥(외곽선 × 바닥~지붕)으로 — 햇빛 광선 검사용 */
  private getPrisms(): Prism[] {
    if (this.prisms) return this.prisms;
    const out: Prism[] = [];
    if (this.data) {
      const loc = (rings: Ring[]) => rings.map((r) => r.map(([lng, lat]) => this.toLocal(lng, lat)));
      for (const b of this.data.buildings) {
        if (!b.rings) continue;
        const y0 = this.base(b.id);
        const p = makePrism(b.id, loc(b.rings), y0, y0 + buildingHeight(b).h);
        if (p) out.push(p);
      }
      for (const n of this.data.neighbors) {
        const y0 = this.baseOf(n.rings);
        const p = makePrism(n.id, loc(n.rings), y0, y0 + buildingHeight(n).h);
        if (p) out.push(p);
      }
    }
    this.prisms = out;
    return out;
  }

  /**
   * 외벽 일조 색칠 켜기·끄기 — date의 하루(7~18시, 10분 간격) 해 드는 시간을 동마다 3개 층 구간 × 외벽 구간별로 계산해
   * 벽에 색을 입힌다. 계산은 한 화면에 8ms씩 나눠서 (휴대폰에서도 끊기지 않게), 결과는 계절별로 기억한다.
   */
  setFacadeSun(on: boolean, date: Date | null, key: string) {
    const f = this.facadeSun;
    if (!on || !date || !this.data) {
      const was = f.on;
      f.on = false;
      f.queue = [];
      f.job = null;
      this.groups.facadeSun.visible = false;
      if (was) this.emitFacadeSun();
      return;
    }
    if (f.on && f.key === key) return;
    f.on = true;
    f.key = key;
    f.date = date;
    f.suns = sunDirs(this.data.center, date);
    f.job = null;
    this.clearFacadeSunMeshes();
    const cache = f.cache.get(key) ?? new Map<string, FacadeSunCells>();
    f.cache.set(key, cache);
    const t = this.controls.target;
    const ids = this.data.buildings
      .filter((b) => b.rings && (b.residential || b.dong))
      .map((b) => {
        const c = this.ringCenter(b.rings!);
        return { id: b.id, d: b.id === this.selectedId ? -1 : Math.hypot(c.x - t.x, c.z - t.z) };
      })
      .sort((a, b) => a.d - b.d)
      .map((x) => x.id);
    f.queue = [];
    for (const id of ids) {
      const cells = cache.get(id);
      if (cells) this.addFacadeSunMesh(id, cells);
      else f.queue.push(id);
    }
    f.total = ids.length;
    this.groups.facadeSun.visible = this.mode === "sun";
    this.emitFacadeSun();
  }

  /** 지형이 늦게 와 건물 높이가 바뀌면 — 기억한 결과를 버리고 켜져 있으면 다시 */
  private refreshFacadeSun() {
    const f = this.facadeSun;
    f.cache.clear();
    this.clearFacadeSunMeshes();
    if (!f.on) return;
    f.on = false;
    this.setFacadeSun(true, f.date, f.key);
  }

  private clearFacadeSunMeshes() {
    for (const o of this.groups.facadeSun.children) (o as THREE.Mesh).geometry?.dispose();
    this.groups.facadeSun.clear();
  }

  private facadeSunMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  /**
   * 한 화면에 쓰는 계산 시간 — 휴대폰(좁은 화면)은 4ms, 넓은 화면은 8ms. 한 동을 통째로 하지 않고 외벽 구간 하나씩
   * (가장 무거운 동도 구간 하나는 1ms 안팎) 나눠, 예산을 넘기면 다음 화면으로 넘긴다.
   */
  private stepFacadeSun() {
    const f = this.facadeSun;
    if (!f.on || (!f.queue.length && !f.job) || this.mode !== "sun" || !f.date) return;
    const t0 = performance.now();
    const budget = this.host.clientWidth < 640 ? 4 : 8;
    const cache = f.cache.get(f.key)!;
    while (performance.now() - t0 < budget) {
      if (!f.job) {
        const id = f.queue.shift();
        if (!id) break;
        const cells = this.prepareFacadeSun(id);
        if (!cells) {
          // 칠할 외벽이 없는 동도 빈 결과로 기억해 다시 계산하지 않는다
          cache.set(id, { base: 0, segs: [], bands: [] });
          continue;
        }
        f.job = { id, cells, si: 0 };
      }
      const j = f.job;
      this.computeFacadeSeg(j.cells, j.si, f.suns);
      j.si++;
      if (j.si >= j.cells.segs.length) {
        cache.set(j.id, j.cells);
        this.addFacadeSunMesh(j.id, j.cells);
        f.job = null;
      }
    }
    this.emitFacadeSun();
  }

  /**
   * 한 동 — 바깥쪽이 정면(해 드는 쪽)을 향한 외벽 변을 약 15m 구간으로 나눠(동마다 최대 12구간) 구간 가운데 벽 밖 0.6m,
   * 3개 층마다 가운데 층 창 높이(바닥 + 1.2m)에서 10분마다 해 쪽으로 광선을 쏜다. 해가 그 벽 뒤쪽이면 들지 않는 것으로 본다.
   * 여기서는 구간·층 구간만 잡고, 시간 계산은 computeFacadeSeg가 구간마다.
   */
  private prepareFacadeSun(id: string): FacadeSunCells | null {
    const fa = this.facadeOf(id);
    const fb = this.floorBase(id, 1);
    if (!fa || !fb) return null;
    const edges = fa.edges.filter((e) => e.dot > 0.3 && e.len >= 3).sort((a, b) => b.len - a.len);
    const segs: FacadeSunCells["segs"] = [];
    for (const e of edges) {
      const k = Math.max(1, Math.min(4, Math.round(e.len / 15)));
      for (let i = 0; i < k && segs.length < 12; i++) {
        const t0 = i / k;
        const t1 = (i + 1) / k;
        segs.push({
          x0: e.ax + (e.bx - e.ax) * t0,
          z0: e.az + (e.bz - e.az) * t0,
          x1: e.ax + (e.bx - e.ax) * t1,
          z1: e.az + (e.bz - e.az) * t1,
          ox: e.ox,
          oz: e.oz,
        });
      }
    }
    if (!segs.length) return null;
    const bands: FacadeSunCells["bands"] = [];
    for (let f0 = 1; f0 <= fb.floors; f0 += 3) {
      const f1 = Math.min(fb.floors, f0 + 2);
      const mid = Math.round((f0 + f1) / 2);
      bands.push({
        from: f0,
        to: f1,
        y0: fb.y + (f0 - 1) * fb.perFloor,
        y1: fb.y + f1 * fb.perFloor,
        ys: fb.y + (mid - 1) * fb.perFloor + Math.min(1.2, fb.perFloor * 0.4),
        hours: [],
      });
    }
    return { base: this.base(id), segs, bands };
  }

  /** 외벽 구간 하나(si)의 층 구간별 하루 해 드는 시간 */
  private computeFacadeSeg(cells: FacadeSunCells, si: number, suns: Array<THREE.Vector3 | null>) {
    const sg = cells.segs[si]!;
    const sx = (sg.x0 + sg.x1) / 2 + sg.ox * 0.6;
    const sz = (sg.z0 + sg.z1) / 2 + sg.oz * 0.6;
    const front = prismsInFront(this.getPrisms(), sx, sz, sg.ox, sg.oz);
    for (const band of cells.bands) {
      let lit = 0;
      for (const d of suns) {
        if (!d || d.x * sg.ox + d.z * sg.oz <= 0) continue;
        if (sunBlocked(sx, band.ys, sz, d.x, d.y, d.z, front)) continue;
        if (this.terrainBlocks(sx, band.ys, sz, d, cells.base)) continue;
        lit++;
      }
      band.hours[si] = (lit * 10) / 60;
    }
  }

  private addFacadeSunMesh(id: string, cells: FacadeSunCells) {
    if (!cells.segs.length) return;
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    const off = 0.15;
    cells.segs.forEach((sg, si) => {
      const ax = sg.x0 + sg.ox * off;
      const az = sg.z0 + sg.oz * off;
      const bx = sg.x1 + sg.ox * off;
      const bz = sg.z1 + sg.oz * off;
      for (const band of cells.bands) {
        c.set(facadeSunColor(band.hours[si] ?? 0));
        // 구간 사이가 보이게 위아래 0.15m씩 틈
        const y0 = band.y0 + 0.15;
        const y1 = band.y1 - 0.15;
        pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
        for (let k = 0; k < 6; k++) col.push(c.r, c.g, c.b);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo, this.facadeSunMat);
    mesh.userData.id = id;
    this.groups.facadeSun.add(mesh);
  }

  /** 고른 동의 외벽 일조 — 층 구간별 정면 가장 긴 벽(구간 평균)과 모든 외벽 구간 중 최소·최대 (없으면 null) */
  facadeSunOf(id: string): FacadeSunProgress["selected"] {
    const f = this.facadeSun;
    const cells = f.on ? f.cache.get(f.key)?.get(id) : null;
    if (!cells?.segs.length) return null;
    // segs는 긴 변부터 — 첫 변에서 나온 구간들(같은 법선)이 정면 가장 긴 벽
    const s0 = cells.segs[0]!;
    const main = cells.segs.map((g, i) => (g.ox === s0.ox && g.oz === s0.oz ? i : -1)).filter((i) => i >= 0);
    return cells.bands.map((b) => ({
      from: b.from,
      to: b.to,
      main: main.reduce((a, i) => a + b.hours[i]!, 0) / main.length,
      min: Math.min(...b.hours),
      max: Math.max(...b.hours),
    }));
  }

  /** 주변 학교·역 핀 */
  setPois(pois: Poi3d[]) {
    this.lastPois = pois;
    disposeGroup(this.groups.pois);
    if (!this.data) return;
    for (const p of pois) {
      const l = this.toLocal(p.lng, p.lat);
      if (Math.hypot(l.x, l.z) > 900) continue;
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.8, 0.8, 30, 8),
        new THREE.MeshBasicMaterial({ color: p.kind === "station" ? 0x2563eb : 0xd97706 }),
      );
      const gy = this.groundAt(l.x, l.z);
      pole.position.set(l.x, gy + 15, l.z);
      this.groups.pois.add(pole);
      const el = document.createElement("div");
      el.className = `complex3d-pin complex3d-pin--${p.kind}`;
      el.textContent = `${p.name} · ${p.distanceM.toLocaleString("ko-KR")}m`;
      const obj = new CSS2DObject(el);
      obj.position.set(l.x, gy + 34, l.z);
      this.groups.pois.add(obj);
    }
  }

  select(id: string | null) {
    this.selectedId = id;
    this.paint();
    if (this.facadeSun.on) this.emitFacadeSun();
  }

  private highlight: Set<string> | null = null;
  private hiMaterial = new THREE.MeshStandardMaterial({ color: 0x14b8a6, roughness: 0.8, metalness: 0 });
  private dimMaterial = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.55 });

  /** 타입 고르기 — 고른 타입이 있는 동만 그 색으로, 나머지는 흐리게 (null이면 원래대로) */
  /** 타입 고르기 — 그 타입이 있는 동만 color로 칠하고 나머지는 흐리게 (null이면 원래대로) */
  setHighlight(ids: Set<string> | null, color?: string) {
    this.highlight = ids;
    if (color) this.hiMaterial.color.set(color);
    this.paint();
  }

  private labelEls = new Map<string, { el: HTMLElement; x: number; y: number; z: number }>();
  private marker: CSS2DObject | null = null;

  /** 고른 동 — 이름표를 칠하고, 이름표 위에 통통 튀는 화살표 */
  private markSelected() {
    for (const [id, l] of this.labelEls) l.el.classList.toggle("complex3d-label--on", id === this.selectedId);
    const l = this.selectedId ? this.labelEls.get(this.selectedId) : null;
    if (!l || this.win) {
      if (this.marker) this.marker.visible = false;
      return;
    }
    if (!this.marker) {
      const el = document.createElement("div");
      el.className = "complex3d-marker";
      el.innerHTML = '<span class="complex3d-marker__pin"></span>';
      this.marker = new CSS2DObject(el);
      this.scene.add(this.marker);
    }
    this.marker.visible = true;
    this.marker.position.set(l.x, l.y, l.z);
  }

  private selOutline: THREE.Group | null = null;

  private paint() {
    this.markSelected();
    // 고른 동은 칠은 그대로(타입 색 또는 기본색 — 흐리게 된 동이면 기본색으로) 두고 얇은 진한 남색 테두리로만 표시 (기본 동 테두리는 연한 청록)
    for (const [id, mesh] of this.ownMeshes) {
      const typed = !!this.highlight?.has(id);
      mesh.material = !this.highlight
        ? this.ownMaterial
        : typed
          ? this.hiMaterial
          : id === this.selectedId
            ? this.ownMaterial
            : this.dimMaterial;
    }
    if (this.selOutline) {
      this.scene.remove(this.selOutline);
      this.selOutline.traverse((o) => (o as THREE.LineSegments).geometry?.dispose?.());
      this.selOutline = null;
    }
    const sel = this.selectedId ? this.ownMeshes.get(this.selectedId) : null;
    if (sel) {
      const group = new THREE.Group();
      // WebGL 기본 선은 1px이라 굵은 선(화면 기준 px)으로
      const edges = new THREE.EdgesGeometry(sel.geometry, 30);
      const geo = new LineSegmentsGeometry().setPositions(edges.attributes.position!.array as Float32Array);
      edges.dispose();
      this.selectEdgeMaterial.resolution.set(this.host.clientWidth, this.host.clientHeight);
      group.add(new LineSegments2(geo, this.selectEdgeMaterial));
      group.visible = !this.win;
      this.scene.add(group);
      this.selOutline = group;
    }
    this.applyWalkXray();
  }
  private selectEdgeMaterial = new LineMaterial({ color: 0x0f172a, linewidth: 2.5 });

  /**
   * 동 주변 — 향(정면 = 긴 변 중 남쪽을 향한 쪽), 앞 동(정면으로 가장 먼저 닿는 단지 동), 옆 동(외곽선 사이 가장 가까운 동).
   * 앞 동은 정면 가운데 3m 높이에서 정면 방향으로 쏜 광선이 처음 닿는 단지 동 (400m 안).
   */
  dongContext(id: string): DongContext | null {
    const b = this.data?.buildings.find((x) => x.id === id);
    if (!b?.rings?.[0]) return null;
    const pts = b.rings[0].map(([lng, lat]) => this.toLocal(lng, lat));
    const mx = pts.reduce((a, q) => a + q.x, 0) / pts.length;
    const mz = pts.reduce((a, q) => a + q.z, 0) / pts.length;
    let sxx = 0, szz = 0, sxz = 0;
    for (const q of pts) {
      sxx += (q.x - mx) ** 2;
      szz += (q.z - mz) ** 2;
      sxz += (q.x - mx) * (q.z - mz);
    }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    let nx = -Math.sin(ang);
    let nz = Math.cos(ang);
    if (nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    // 방위: 북=0°, 시계방향 (로컬 x=동쪽, z=남쪽)
    const bearing = ((Math.atan2(nx, -nz) * 180) / Math.PI + 360) % 360;
    const facing = `${FACING[Math.round(bearing / 45) % 8]}향`;
    const face = Math.max(...pts.map((q) => (q.x - mx) * nx + (q.z - mz) * nz));
    // 정면 폭을 따라 7곳에서 쏴 가장 가까운 동 — 광선 하나는 동 사이 틈으로 빠질 수 있다
    const ux = nz;
    const uz = -nx;
    const along = pts.map((q) => (q.x - mx) * ux + (q.z - mz) * uz);
    const lo = Math.min(...along);
    const hi = Math.max(...along);
    const others = [...this.ownMeshes.entries()].filter(([k]) => k !== id).map(([, m]) => m);
    let hit: THREE.Intersection | undefined;
    for (let i = 0; i < 7; i++) {
      const t = lo + ((hi - lo) * (i + 0.5)) / 7;
      const origin = new THREE.Vector3(mx + nx * (face + 0.5) + ux * t, this.base(id) + 3, mz + nz * (face + 0.5) + uz * t);
      this.raycaster.set(origin, new THREE.Vector3(nx, 0, nz));
      this.raycaster.far = 400;
      const h = this.raycaster.intersectObjects(others, false)[0];
      if (h && (!hit || h.distance < hit.distance)) hit = h;
    }
    const frontId = (hit?.object.userData.id as string | undefined) ?? null;
    const front = frontId
      ? { dong: this.data!.buildings.find((x) => x.id === frontId)?.dong ?? null, meters: Math.round(hit!.distance + 0.5) }
      : null;
    return { facing, front, near: this.nearestDistance(id) };
  }

  /**
   * 동 정면 — 정면 방향(긴 축에 수직, 남쪽 쪽: 향 계산과 같음)과, 외곽선 변 중 바깥쪽이 정면을 향한 변들.
   * main: 정면을 향한 변 중 가장 긴 변 (창문 시점을 이 변 가운데에 둔다).
   */
  private facadeOf(id: string): {
    nx: number;
    nz: number;
    bearing: number;
    facing: string;
    edges: Array<{ ax: number; az: number; bx: number; bz: number; ox: number; oz: number; len: number; dot: number }>;
    main: { ax: number; az: number; bx: number; bz: number; ox: number; oz: number; len: number; dot: number };
  } | null {
    const b = this.data?.buildings.find((x) => x.id === id);
    const ring = b?.rings?.[0];
    if (!ring || ring.length < 4) return null;
    const pts = ring.map(([lng, lat]) => this.toLocal(lng, lat));
    const mx = pts.reduce((a, q) => a + q.x, 0) / pts.length;
    const mz = pts.reduce((a, q) => a + q.z, 0) / pts.length;
    let sxx = 0, szz = 0, sxz = 0;
    for (const q of pts) {
      sxx += (q.x - mx) ** 2;
      szz += (q.z - mz) ** 2;
      sxz += (q.x - mx) * (q.z - mz);
    }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    let nx = -Math.sin(ang);
    let nz = Math.cos(ang);
    if (nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    // 외곽선 방향(시계/반시계)으로 각 변의 바깥쪽 법선
    let area = 0;
    for (let i = 0; i < pts.length - 1; i++) area += pts[i]!.x * pts[i + 1]!.z - pts[i + 1]!.x * pts[i]!.z;
    const sign = area >= 0 ? 1 : -1;
    const edges = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const c = pts[i + 1]!;
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      if (len < 0.3) continue;
      const ox = (sign * (c.z - a.z)) / len;
      const oz = (-sign * (c.x - a.x)) / len;
      edges.push({ ax: a.x, az: a.z, bx: c.x, bz: c.z, ox, oz, len, dot: ox * nx + oz * nz });
    }
    const front = edges.filter((e) => e.dot > 0.7);
    const main = (front.length ? front : edges).reduce((best, e) => (e.len * Math.max(0.1, e.dot) > best.len * Math.max(0.1, best.dot) ? e : best));
    if (!main) return null;
    const bearing = ((Math.atan2(nx, -nz) * 180) / Math.PI + 360) % 360;
    return { nx, nz, bearing, facing: `${FACING[Math.round(bearing / 45) % 8]}향`, edges, main };
  }

  /** 층의 바닥 높이(장면 y)와 한 층 높이 — 건물 높이를 층수로 나눈 값 (층별가 색칠과 같은 모형) */
  private floorBase(id: string, floor: number): { y: number; perFloor: number; floors: number; h: number } | null {
    const b = this.data?.buildings.find((x) => x.id === id);
    if (!b) return null;
    const { h } = buildingHeight(b);
    const floors = b.floors ?? Math.max(1, Math.round(h / FLOOR_M));
    const perFloor = h / floors;
    const f = Math.max(1, Math.min(floors, Math.round(floor)));
    return { y: this.base(id) + (f - 1) * perFloor, perFloor, floors, h };
  }

  // ── 우리 집 창문 시점 ─────────────────────────────────────────────────────
  /** 창문 시점 정보가 바뀔 때 (둘러보면 방향·가림이 바뀐다) */
  onWindowInfo: (info: WindowViewInfo) => void = () => {};
  private win: {
    id: string;
    floor: number;
    eye: THREE.Vector3;
    /** 정면 방위 (북=0°, 시계방향, 도) */
    bearing0: number;
    /** 둘러본 만큼 (도, ±WIN_YAW) */
    yaw: number;
    pitch: number;
    facing: string;
    rays: Array<{ off: number; d: number | null; dong: string | null; hill: boolean }>;
    roughGround: boolean;
    /** 창 높이 — 동 바닥에서 (m) */
    eyeM: number;
    saved: { pos: THREE.Vector3; target: THREE.Vector3; fov: number; near: number };
    anim: { p0: THREE.Vector3; l0: THREE.Vector3; fov0: number; start: number; ms: number } | null;
    lastEmit: number;
  } | null = null;

  get inWindowView() {
    return !!this.win;
  }

  /**
   * 창문 시점 세로 시야각 — 가로로 약 60°가 보이게 하되 세로는 50~80°로 (세로 휴대폰에서는 가로가 약 38°까지 좁아진다,
   * 더 넓히면 화면 가장자리가 심하게 늘어나 보인다). 가림 비율은 실제 화면 가로 폭(spanDeg)만큼만 잰다.
   */
  private windowFov(): number {
    const hHalf = (30 * Math.PI) / 180;
    const v = (2 * Math.atan(Math.tan(hHalf) / Math.max(0.2, this.camera.aspect)) * 180) / Math.PI;
    return Math.max(50, Math.min(80, v));
  }

  /** 창문 시점 화면의 가로 시야 (°, WIN_SPAN_MAX 이하) */
  private windowSpan(): number {
    const v = (this.windowFov() * Math.PI) / 180;
    const hDeg = (2 * Math.atan(Math.tan(v / 2) * this.camera.aspect) * 180) / Math.PI;
    return Math.min(WIN_SPAN_MAX, Math.round(hDeg));
  }

  /**
   * 고른 동 floor층 창가에 선다 — 정면(동 정보의 향)을 향한 가장 긴 외벽 가운데, 그 층 바닥 + 1.5m 눈높이, 벽 밖 0.6m.
   * 정면 ±WIN_RAY°를 2°마다 수평으로 쏴 첫 가림까지 거리를 재 둔다 (둘러볼 때 다시 쏘지 않는다). 건물은 외곽선 기둥으로 잰다.
   */
  enterWindowView(id: string, floor: number, reduced: boolean): WindowViewInfo | null {
    const fa = this.facadeOf(id);
    const fb = this.floorBase(id, floor);
    if (!fa || !fb || !this.data) return null;
    const m = fa.main;
    const px = (m.ax + m.bx) / 2 + m.ox * 0.6;
    const pz = (m.az + m.bz) / 2 + m.oz * 0.6;
    // 창 높이는 그 층 그대로 (건물 가림은 이 높이에서). 비탈에서는 지형 격자(약 15m 칸)가 창 자리 땅을 동 바닥보다 높게
    // 잡기도 해 — 그러면 카메라와 지형 가림은 일조 계산과 같은 기준으로, 동 바닥 기준 높이를 제자리 격자 땅에 얹는다
    // (낮은 층이 땅속에서 보지 않고, 층마다 높이 차이는 그대로).
    const eyeY = Math.min(fb.y + 1.5, this.base(id) + fb.h - 0.5);
    const g0 = this.groundAt(px, pz);
    const lift = this.terrain ? Math.max(0, g0 - this.base(id)) : 0;
    const roughGround = lift > 1;
    const eye = new THREE.Vector3(px, eyeY + lift, pz);
    // 정면 = 동 정보의 향과 같은 방향 (긴 축에 수직, 남쪽 쪽) — 창 자리는 그쪽을 향한 가장 긴 외벽 가운데
    const bearing0 = fa.bearing;
    const all = this.getPrisms();
    const n0x = Math.sin((bearing0 * Math.PI) / 180);
    const n0z = -Math.cos((bearing0 * Math.PI) / 180);
    // 정면 쪽 반평면(±90°, WIN_RAY와 같음) 500m 안 기둥만
    const near = prismsInFront(all, px, pz, n0x, n0z, 500);
    // 지형 가림 — 일조와 같은 기준: 가까운 TERRAIN_NEAR m는 격자가 거칠어 빼고, 눈높이는 동 바닥 기준 높이를 제자리 격자 땅에 얹어
    const t = this.terrain;
    const hillY = eye.y;
    const checkHill = !!t && hillY < t.max;
    const rays: Array<{ off: number; d: number | null; dong: string | null; hill: boolean }> = [];
    for (let off = -WIN_RAY; off <= WIN_RAY; off += 2) {
      const a = ((bearing0 + off) * Math.PI) / 180;
      const sx = Math.sin(a);
      const sz = -Math.cos(a);
      const hit = firstPrismHit(px, eyeY, pz, sx, sz, near, 500);
      let hillAt: number | null = null;
      if (checkHill) {
        // 지형 격자 끝까지 (건물은 500m까지만 본다)
        const far = hit ? hit.d : t!.size / 2;
        for (let s = TERRAIN_NEAR; s < far; s += s < 200 ? 4 : 8) {
          if (this.groundAt(px + sx * s, pz + sz * s) > hillY) {
            hillAt = s;
            break;
          }
        }
      }
      rays.push(
        hillAt != null
          ? { off, d: hillAt, dong: null, hill: true }
          : {
              off,
              d: hit ? Math.round(hit.d) : null,
              dong: hit && hit.id !== id ? (this.data.buildings.find((x) => x.id === hit.id)?.dong ?? null) : null,
              hill: false,
            },
      );
    }
    const prev = this.win;
    const saved = prev?.saved ?? {
      pos: this.camera.position.clone(),
      target: this.controls.target.clone(),
      fov: this.camera.fov,
      near: this.camera.near,
    };
    this.anim = null;
    this.controls.enabled = false;
    this.insetTarget = 0;
    this.labels.domElement.style.display = "none";
    if (this.marker) this.marker.visible = false;
    if (this.selOutline) this.selOutline.visible = false;
    this.groups.view.visible = false;
    this.camera.near = 0.3;
    const look0 = prev
      ? this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(60).add(this.camera.position)
      : this.controls.target.clone();
    this.win = {
      id,
      floor,
      eye,
      bearing0,
      yaw: prev?.id === id ? prev.yaw : 0,
      pitch: prev?.id === id ? prev.pitch : 0,
      facing: fa.facing,
      rays,
      roughGround,
      eyeM: eyeY - this.base(id),
      saved,
      anim: reduced ? null : { p0: this.camera.position.clone(), l0: look0, fov0: this.camera.fov, start: performance.now(), ms: prev ? 350 : 900 },
      lastEmit: 0,
    };
    if (reduced) {
      this.camera.fov = this.windowFov();
      this.camera.updateProjectionMatrix();
    }
    return this.windowInfo();
  }

  /**
   * 창문 시점 층 끌기 — 눈높이만 바로 옮긴다 (가림 광선은 그대로, 다시 재는 일은 enterWindowView로 가끔).
   * 창 자리 땅높이 보정(lift)은 들어올 때 값 그대로.
   */
  setWindowEyeFloor(floor: number): WindowViewInfo | null {
    const w = this.win;
    if (!w) return null;
    const fb = this.floorBase(w.id, floor);
    if (!fb) return null;
    const base = this.base(w.id);
    const lift = w.eye.y - (base + w.eyeM);
    const eyeY = Math.min(fb.y + 1.5, base + fb.h - 0.5);
    w.floor = Math.max(1, Math.min(fb.floors, Math.round(floor)));
    w.eyeM = eyeY - base;
    w.eye.y = eyeY + lift;
    if (w.anim) w.anim = null;
    return this.windowInfo();
  }

  /** 지금 화면에 보이는 가로 폭 안에서 200m 안에 막힌 비율, 정면(±4°) 첫 건물까지 거리 */
  private windowInfo(): WindowViewInfo {
    const w = this.win!;
    const bearing = (w.bearing0 + w.yaw + 360) % 360;
    const span = this.windowSpan();
    const within = w.rays.filter((r) => Math.abs(r.off - w.yaw) <= span / 2);
    const blocked = within.filter((r) => r.d != null && r.d < 200).length / Math.max(1, within.length);
    const front = w.rays
      .filter((r) => Math.abs(r.off - w.yaw) <= 4 && r.d != null)
      .sort((a, b) => a.d! - b.d!)[0];
    return {
      floor: w.floor,
      facing: w.facing,
      lookDir: `${FACING[Math.round(bearing / 45) % 8]}쪽`,
      yaw: Math.round(w.yaw),
      frontM: front?.d ?? null,
      frontDong: front?.dong ?? null,
      frontHill: !!front?.hill,
      blockedShare: blocked,
      spanDeg: span,
      eyeM: Math.round(w.eyeM * 10) / 10,
      roughGround: w.roughGround,
    };
  }

  /** 둘러보기 — 정면에서 좌우 WIN_YAW°, 위아래 20° 안 */
  lookWindow(dYaw: number, dPitch = 0, throttle = false) {
    const w = this.win;
    if (!w) return;
    w.yaw = Math.max(-WIN_YAW, Math.min(WIN_YAW, w.yaw + dYaw));
    w.pitch = Math.max(-20, Math.min(20, w.pitch + dPitch));
    const now = performance.now();
    if (!throttle || now - w.lastEmit > 80) {
      w.lastEmit = now;
      this.onWindowInfo(this.windowInfo());
    }
  }

  /** 창문 시점에서 나와 들어오기 전 시점으로 */
  exitWindowView(reduced: boolean) {
    const w = this.win;
    if (!w) return;
    this.win = null;
    this.camera.fov = w.saved.fov;
    this.camera.near = w.saved.near;
    this.camera.updateProjectionMatrix();
    this.controls.enabled = true;
    this.labels.domElement.style.display = "";
    if (this.selOutline) this.selOutline.visible = true;
    this.markSelected();
    this.setMode(this.mode);
    this.controls.target.copy(w.eye.clone().add(this.windowDir(w)));
    if (reduced) {
      this.camera.position.copy(w.saved.pos);
      this.controls.target.copy(w.saved.target);
    } else this.flyTo(w.saved.pos, w.saved.target, 700);
  }

  private windowDir(w: NonNullable<typeof this.win>): THREE.Vector3 {
    const a = ((w.bearing0 + w.yaw) * Math.PI) / 180;
    const p = (w.pitch * Math.PI) / 180;
    return new THREE.Vector3(Math.sin(a) * Math.cos(p), Math.sin(p), -Math.cos(a) * Math.cos(p));
  }

  private stepWindow() {
    const w = this.win!;
    const look = w.eye.clone().add(this.windowDir(w).multiplyScalar(60));
    if (w.anim) {
      const k = Math.min(1, (performance.now() - w.anim.start) / w.anim.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(w.anim.p0, w.eye, e);
      this.camera.fov = w.anim.fov0 + (this.windowFov() - w.anim.fov0) * e;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(new THREE.Vector3().lerpVectors(w.anim.l0, look, e));
      if (k >= 1) w.anim = null;
      return;
    }
    this.camera.position.copy(w.eye);
    this.camera.lookAt(look);
  }

  /** 두 동 외곽선 사이 최소 거리 (m, 평면) */
  nearestDistance(id: string): { dong: string | null; meters: number } | null {
    if (!this.data) return null;
    const me = this.data.buildings.find((b) => b.id === id);
    if (!me?.rings) return null;
    const pts = (b: Complex3dBuilding) => (b.rings ?? []).flat().map(([lng, lat]) => this.toLocal(lng, lat));
    const segDist = (p: Local, a: Local, b: Local) => {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
    };
    const mine = pts(me);
    let best: { dong: string | null; meters: number } | null = null;
    for (const other of this.data.buildings) {
      if (other.id === id || !other.rings || !other.residential) continue;
      const theirs = pts(other);
      let d = Infinity;
      for (const p of mine) for (let i = 1; i < theirs.length; i++) d = Math.min(d, segDist(p, theirs[i - 1]!, theirs[i]!));
      for (const p of theirs) for (let i = 1; i < mine.length; i++) d = Math.min(d, segDist(p, mine[i - 1]!, mine[i]!));
      if (!best || d < best.meters) best = { dong: other.dong, meters: Math.round(d) };
    }
    return best;
  }


  // ── 걷기 경로 ──────────────────────────────────────────────────────────────
  /** 걸은 시간(초)·끝났는지 — 빨리 감기로 움직이는 사람 표시에 맞춰 */
  onWalkProgress: (sec: number, done: boolean) => void = () => {};
  /**
   * 걷기 그룹 비우기 — 사람 표시·도착 핀은 CSS2D(HTML) 요소라 장면에서 빼도 화면에 남는다. 요소도 같이 지운다.
   */
  private clearWalkGroup() {
    // 경로 선 재질(walkLineMat·walkCaseMat)과 걷는 사람 모형(walkerKit)은 함께 쓰니 남긴다
    const keep = new Set<unknown>([this.walkLineMat, this.walkCaseMat, ...walkerShared()]);
    disposeGroup(this.groups.walk, keep);
    this.walker = null;
  }

  private walkDraw: WalkRouteDraw | null = null;
  private walkReduced = false;
  private walkPath: { pts: THREE.Vector3[]; cum: number[]; total: number } | null = null;
  private walkAnim: { start: number; ms: number } | null = null;
  private walker: WalkerRig | null = null;
  private walkerYaw = 0;
  private walkPhase = 0;
  private walkFollow = false;
  private walkFollowReduced = false;
  /** 사용자가 직접 돌려 따라가기가 꺼졌을 때 */
  onWalkFollow: (on: boolean) => void = () => {};
  private walkLastEmit = 0;
  // 경로는 건물·지형에 가려도 이어져 보이게 (깊이 검사 끔, 맨 나중에 그림)
  private walkLineMat = new LineMaterial({ color: 0x2563eb, linewidth: 6, depthTest: false, depthWrite: false, transparent: true });
  private walkCaseMat = new LineMaterial({ color: 0xffffff, linewidth: 10, depthTest: false, depthWrite: false, transparent: true });

  /** 경로를 땅 위에 굵은 선으로 깔고, 사람 표시를 빨리 감기로 걷게 한다 (reduced면 움직이지 않고 도착점에) */
  showWalk(d: WalkRouteDraw, reduced: boolean, frame = true) {
    if (!this.data) return;
    this.walkDraw = d;
    this.walkReduced = reduced;
    this.clearWalkGroup();
    this.walkAnim = null;
    // 4m 간격으로 다시 찍어 땅을 따라가게
    const raw = d.points.map(([lng, lat]) => this.toLocal(lng, lat));
    if (raw.length < 2) return;
    // 선·표시는 깊이 검사를 끄고 그려 땅에 묻히지 않는다 — 조금만 띄워 걷는 사람 발밑과 어긋나 보이지 않게
    const lift = 0.6;
    const pts: THREE.Vector3[] = [];
    const cum: number[] = [];
    let acc = 0;
    const push = (x: number, z: number) => {
      const prev = pts[pts.length - 1];
      if (prev) acc += Math.hypot(x - prev.x, z - prev.z);
      pts.push(new THREE.Vector3(x, this.groundAt(x, z) + lift, z));
      cum.push(acc);
    };
    push(raw[0]!.x, raw[0]!.z);
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1]!;
      const b = raw[i]!;
      const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 4));
      for (let s = 1; s <= k; s++) push(a.x + ((b.x - a.x) * s) / k, a.z + ((b.z - a.z) * s) / k);
    }
    this.walkPath = { pts, cum, total: acc };
    const flat = pts.flatMap((p) => [p.x, p.y, p.z]);
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.walkLineMat.resolution.set(w, h);
    this.walkCaseMat.resolution.set(w, h);
    const casing = new Line2(new LineGeometry().setPositions(flat), this.walkCaseMat);
    casing.renderOrder = 2;
    const line = new Line2(new LineGeometry().setPositions(flat), this.walkLineMat);
    line.renderOrder = 3;
    this.groups.walk.add(casing, line);

    // 횡단·출입구·계단 표시 (작은 원판)
    const disc = (x: number, z: number, color: number, r = 2.6) => {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(r, 20).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }),
      );
      m.position.set(x, this.groundAt(x, z) + lift + 0.3, z);
      m.renderOrder = 4;
      this.groups.walk.add(m);
    };
    for (const mk of d.marks) {
      const l = this.toLocal(mk.lng, mk.lat);
      const color =
        mk.kind === "crossing"
          ? mk.major
            ? 0xef4444
            : 0xf59e0b
          : mk.kind === "gate"
            ? 0x0e9aa0
            : mk.kind === "steps"
              ? 0x7c3aed
              : 0x64748b;
      disc(l.x, l.z, color);
    }
    disc(pts[0]!.x, pts[0]!.z, 0x0f172a, 3);

    // 도착 핀
    const tl = this.toLocal(d.target.lng, d.target.lat);
    const gy = this.groundAt(tl.x, tl.z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 24, 8), new THREE.MeshBasicMaterial({ color: 0x1d4ed8 }));
    pole.position.set(tl.x, gy + 12, tl.z);
    this.groups.walk.add(pole);
    const el = document.createElement("div");
    el.className = "complex3d-pin complex3d-pin--station";
    el.textContent = d.name;
    const pin = new CSS2DObject(el);
    pin.position.set(tl.x, gy + 28, tl.z);
    this.groups.walk.add(pin);

    // 걷는 사람 — 경로 방향을 보고 선다 (경로 선은 땅에서 lift만큼 띄웠지만 사람은 땅에 발을 딛는다)
    const rig = makeWalker(WALKER_LOOK[d.walker ?? "female"], d.walker === "elder");
    this.groups.walk.add(rig.root);
    this.walker = rig;
    this.walkPhase = 0;
    const at = reduced ? pts.length - 1 : 0;
    const from = pts[Math.max(0, at - 1)]!;
    const to = pts[Math.max(1, at)]!;
    this.walkerYaw = Math.atan2(to.x - from.x, to.z - from.z);
    this.placeWalker(pts[at]!, this.walkerYaw, 0);
    if (reduced) {
      this.onWalkProgress(d.totalSec, true);
    } else {
      this.walkAnim = { start: performance.now(), ms: walkPlayMs(d.baseSec ?? d.totalSec, d.totalSec) };
      this.onWalkProgress(0, false);
    }
    if (this.walkFollow) this.followWalker(true);
    else if (frame) this.fitWalk();
  }

  replayWalk() {
    if (!this.walkPath || !this.walkDraw || this.walkReduced) return;
    this.walkAnim = { start: performance.now(), ms: walkPlayMs(this.walkDraw.baseSec ?? this.walkDraw.totalSec, this.walkDraw.totalSec) };
  }

  clearWalk() {
    this.clearWalkGroup();
    this.walkDraw = null;
    this.walkPath = null;
    this.walkAnim = null;
    this.walker = null;
  }

  /**
   * 걷기 끝내기 — 재생을 멈추고 경로·사람·핀(CSS2D 요소까지)을 지우고, 따라가기를 끄고, 보통 둘러보기로 돌려 놓는다.
   * 카메라는 호출하는 쪽이 (고른 동 또는 단지 전체로) 옮긴다.
   */
  endWalk() {
    this.clearWalk();
    this.walkFollow = false;
    this.anim = null;
    this.controls.enabled = !this.win;
    this.controls.minDistance = MIN_DIST;
  }

  /** 경로 전체가 보이게 — 위에서 비스듬히, 아래 패널이 가리는 만큼 멀리서 */
  fitWalk() {
    const path = this.walkPath;
    if (!path) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of path.pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const hw = (maxX - minX) / 2 + 40;
    const hd = (maxZ - minZ) / 2 + 40;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const polar = (38 * Math.PI) / 180;
    const visible = Math.max(0.35, 1 - this.insetTarget / Math.max(1, this.host.clientHeight));
    const dist = Math.min(
      this.controls.maxDistance,
      Math.max(160, Math.max(hw / Math.tan(hfov / 2), (hd * Math.cos(polar)) / (Math.tan(vfov / 2) * visible)) * 1.15),
    );
    const target = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    target.y = this.groundAt(target.x, target.z);
    this.flyTo(new THREE.Vector3(target.x, target.y + dist * Math.cos(polar), target.z + dist * Math.sin(polar)), target, 600);
  }

  /** 사람을 땅 위 p(경로 점)에 세운다 — 팔다리 흔들기는 phase(라디안), 0이면 서 있는 자세 */
  private placeWalker(p: THREE.Vector3, yaw: number, swing: number) {
    const w = this.walker;
    if (!w) return;
    w.root.position.set(p.x, this.groundAt(p.x, p.z) + 0.15, p.z);
    w.root.rotation.y = yaw;
    poseWalker(w, this.walkPhase, swing);
  }

  private lastFrameAt = 0;

  private stepWalk(dt: number) {
    const w = this.walker;
    const path = this.walkPath;
    if (!w || !path || !this.walkDraw) return;
    // 멀리서 보면 사람을 키운다 (가까이 따라가면 실제 크기)
    const camDist = this.camera.position.distanceTo(w.root.position);
    w.root.scale.setScalar(Math.max(1, Math.min(9, camDist / 55)));
    const a = this.walkAnim;
    if (!a) {
      if (this.walkFollow) this.followWalker(false, dt);
      return;
    }
    const k = Math.min(1, (performance.now() - a.start) / a.ms);
    const d = k * path.total;
    let i = 1;
    while (i < path.cum.length - 1 && path.cum[i]! < d) i++;
    const c0 = path.cum[i - 1]!;
    const c1 = path.cum[i]!;
    const t = c1 > c0 ? (d - c0) / (c1 - c0) : 1;
    const p0 = path.pts[i - 1]!;
    const p1 = path.pts[i]!;
    const p = new THREE.Vector3().lerpVectors(p0, p1, Math.max(0, Math.min(1, t)));
    // 가는 방향으로 부드럽게 돌아선다 (4m 점 사이 꺾임이 튀지 않게)
    const target = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    let dy = target - this.walkerYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.walkerYaw += dy * Math.min(1, dt * 8);
    // 걸음 수에 맞춰 흔든다 — 2π = 두 걸음. 빨리 감기라 실제보다 약 1.9배 빠르게 (걷는 사람끼리 비율은 그대로)
    this.walkPhase += dt * Math.PI * w.look.cadence * 1.9;
    this.placeWalker(p, this.walkerYaw, k >= 1 ? 0 : 1);
    if (this.walkFollow) this.followWalker(false, dt);
    const now = performance.now();
    if (k >= 1) {
      this.walkAnim = null;
      this.walkPhase = 0;
      this.placeWalker(p, this.walkerYaw, 0);
      this.onWalkProgress(this.walkDraw.totalSec, true);
    } else if (now - this.walkLastEmit > 120) {
      this.walkLastEmit = now;
      this.onWalkProgress(k * this.walkDraw.totalSec, false);
    }
  }

  /**
   * 따라가기 — 사람 뒤 22m, 11m 위에서 사람 앞 8m를 본다. 따라가는 동안에는 OrbitControls를 돌리지 않는다
   * (최소 거리 40m에 끌려가지 않게). 사용자가 직접 돌리면 따라가기가 꺼지고, 그때 거리에서 이어서 돌릴 수 있게
   * 최소 거리는 잠시 낮춰 두었다가 다시 40m 밖으로 나가면 돌려 놓는다.
   */
  setWalkFollow(on: boolean, reduced: boolean) {
    if (on === this.walkFollow) return;
    this.walkFollow = on;
    this.walkFollowReduced = reduced;
    if (on) this.controls.minDistance = FOLLOW_MIN_DIST;
    if (on) this.followWalker(true);
    else if (this.walkPath && !this.win) this.fitWalk();
  }

  /** 카메라가 보는 방향 — 사람이 도는 것보다 천천히 따라 돌아 어지럽지 않게 */
  private followYaw = 0;

  private followWalker(snap: boolean, dt = 0) {
    const w = this.walker;
    if (!w) return;
    if (snap) this.followYaw = this.walkerYaw;
    else {
      const dy = Math.atan2(Math.sin(this.walkerYaw - this.followYaw), Math.cos(this.walkerYaw - this.followYaw));
      this.followYaw += this.walkFollowReduced ? dy : dy * Math.min(1, dt * 2.5);
    }
    const fwd = new THREE.Vector3(Math.sin(this.followYaw), 0, Math.cos(this.followYaw));
    const p = w.root.position;
    const pos = p.clone().addScaledVector(fwd, -22).add(new THREE.Vector3(0, 11, 0));
    // 비탈에서 카메라가 땅에 묻히지 않게
    pos.y = Math.max(pos.y, this.groundAt(pos.x, pos.z) + 4);
    const target = p.clone().addScaledVector(fwd, 8).add(new THREE.Vector3(0, 1.5, 0));
    if (snap && !this.walkFollowReduced && dt === 0) {
      this.flyTo(pos, target, 600);
      return;
    }
    // 처음 다가가는 중이면 끝 지점을 계속 사람 뒤로 옮긴다 — 빨리 감기라 사람이 빨라 위치는 늦추지 않는다
    if (this.anim) {
      this.anim.p1 = pos;
      this.anim.t1 = target;
      return;
    }
    this.camera.position.copy(pos);
    this.controls.target.copy(target);
  }

  /** 누른 손가락 — 탭 판정용. 두 손가락(핀치)이 한 번이라도 닿았다면 그 동작은 탭이 아니다 */
  private down: { x: number; y: number; id: number } | null = null;
  private touches = new Set<number>();
  private multi = false;
  private dragAt: { x: number; y: number; id: number } | null = null;
  private onPointerDown = (e: PointerEvent) => {
    if (!this.touches.size) this.multi = false;
    this.touches.add(e.pointerId);
    if (this.touches.size > 1) this.multi = true;
    this.down = { x: e.clientX, y: e.clientY, id: e.pointerId };
    if (this.win) {
      this.dragAt = { x: e.clientX, y: e.clientY, id: e.pointerId };
      // 마우스를 패널 위에서 놓아도 pointerup이 캔버스로 오게
      try {
        this.renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        /* 이미 끝난 포인터 */
      }
    }
  };
  /** 창문 시점 — 끌면 고개를 돌린다 (화면 너비만큼 끌면 약 60°) */
  private onPointerMove = (e: PointerEvent) => {
    const d = this.dragAt;
    if (!this.win || !d || d.id !== e.pointerId) return;
    // 버튼을 놓은 채 움직이는 마우스 (놓은 이벤트를 놓쳤을 때) — 끌기 끝
    if (e.pointerType === "mouse" && (e.buttons & 1) === 0) {
      this.dragAt = null;
      return;
    }
    const k = 60 / Math.max(240, this.host.clientWidth);
    this.lookWindow(-(e.clientX - d.x) * k, (e.clientY - d.y) * k, true);
    this.dragAt = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  private onPointerCancel = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    this.dragAt = null;
    this.down = null;
  };
  private onPointerUp = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.win) {
      if (this.renderer.domElement.hasPointerCapture?.(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
      this.dragAt = null;
      if (this.win) this.onWindowInfo(this.windowInfo());
      return;
    }
    // 핀치 뒤 마지막 손가락을 떼는 것, 다른 손가락의 떼기, 끌기는 탭이 아니다 (걷기 중 핀치가 동 고르기로 읽혀 경로가 다시 맞춰지던 문제)
    const down = this.down;
    if (this.multi || !down || down.id !== e.pointerId || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    this.down = null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.far = Infinity;
    const pool =
      this.mode === "floors"
        ? this.groups.floors.children
        : this.mode === "types"
          ? this.groups.types.children
          : [...this.ownMeshes.values()];
    const hit = this.raycaster.intersectObjects(pool, false)[0];
    const id = (hit?.object.userData.id as string | undefined) ?? null;
    // 걷기 — 빈 곳을 눌러도 출발 동을 풀지 않는다 (경로가 바뀌어 화면이 다시 맞춰지지 않게)
    if (!id && this.mode === "walk") return;
    // 일조·조망 — 한 번 탭으로 고르고 그 동으로 다가간다
    if (id && (this.mode === "sun" || this.mode === "view")) {
      this.lastTap = null;
      this.select(id);
      this.onSelect(id);
      this.focus(id, window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      return;
    }
    // 한 번 탭 = 선택만, 같은 동을 두 번 탭 = 그 동으로 다가가기
    const now = performance.now();
    if (id && this.lastTap && this.lastTap.id === id && now - this.lastTap.at < 350) {
      this.lastTap = null;
      this.focus(id);
      return;
    }
    this.lastTap = id ? { id, at: now } : null;
    this.select(id);
    this.onSelect(id);
  };
  private lastTap: { id: string; at: number } | null = null;

  setBottomInset(px: number) {
    this.insetTarget = Math.max(0, Math.round(px));
  }

  private applyInset() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (this.inset < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h + this.inset, 0, this.inset, w, h);
  }

  resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.camera.aspect = w / h;
    this.selectEdgeMaterial.resolution.set(w, h);
    this.walkLineMat.resolution.set(w, h);
    this.walkCaseMat.resolution.set(w, h);
    this.applyInset();
    if (this.win && !this.win.anim) this.camera.fov = this.windowFov();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    // 화면 비율이 바뀌면 보이는 가로 폭도 바뀐다
    if (this.win) this.onWindowInfo(this.windowInfo());
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.anim) {
      const a = this.anim;
      const k = Math.min(1, (performance.now() - a.start) / a.ms);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(a.p0, a.p1, e);
      this.controls.target.lerpVectors(a.t0, a.t1, e);
      if (k >= 1) this.anim = null;
    }
    if (Math.abs(this.insetTarget - this.inset) > 0.5) {
      this.inset += (this.insetTarget - this.inset) * 0.25;
      if (Math.abs(this.insetTarget - this.inset) <= 0.5) this.inset = this.insetTarget;
      this.applyInset();
    }
    const now = performance.now();
    const dt = this.lastFrameAt ? Math.min(0.1, (now - this.lastFrameAt) / 1000) : 0;
    this.lastFrameAt = now;
    this.stepWalk(dt);
    this.stepFacadeSun();
    if (this.win) this.stepWindow();
    else if (this.walkFollow && this.walker) {
      // 따라가기 — 위치는 followWalker가 정하고 여기서는 바라보기만 (controls.update는 최소 거리로 끌어당긴다)
      this.camera.lookAt(this.controls.target);
    } else {
      if (this.controls.minDistance < MIN_DIST && this.camera.position.distanceTo(this.controls.target) >= MIN_DIST) {
        this.controls.minDistance = MIN_DIST;
      }
      // 너무 멀리 끌고 가지 못하게 — 보는 곳을 단지에서 PAN_LIMIT_M 안으로 (카메라도 같이 옮긴다)
      const tg = this.controls.target;
      const r = Math.hypot(tg.x, tg.z);
      if (r > PAN_LIMIT_M) {
        const k = PAN_LIMIT_M / r;
        const dx = tg.x * k - tg.x;
        const dz = tg.z * k - tg.z;
        tg.x += dx;
        tg.z += dz;
        this.camera.position.x += dx;
        this.camera.position.z += dz;
      }
      this.controls.update();
    }
    // 멀리서 보면 동 이름표를 작게 (겹침 줄이기)
    const far = this.camera.position.distanceTo(this.controls.target) > this.bounds.radius * 2.6;
    if (far !== this.labelsFar) {
      this.labelsFar = far;
      this.labels.domElement.classList.toggle("complex3d-far", far);
    }
    // 나침반 — controls.update를 건너뛰는 따라가기 중에도 맞게 카메라 위치에서 직접 (OrbitControls 방위각과 같은 식)
    const off = this.camera.position.clone().sub(this.controls.target);
    const heading = Math.round((Math.atan2(off.x, off.z) * 180) / Math.PI);
    if (!this.win && heading !== this.lastHeading) {
      this.lastHeading = heading;
      this.onHeading(heading);
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.removeEventListener("pointercancel", this.onPointerCancel);
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}

