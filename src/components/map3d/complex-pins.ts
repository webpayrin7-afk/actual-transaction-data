/**
 * 3D 지도 단지 핀 — MapLibre 캔버스 위 HTML 층 (점 + 이름표 + 고른 단지 화살표).
 *
 * 왜 HTML인가: MapLibre 점·글자 층은 땅 위에만 놓여, 지붕 위에 띄우려면 땅 위 점을 옮겨야 했고(움직임이 멈출 때만)
 * 돌리거나 기울이는 동안 점이 늦게 따라오다 튀었다. 여기서는 매 프레임 지붕 위(높이 top + 여유) 점의 화면 자리를 구해
 * 핀을 옮긴다 (React 다시 그리기 없이 DOM을 직접, transform 만 바꾼다).
 *
 * - 매 프레임(카메라가 움직인 프레임만): 화면 자리 계산 · transform 쓰기 · 화면 밖이면 숨김 — 레이아웃 읽기 없음.
 * - 움직임이 멈출 때(moveend)·데이터가 바뀔 때: 우선순위(고른 단지 → 화면 안 → 세대수 큰 순)로 겹침 정리 —
 *   점이 거의 포개지면 낮은 쪽 핀을 빼고, 이름표가 겹치면 낮은 쪽 이름표만 뺀다. 핀은 최대 MAX_PINS 개만 DOM에 붙인다.
 * - 핀 DOM은 단지 id로 기억해 다시 쓴다 (빠진 핀은 떼어 두기만).
 */
import type { Map as MlMap } from "maplibre-gl";

export type PinDatum = {
  id: string;
  /** 이름표 첫 줄 (줄인 이름) */
  name: string;
  /** 이름표 둘째 줄 — 없으면 "" */
  value: string;
  valueColor: string;
  dotColor: string;
  /** 세대수 — 겹칠 때 큰 단지를 남긴다 */
  hh: number;
  lng: number;
  lat: number;
  /** 지붕 높이(m) — 있으면 그 위에 띄운다, 없으면 땅 위 */
  top: number | null;
  /** 버튼 읽기 이름 "{이름} {값}" */
  aria: string;
};

type Tier = "off" | "dot" | "name" | "value";

type Pin = {
  d: PinDatum;
  el: HTMLButtonElement;
  nameEl: HTMLSpanElement;
  valEl: HTMLSpanElement;
  arrow: HTMLSpanElement | null;
  sig: string;
  sel: boolean;
  noLabel: boolean;
  z: number;
  attached: boolean;
  /** 마지막으로 쓴 자리 · 보임 (같으면 다시 쓰지 않는다) */
  x: number;
  y: number;
  shown: boolean;
  /** 이름표 글자 폭(px) — sig 가 바뀔 때만 다시 잰다 */
  wName: number;
  wVal: number;
};

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** DOM에 붙이는 핀 수 한도 — 넘는 핀(우선순위 낮은 쪽)은 떼어 두고 컨테이너 data-dropped 에 개수를 남긴다 */
const MAX_PINS = 120;
/** 점을 지붕보다 조금 더 위에 (m) */
const ROOF_GAP_M = 8;
/** 화면 밖 여유(px) — 이만큼 밖까지는 그려 둔다 (이름표가 화면 끝에 걸쳐도 보이게) */
const VIEW_MARGIN = 80;
const RAD = Math.PI / 180;
const M_PER_DEG = 111_320;

/** 이름표 크기 (CSS와 맞춘다) — 글자 줄 높이 15/14px, 위아래 3px + 테두리, 좌우 7px + 테두리 */
const LINE1 = 15;
const LINE2 = 14;
const PAD_X = 7 * 2 + 2.5;
const PAD_Y = 3 * 2 + 2.5;
/** 점 위 이름표 사이 (px) */
const LABEL_GAP = 4;

