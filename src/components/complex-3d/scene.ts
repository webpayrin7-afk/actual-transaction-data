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
import type { Complex3d, Complex3dBuilding, FloorBand, Poi3d, Ring } from "@/lib/complex-3d/read";

export const FLOOR_M = 3;
const TEAL = 0x0e9aa0;
const TEAL_DARK = 0x087f83;
const OWN = 0x9fd9d6; // 단지 동 — 주변 회색 건물과 구분되는 중간 톤 청록
const OWN_EDGE = 0x0e9aa0;
const NEIGHBOR = 0xe6e9ee;

export type SceneMode = "base" | "floors" | "types" | "sun" | "view" | "around";

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

type Local = { x: number; z: number };

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
    this.controls.minDistance = 40;
    this.controls.maxDistance = 6000;

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

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    // 사용자가 직접 돌리면 진행 중인 이동은 멈춘다
    this.controls.addEventListener("start", () => (this.anim = null));
    this.setSun(new Date(), 14);
    this.loop();
  }

  private grid: THREE.GridHelper | null = null;
  private mapPlane: THREE.Mesh | null = null;

  /**
   * 바닥에 실제 지도 이미지를 깐다 — 단지 중심이 이미지 가운데, 한 변 sizeM 미터(웹 메르카토르라 가로·세로 축척 같음).
   * 지도가 뜨면 격자는 숨긴다. 그림자는 지도 위에 그대로 떨어진다.
   */
  setGroundMap(url: string, sizeM: number) {
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      if (this.mapPlane) {
        this.scene.remove(this.mapPlane);
        (this.mapPlane.material as THREE.Material).dispose();
      }
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(sizeM, sizeM),
        new THREE.MeshLambertMaterial({ map: tex }),
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = 0.05;
      plane.receiveShadow = true;
      this.scene.add(plane);
      this.mapPlane = plane;
      if (this.grid) this.grid.visible = false;
    });
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

  setData(data: Complex3d) {
    this.data = data;
    this.mPerLng = 111_320 * Math.cos((data.center.lat * Math.PI) / 180);
    for (const g of Object.values(this.groups)) g.clear();
    this.ownMeshes.clear();
    this.labelEls.clear();

    // 우리 단지 동
    const edgeMat = new THREE.LineBasicMaterial({ color: OWN_EDGE, transparent: true, opacity: 0.55 });
    let maxH = 20;
    for (const b of data.buildings) {
      if (!b.rings) continue;
      const { h } = buildingHeight(b);
      maxH = Math.max(maxH, h);
      const geo = this.extrude(b.rings, 0, h);
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
        obj.position.set(c.x, h + 4, c.z);
        this.groups.labels.add(obj);
        this.labelEls.set(b.id, { el, x: c.x, y: h + 4, z: c.z });
      }
    }

    // 주변 건물 — 한 덩어리로 합쳐 가볍게 (그림자·조망 계산에 쓴다)
    const neighborGeos: THREE.BufferGeometry[] = [];
    for (const n of data.neighbors) {
      const { h } = buildingHeight(n);
      const g = this.extrude(n.rings, 0, h);
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
    // 가로는 단지 폭, 세로는 기울어진 깊이 + 건물 높이가 화면에 들어오게 (여백 약 8%)
    const needW = halfW / Math.tan(hfov / 2);
    const needH = (halfD * Math.cos(polar) + maxH * Math.sin(polar) * 0.5) / Math.tan(vfov / 2);
    const dist = Math.min(this.controls.maxDistance, Math.max(120, Math.max(needW, needH) * 1.08));
    const target = new THREE.Vector3(cx, maxH * 0.25, cz);
    const position = new THREE.Vector3(
      target.x + dist * Math.sin(polar) * Math.sin(azimuth),
      target.y + dist * Math.cos(polar),
      target.z + dist * Math.sin(polar) * Math.cos(azimuth),
    );
    return { position, target };
  }

  private flyTo(position: THREE.Vector3, target: THREE.Vector3, ms = 450) {
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
    const target = new THREE.Vector3(cx, 0, cz);
    this.flyTo(new THREE.Vector3(cx, dist, cz + 0.01), target);
  }

  /** 지금 기울기·거리 그대로 북쪽이 화면 위로 */
  northUp() {
    const t = this.controls.target.clone();
    const off = this.camera.position.clone().sub(t);
    const flat = Math.hypot(off.x, off.z);
    this.flyTo(new THREE.Vector3(t.x, t.y + off.y, t.z + Math.max(0.01, flat)), t);
  }

  /** 동 하나로 다가가기 — 지금 보는 방향은 유지 */
  focus(id: string) {
    const b = this.data?.buildings.find((x) => x.id === id);
    if (!b?.rings) return;
    const c = this.ringCenter(b.rings);
    const { h } = buildingHeight(b);
    // 동 꼭대기보다 위를 보며(바닥이 화면 아래쪽으로 더 내려가게), 지금 방위는 유지하고 위에서 비스듬히(천정에서 50°) — 옆 동까지 조금 보이게 여유 있게
    const target = new THREE.Vector3(c.x, h * 1.1 + 8, c.z);
    const off = this.camera.position.clone().sub(this.controls.target);
    const az = Math.atan2(off.x, off.z);
    const polar = (50 * Math.PI) / 180;
    // 아래 패널이 화면을 가리면 보이는 높이가 줄어드니 그만큼 멀리서
    const visible = Math.max(0.35, 1 - this.insetTarget / Math.max(1, this.host.clientHeight));
    const dist = Math.max(240, h * 5.5) / visible;
    const dir = new THREE.Vector3(Math.sin(polar) * Math.sin(az), Math.cos(polar), Math.sin(polar) * Math.cos(az));
    this.flyTo(target.clone().add(dir.multiplyScalar(dist)), target);
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
    this.groups.floors.visible = mode === "floors";
    this.groups.types.visible = mode === "types";
    this.groups.own.visible = mode !== "floors" && mode !== "types";
    this.groups.view.visible = mode === "view";
    this.groups.pois.visible = mode === "around";
    this.groups.labels.visible = mode !== "around";
  }

  /** 층별 시세 — 각 동을 저·중·고 구간으로 잘라 구간 평당가에 따라 색을 입힌다 */
  setFloorBands(bands: FloorBand[]) {
    this.groups.floors.clear();
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
        const from = (band.fromFloor - 1) * perFloor;
        const to = Math.min(band.toFloor, floors) * perFloor;
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
    this.groups.types.clear();
    if (!this.data) return;
    for (const b of this.data.buildings) {
      if (!b.rings) continue;
      const { h } = buildingHeight(b);
      const geo = this.extrude(b.rings, 0, h);
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
    const eyeY = Math.min(h - 1, ((floor - 0.5) * h) / floors) + 1.2;
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
    // 부채꼴 그리기
    this.groups.view.clear();
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
        color: open ? TEAL : r.distance! >= 80 ? 0xf59e0b : 0xef4444,
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
    const y = Math.min(h - 0.5, ((Math.min(floor, floors) - 0.5) * h) / floors);
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
      slots.push(this.raycaster.intersectObjects(targets, false).length === 0);
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

  /** 주변 학교·역 핀 */
  setPois(pois: Poi3d[]) {
    this.groups.pois.clear();
    if (!this.data) return;
    for (const p of pois) {
      const l = this.toLocal(p.lng, p.lat);
      if (Math.hypot(l.x, l.z) > 900) continue;
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.8, 0.8, 30, 8),
        new THREE.MeshBasicMaterial({ color: p.kind === "station" ? 0x2563eb : 0xd97706 }),
      );
      pole.position.set(l.x, 15, l.z);
      this.groups.pois.add(pole);
      const el = document.createElement("div");
      el.className = `complex3d-pin complex3d-pin--${p.kind}`;
      el.textContent = `${p.name} · ${p.distanceM.toLocaleString("ko-KR")}m`;
      const obj = new CSS2DObject(el);
      obj.position.set(l.x, 34, l.z);
      this.groups.pois.add(obj);
    }
  }

  select(id: string | null) {
    this.selectedId = id;
    this.paint();
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
    if (!l) {
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
      this.scene.add(group);
      this.selOutline = group;
    }
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
      const origin = new THREE.Vector3(mx + nx * (face + 0.5) + ux * t, 3, mz + nz * (face + 0.5) + uz * t);
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

  private down: { x: number; y: number } | null = null;
  private onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
  };
  private onPointerUp = (e: PointerEvent) => {
    if (!this.down || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 6) return;
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
    this.applyInset();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
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
    this.controls.update();
    // 멀리서 보면 동 이름표를 작게 (겹침 줄이기)
    const far = this.camera.position.distanceTo(this.controls.target) > this.bounds.radius * 2.6;
    if (far !== this.labelsFar) {
      this.labelsFar = far;
      this.labels.domElement.classList.toggle("complex3d-far", far);
    }
    const heading = Math.round((this.controls.getAzimuthalAngle() * 180) / Math.PI);
    if (heading !== this.lastHeading) {
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