export const PINS_CSS = `
.cx-pins{position:absolute;inset:0;font-family:var(--font-sans,system-ui),sans-serif;pointer-events:none;overflow:hidden;isolation:isolate;--cx-d:10px}
.cx-pin{position:absolute;left:0;top:0;width:0;height:0;padding:0;font:inherit;margin:0;border:0;background:none;pointer-events:auto;cursor:pointer;will-change:transform;-webkit-tap-highlight-color:transparent;outline:none}
.cx-dot{position:absolute;left:0;top:0;box-sizing:border-box;width:var(--cx-d);height:var(--cx-d);transform:translate(-50%,-50%);border-radius:50%;border:2px solid #fff;box-shadow:0 1px 2px rgb(15 23 42/.35)}
.cx-dot::before{content:"";position:absolute;inset:-8px;border-radius:50%}
.cx-label{position:absolute;left:0;bottom:calc(var(--cx-d)/2 + ${LABEL_GAP}px);transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;white-space:nowrap;box-sizing:border-box;padding:3px 7px;border:1.25px solid #0f766e;border-radius:9px;background:#fff;color:#0f172a;font-weight:700;font-size:12px;line-height:${LINE1}px;text-align:center;box-shadow:0 1px 3px rgb(15 23 42/.18)}
.cx-val{font-size:11px;line-height:${LINE2}px}
.cx-val:empty{display:none}
.cx-nolabel .cx-label{display:none}
.cx-pins[data-tier=dot] .cx-pin:not(.cx-sel) .cx-label{display:none}
.cx-pins[data-tier=name] .cx-pin:not(.cx-sel) .cx-val{display:none}
.cx-sel .cx-dot{width:calc(var(--cx-d) + 4px);height:calc(var(--cx-d) + 4px);box-shadow:0 0 0 1px #fff,0 0 0 3.5px #0f172a}
.cx-sel .cx-label{bottom:calc(var(--cx-d)/2 + ${LABEL_GAP + 4}px);background:#0f766e;border-color:#0b4f4a;color:#fff}
.cx-sel .cx-val{color:#fff!important}
.cx-pins[data-has-sel] .cx-pin:not(.cx-sel){opacity:.45}
.cx-pins[data-has-sel] .cx-pin:not(.cx-sel) .cx-label{box-shadow:none}
.cx-sel{z-index:2}
.cx-arrow{position:absolute;left:50%;bottom:100%;margin-bottom:2px;width:18px;height:18px;margin-left:-9px;animation:cx-bounce 1s ease-in-out infinite;filter:drop-shadow(0 1px 1px rgb(15 23 42/.35))}
.cx-arrow svg{display:block}
@keyframes cx-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@media (prefers-reduced-motion:reduce){.cx-arrow{animation:none}}
.cx-pin:focus-visible .cx-label,.cx-pin:focus-visible.cx-nolabel .cx-dot{outline:2px solid #0f172a;outline-offset:2px}
`;

const ARROW_SVG =
  '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path d="M3 5.5h12L9 14z" fill="#0f766e" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';

function lerp(z: number, z0: number, v0: number, z1: number, v1: number): number {
  const t = Math.min(1, Math.max(0, (z - z0) / (z1 - z0)));
  return v0 + (v1 - v0) * t;
}

/** 점 지름(px) — 예전 circle-radius(줌 13에 5, 16에 8)와 같게 */
function dotDiameter(z: number): number {
  return Math.round(lerp(z, 13, 10, 16, 16) * 2) / 2;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

export class ComplexPins {
  private readonly map: MlMap;
  private readonly root: HTMLDivElement;
  private readonly onPick: (id: string) => void;
  private readonly zooms: { min: number; label: number; value: number };
  private data: PinDatum[] = [];
  private selectedId: string | null = null;
  private readonly pins = new Map<string, Pin>();
  /** 지금 DOM에 붙은 핀 (우선순위 순) */
  private active: Pin[] = [];
  private tier: Tier = "off";
  private dotD = 0;
  private w = 0;
  private h = 0;
  private raf = 0;
  private dirty = false;
  private down: { x: number; y: number } | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private font = "sans-serif";
  private readonly arrowTpl: HTMLSpanElement;

  constructor(
    map: MlMap,
    onPick: (id: string) => void,
    zooms: { min: number; label: number; value: number },
  ) {
    this.map = map;
    this.onPick = onPick;
    this.zooms = zooms;
    this.root = document.createElement("div");
    this.root.className = "cx-pins";
    this.root.dataset.tier = "off";
    // 캔버스 컨테이너 안에 둔다 — 핀 위에서 시작한 끌기·휠도 지도가 받는다 (컨트롤보다는 아래)
    map.getCanvasContainer().appendChild(this.root);
    this.arrowTpl = document.createElement("span");
    this.arrowTpl.className = "cx-arrow";
    this.arrowTpl.setAttribute("aria-hidden", "true");
    this.arrowTpl.innerHTML = ARROW_SVG;
    try {
      this.font = getComputedStyle(this.root).fontFamily || this.font;
      this.ctx = document.createElement("canvas").getContext("2d");
    } catch {
      this.ctx = null;
    }
    this.readSize();
    this.root.addEventListener("pointerdown", this.onDown);
    this.root.addEventListener("click", this.onClick);
    map.on("move", this.onMove);
    map.on("render", this.onRender);
    map.on("moveend", this.onMoveEnd);
    map.on("resize", this.onResize);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.map.off("move", this.onMove);
    this.map.off("render", this.onRender);
    this.map.off("moveend", this.onMoveEnd);
    this.map.off("resize", this.onResize);
    this.root.removeEventListener("pointerdown", this.onDown);
    this.root.removeEventListener("click", this.onClick);
    this.root.remove();
    this.pins.clear();
    this.active = [];
  }

  /** 단지 목록·고른 단지가 바뀔 때 — 없어진 단지의 DOM은 버리고 겹침을 다시 정리한다 */
  setData(data: PinDatum[], selectedId: string | null) {
    this.data = data;
    this.selectedId = selectedId;
    // 고른 단지가 있으면 다른 핀은 옅게 (고른 단지 이름표가 묻히지 않게)
    this.root.toggleAttribute("data-has-sel", selectedId != null);
    const ids = new Set(data.map((d) => d.id));
    for (const [id, p] of this.pins) {
      if (ids.has(id)) continue;
      p.el.remove();
      this.pins.delete(id);
    }
    this.layout();
  }

  // ---- 이벤트 ----

  private readonly onMove = () => {
    this.dirty = true;
    // 보통은 같은 프레임의 'render'에서 처리 — 그리기가 없을 때를 위해 rAF 도 하나 걸어 둔다
    if (!this.raf) this.raf = requestAnimationFrame(this.onFrame);
  };

  private readonly onRender = () => {
    if (this.dirty) this.frame();
  };

  private readonly onFrame = () => {
    this.raf = 0;
    if (this.dirty) this.frame();
  };

  private readonly onMoveEnd = () => this.layout();

  private readonly onResize = () => {
    this.readSize();
    this.layout();
  };

  private readonly onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  private readonly onClick = (e: MouseEvent) => {
    const btn = (e.target as Element | null)?.closest?.(".cx-pin") as HTMLButtonElement | null;
    if (!btn) return;
    // 지도 '빈 곳 누르면 고르기 풀기'로 번지지 않게
    e.stopPropagation();
    const down = this.down;
    this.down = null;
    // 핀 위에서 시작한 끌기(핀이 지도와 함께 움직여 손가락 아래 그대로 있음)는 고르기가 아니다
    if (down && e.detail > 0 && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    const id = btn.dataset.id;
    if (id) this.onPick(id);
  };

  private readSize() {
    const c = this.map.getContainer();
    this.w = c.clientWidth;
    this.h = c.clientHeight;
  }

  private tierOf(z: number): Tier {
    if (z < this.zooms.min) return "off";
    if (z < this.zooms.label) return "dot";
    if (z < this.zooms.value) return "name";
    return "value";
  }

  // ---- 화면 자리 ----

  /** 카메라 값 — 한 프레임에 한 번 */
  private camera() {
    const pitch = this.map.getPitch() * RAD;
    const b = this.map.getBearing() * RAD;
    // 화면 가로 방향의 땅 위 방위(방향 + 90°) — 이 방향 길이는 기울여도 줄지 않는다
    return { sinP: Math.sin(pitch), ce: Math.cos(b), cn: -Math.sin(b) };
  }

  /** 지붕 위(top + 여유) 점의 화면 자리 — 땅 점을 투영하고, 그 자리의 m당 px × sin(기울기)만큼 위로 */
  private screenOf(d: PinDatum, cam: { sinP: number; ce: number; cn: number }): { x: number; y: number } | null {
    const p0 = this.map.project([d.lng, d.lat]);
    let { x, y } = p0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (d.top != null && cam.sinP > 0.01) {
      const kx = 10 / (M_PER_DEG * Math.cos(d.lat * RAD));
      const ky = 10 / M_PER_DEG;
      const p1 = this.map.project([d.lng + cam.ce * kx, d.lat + cam.cn * ky]);
      const ppm = Math.hypot(p1.x - x, p1.y - y) / 10;
      if (!Number.isFinite(ppm)) return null;
      y -= (d.top + ROOF_GAP_M) * ppm * cam.sinP;
    }
    x = Math.round(x * 2) / 2;
    y = Math.round(y * 2) / 2;
    return { x, y };
  }

  private setDot(z: number) {
    const d = dotDiameter(z);
    if (d === this.dotD) return;
    this.dotD = d;
    this.root.style.setProperty("--cx-d", `${d}px`);
  }

  private frame() {
    this.dirty = false;
    const z = this.map.getZoom();
    // 줌 단계(점만·이름·이름+값)가 바뀌면 겹침부터 다시
    if (this.tierOf(z) !== this.tier) {
      this.layout();
      return;
    }
    if (this.tier === "off") return;
    this.setDot(z);
    this.position(this.camera());
  }

  private position(cam: { sinP: number; ce: number; cn: number }) {
    const m = VIEW_MARGIN;
    for (const p of this.active) {
      const s = this.screenOf(p.d, cam);
      const on = s != null && s.x > -m && s.x < this.w + m && s.y > -m && s.y < this.h + m * 2;
      if (on !== p.shown) {
        p.shown = on;
        p.el.style.visibility = on ? "" : "hidden";
      }
      if (!on || !s) continue;
      if (s.x === p.x && s.y === p.y) continue;
      p.x = s.x;
      p.y = s.y;
      p.el.style.transform = `translate3d(${s.x}px,${s.y}px,0)`;
    }
  }

  // ---- 겹침 정리 (멈출 때만) ----

  private measure(text: string, px: number): number {
    if (!text) return 0;
    const ctx = this.ctx;
    if (!ctx) return text.length * px * 0.9;
    ctx.font = `700 ${px}px ${this.font}`;
    return ctx.measureText(text).width;
  }

  private pinFor(d: PinDatum): Pin {
    let p = this.pins.get(d.id);
    if (!p) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "cx-pin";
      el.dataset.id = d.id;
      const label = document.createElement("span");
      label.className = "cx-label";
      const nameEl = document.createElement("span");
      const valEl = document.createElement("span");
      valEl.className = "cx-val";
      label.append(nameEl, valEl);
      const dot = document.createElement("span");
      dot.className = "cx-dot";
      el.append(label, dot);
      p = {
        d,
        el,
        nameEl,
        valEl,
        arrow: null,
        sig: "",
        sel: false,
        noLabel: false,
        z: 0,
        attached: false,
        x: NaN,
        y: NaN,
        shown: true,
        wName: 0,
        wVal: 0,
      };
      this.pins.set(d.id, p);
    }
    p.d = d;
    const sig = `${d.name}|${d.value}|${d.valueColor}|${d.dotColor}|${d.aria}`;
    if (sig !== p.sig) {
      p.sig = sig;
      p.nameEl.textContent = d.name;
      p.valEl.textContent = d.value;
      p.valEl.style.color = d.valueColor;
      (p.el.lastChild as HTMLSpanElement).style.background = d.dotColor;
      p.el.setAttribute("aria-label", d.aria);
      p.wName = this.measure(d.name, 12);
      p.wVal = this.measure(d.value, 11);
    }
    return p;
  }

  private layout() {
    const z = this.map.getZoom();
    const tier = this.tierOf(z);
    if (tier !== this.tier) {
      this.tier = tier;
      this.root.dataset.tier = tier;
    }
    // 멀리 보면 단지 층을 통째로 숨긴다 (예전 점 층 minzoom 과 같음)
    this.root.style.display = tier === "off" ? "none" : "";
    if (tier === "off") return;
    this.setDot(z);
    const cam = this.camera();
    const dotD = this.dotD;

    // 후보: 화면(여유 포함) 안, 우선순위 = 고른 단지 → 화면 안 → 세대수
    type Cand = { d: PinDatum; x: number; y: number; sel: boolean; inView: boolean };
    const cands: Cand[] = [];
    const m = VIEW_MARGIN;
    const wide = Math.max(this.w, this.h) * 0.25;
    for (const d of this.data) {
      const s = this.screenOf(d, cam);
      const sel = d.id === this.selectedId;
      if (!s) continue;
      const inView = s.x > -m && s.x < this.w + m && s.y > -m && s.y < this.h + m * 2;
      // 돌리는 동안 들어올 핀을 위해 화면 둘레 조금 더 (우선순위는 화면 안보다 낮게)
      if (!sel && !inView && !(s.x > -wide && s.x < this.w + wide && s.y > -wide && s.y < this.h + wide)) continue;
      cands.push({ d, x: s.x, y: s.y, sel, inView });
    }
    cands.sort((a, b) => Number(b.sel) - Number(a.sel) || Number(b.inView) - Number(a.inView) || b.d.hh - a.d.hh);

    const dots: Array<{ x: number; y: number }> = [];
    const labels: Rect[] = [];
    const next: Pin[] = [];
    // 점이 이만큼 가까우면 거의 포개진 것 — 낮은 쪽 핀을 뺀다
    const minDot = dotD * 0.8;
    let dropped = 0;
    for (const c of cands) {
      if (next.length >= MAX_PINS) {
        // 한도 넘는 핀(세대수 작은 쪽, 화면 둘레 먼저)은 그리지 않는다
        dropped++;
        continue;
      }
      if (!c.sel && dots.some((q) => Math.abs(q.x - c.x) < minDot && Math.abs(q.y - c.y) < minDot)) continue;
      dots.push({ x: c.x, y: c.y });
      const p = this.pinFor(c.d);
      let noLabel = tier === "dot" && !c.sel;
      if (!noLabel) {
        const two = (c.sel || tier === "value") && c.d.value !== "";
        const w = Math.max(p.wName, two ? p.wVal : 0) + PAD_X;
        const h = (two ? LINE1 + LINE2 : LINE1) + PAD_Y;
        const bottom = c.y - dotD / 2 - LABEL_GAP - (c.sel ? 4 : 0);
        const r: Rect = { x0: c.x - w / 2 - 2, y0: bottom - h - 2, x1: c.x + w / 2 + 2, y1: bottom + 2 };
        if (!c.sel && labels.some((q) => overlaps(q, r))) noLabel = true;
        else labels.push(r);
      }
      if (noLabel !== p.noLabel) {
        p.noLabel = noLabel;
        p.el.classList.toggle("cx-nolabel", noLabel);
      }
      if (c.sel !== p.sel) {
        p.sel = c.sel;
        p.el.classList.toggle("cx-sel", c.sel);
        if (c.sel && !p.arrow) {
          p.arrow = this.arrowTpl.cloneNode(true) as HTMLSpanElement;
          p.el.firstChild!.appendChild(p.arrow);
        } else if (!c.sel && p.arrow) {
          p.arrow.remove();
          p.arrow = null;
        }
      }
      next.push(p);
    }
    this.root.dataset.dropped = String(dropped);

    // DOM 붙이기·떼기 — 앞(우선순위 높은) 핀이 위에 오게 z-index
    const keep = new Set(next);
    for (const p of this.active) {
      if (keep.has(p)) continue;
      p.el.remove();
      p.attached = false;
    }
    next.forEach((p, i) => {
      const zi = p.sel ? MAX_PINS + 1 : MAX_PINS - i;
      if (zi !== p.z) {
        p.z = zi;
        p.el.style.zIndex = String(zi);
      }
      if (!p.attached) {
        p.attached = true;
        p.x = NaN;
        this.root.appendChild(p.el);
      }
    });
    this.active = next;
    this.dirty = false;
    this.position(cam);
  }
}
