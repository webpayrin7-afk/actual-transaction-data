"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronUp, Maximize2, SquareDashed, X } from "lucide-react";
import type { Complex3d } from "@/lib/complex-3d/read";
import { BackLink } from "@/components/layout/BackLink";
import { LabTabs } from "@/components/ui/LabTabs";
import type { Complex3dScene, SceneMode, ViewResult } from "@/components/complex-3d/scene";
import { TYPE_COLORS } from "@/components/complex-3d/palette";
import { fetchComplexTypes } from "@/lib/apt/area-supply";
import { mergeNearSupply, sameSqm, supplyLabels } from "@/lib/apt/type-labels";

async function fetch3d(id: string): Promise<Complex3d> {
  const res = await fetch(`/api/complex-3d/${encodeURIComponent(id)}?v=2`);
  if (!res.ok) throw new Error(res.status === 404 ? "단지를 찾지 못했습니다." : "3D 정보를 불러오지 못했습니다.");
  return res.json();
}

const MODES: Array<{ id: SceneMode; label: string }> = [
  { id: "base", label: "단지" },
  { id: "floors", label: "층별가" },
  { id: "types", label: "평형" },
  { id: "sun", label: "일조" },
  { id: "view", label: "조망" },
  { id: "around", label: "주변" },
];

const SEASONS = [
  { id: "winter", label: "동지", md: [12, 21] },
  { id: "equinox", label: "춘·추분", md: [3, 20] },
  { id: "summer", label: "하지", md: [6, 21] },
] as const;
type Season = (typeof SEASONS)[number]["id"];

const DIRS = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
const dirOf = (deg: number) => DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
const man = (v: number) => (v >= 10_000 ? `${(v / 10_000).toFixed(2)}억` : `${Math.round(v).toLocaleString("ko-KR")}만`);

const FLOAT = "bg-white/95 shadow-[0_2px_10px_rgba(15,23,42,0.14)] backdrop-blur";

/** 3D 단지 탐색 — 화면 전체가 모형, 위·오른쪽·아래에 떠 있는 조작 */
export function Complex3dPage({ complexId }: { complexId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Complex3dScene | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<SceneMode>("base");
  const [selected, setSelected] = useState<string | null>(null);
  const [season, setSeason] = useState<Season>("winter");
  const [hour, setHour] = useState(14);
  const [sunInfo, setSunInfo] = useState<{ altitude: number; azimuth: number } | null>(null);
  const [viewFloor, setViewFloor] = useState(10);
  const [view, setView] = useState<ViewResult | null>(null);
  const [webglError, setWebglError] = useState(false);
  const [nearest, setNearest] = useState<{ dong: string | null; meters: number } | null>(null);
  const [heading, setHeading] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [sheetH, setSheetH] = useState(80);
  const [pickedType, setPickedType] = useState<string | null>(null);
  // 모바일에서 시트가 가리는 만큼 모형 중심을 위로 (넓은 화면은 시트가 옆에 떠 있어 그대로)
  useEffect(() => {
    const el = sheetRef.current;
    if (!el || !ready) return;
    const sync = () => {
      setSheetH(el.offsetHeight);
      sceneRef.current?.setBottomInset(window.innerWidth < 640 ? el.offsetHeight : 0);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);
  const [dragDy, setDragDy] = useState<number | null>(null);
  const [sheetMax, setSheetMax] = useState(340);
  useEffect(() => {
    const sync = () => setSheetMax(Math.round(window.innerHeight * 0.42));
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  const contentHeight = Math.max(0, Math.min(sheetMax, (sheetOpen ? sheetMax : 0) - (dragDy ?? 0)));
  // 시트 손잡이·요약 줄·출처 줄을 위아래로 끌어 열고 닫기 (짧게 누르면 토글)
  const endDrag = (dy: number) => {
    const d0 = drag.current;
    drag.current = null;
    setDragDy(null);
    if (!d0) return;
    if (!d0.moved) setSheetOpen((v) => !v);
    else setSheetOpen((v) => (v ? dy < 60 : dy < -40));
  };
  const dragHandlers = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      drag.current = { y: e.clientY, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      const dy = e.clientY - drag.current.y;
      if (Math.abs(dy) > 6) drag.current.moved = true;
      if (drag.current.moved) setDragDy(dy);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => endDrag(e.clientY - (drag.current?.y ?? e.clientY)),
    onPointerCancel: () => endDrag(dragDy ?? 0),
  };

  // 모형을 끌 때 브라우저가 같이 당겨지지 않게 (당겨서 새로고침·바운스 끄기)
  useEffect(() => {
    const html = document.documentElement;
    const prev = [html.style.overscrollBehavior, document.body.style.overflow];
    html.style.overscrollBehavior = "none";
    document.body.style.overflow = "hidden";
    return () => {
      html.style.overscrollBehavior = prev[0]!;
      document.body.style.overflow = prev[1]!;
    };
  }, []);

  const query = useQuery({ queryKey: ["complex-3d", complexId], queryFn: () => fetch3d(complexId), staleTime: 60 * 60_000 });
  const d = query.data;
  const hasShape = (d?.coverage.withShape ?? 0) > 0;

  // 평형 범례 — 단지 안 평형을 작은 것부터, 동별 주력 평형 수와 세대 합계
  const typeLegend = useMemo(() => {
    if (!d) return [];
    const byLabel = new Map<string, { households: number; mainDongs: string[] }>();
    for (const b of d.buildings) {
      for (const u of b.units) {
        const e = byLabel.get(u.label) ?? { households: 0, mainDongs: [] };
        e.households += u.households;
        byLabel.set(u.label, e);
      }
      const top = b.units[0];
      if (top && b.dong) byLabel.get(top.label)!.mainDongs.push(b.dong);
    }
    const pyeong = (l: string) => Number(/(\d+(?:\.\d+)?)/.exec(l)?.[1] ?? 0);
    return [...byLabel.entries()]
      .sort((a, b) => pyeong(a[0]) - pyeong(b[0]))
      .map(([label, v], i) => ({ label, ...v, color: TYPE_COLORS[i % TYPE_COLORS.length]! }));
  }, [d]);

  // 타입 (단지 상세 타입·동과 같은 이름·합치기) — 고르면 그 타입이 있는 동만 색칠
  const typesQuery = useQuery({
    queryKey: ["complex-types", complexId],
    queryFn: () => fetchComplexTypes(complexId),
    staleTime: 60 * 60_000,
  });
  const typeOptions = useMemo(() => {
    const merged = mergeNearSupply(typesQuery.data?.types ?? []).filter((t) => t.supplySqm != null && t.dongs.length);
    const labels = supplyLabels(merged);
    return [...merged]
      .sort((a, b) => (a.supplySqm ?? 0) - (b.supplySqm ?? 0) || a.exclusiveSqm - b.exclusiveSqm)
      .map((t, i) => ({
        id: t.id,
        label: labels.get(t.id) ?? `${t.supplySqm}㎡`,
        exclusive: t.exclusiveSqm,
        supply: t.supplySqm!,
        households: t.households ?? t.dongs.reduce((n, x) => n + x.households, 0),
        dongs: new Set(t.dongs.map((x) => x.dong)),
        color: TYPE_COLORS[i % TYPE_COLORS.length]!,
      }));
  }, [typesQuery.data]);
  const picked = typeOptions.find((t) => t.id === pickedType) ?? null;

  useEffect(() => {
    const s = sceneRef.current;
    if (!s || !d) return;
    if (mode !== "base" || !picked) {
      s.setHighlight(null);
      return;
    }
    s.setHighlight(new Set(d.buildings.filter((b) => b.dong && picked.dongs.has(b.dong)).map((b) => b.id)), picked.color);
  }, [picked, mode, d, ready]);

  // 동 목록 (모양이 있는 주거동, 동 번호 순)
  const dongs = useMemo(
    () =>
      (d?.buildings ?? [])
        .filter((b) => b.rings && b.dong)
        .sort((a, b) => a.dong!.localeCompare(b.dong!, "ko", { numeric: true })),
    [d],
  );

  // 장면 만들기 (three.js는 이 화면에서만 불러온다)
  useEffect(() => {
    if (!d || !hasShape || !hostRef.current) return;
    let scene: Complex3dScene | null = null;
    let cancelled = false;
    const host = hostRef.current;
    import("@/components/complex-3d/scene")
      .then(({ Complex3dScene }) => {
        if (cancelled) return;
        try {
          scene = new Complex3dScene(host);
        } catch {
          setWebglError(true);
          return;
        }
        scene.setData(d);
        // 바닥 지도 — Static Map level 15, scale=2 이미지는 한 변이 월드 px 512 (웹 메르카토르 미터/px × 512 ≈ 1.9km)
        const mpp = (40075016.686 * Math.cos((d.center.lat * Math.PI) / 180)) / (256 * 2 ** 15);
        scene.setGroundMap(`/api/complex-3d/${d.complexId}/ground?v=2`, 512 * mpp);
        scene.setFloorBands(d.floorBands);
        scene.setPois(d.pois);
        const colors = new Map(typeLegend.map((t) => [t.label, t.color]));
        scene.setTypeColors((label) => colors.get(label) ?? "#d5dbe1");
        const s = scene;
        s.onSelect = (id) => {
          setSelected(id);
          setNearest(id ? s.nearestDistance(id) : null);
        };
        s.onHeading = setHeading;
        sceneRef.current = scene;
        setReady(true);
      })
      .catch(() => setWebglError(true));
    const onResize = () => scene?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      scene?.dispose();
      sceneRef.current = null;
      setReady(false);
    };
  }, [d, hasShape, typeLegend]);

  useEffect(() => {
    sceneRef.current?.setMode(mode);
    sceneRef.current?.setShadows(mode === "sun" || mode === "base" || mode === "view");
  }, [mode, ready]);

  useEffect(() => {
    const s = SEASONS.find((x) => x.id === season)!;
    const date = new Date(Date.UTC(new Date().getFullYear(), s.md[0] - 1, s.md[1]));
    const p = sceneRef.current?.setSun(date, hour);
    if (p) setSunInfo(p);
  }, [season, hour, ready]);

  const sel = useMemo(() => d?.buildings.find((b) => b.id === selected) ?? null, [d, selected]);

  // 조망 계산 — 고른 동과 층이 바뀔 때
  useEffect(() => {
    if (mode !== "view" || !selected || !ready) return;
    const t = window.setTimeout(() => setView(sceneRef.current?.computeView(selected, viewFloor) ?? null), 60);
    return () => window.clearTimeout(t);
  }, [mode, selected, viewFloor, ready]);

  const estimated = (d?.buildings ?? []).some((b) => b.rings && !(b.heightM && b.heightM > 0));
  const maxFloors = sel?.floors ?? 1;
  const floorNow = Math.min(viewFloor, maxFloors);

  const pickDong = (id: string) => {
    const s = sceneRef.current;
    if (!s) return;
    s.select(id);
    s.focus(id);
    setSelected(id);
    setNearest(s.nearestDistance(id));
  };

  // 고른 동의 호 라인을 타입별로 묶기 (고른 타입이 먼저)
  const selLines = useMemo(() => {
    if (!sel) return [];
    const groups = new Map<string, { label: string; color: string | null; supply: number; lines: string[] }>();
    for (const l of sel.lines ?? []) {
      const t = typeOptions.find((x) => sameSqm(x.exclusive, l.exclusive) && Math.abs(x.supply - l.supply) < 1) ?? null;
      const key = t?.id ?? `ex${l.exclusive}`;
      const g = groups.get(key) ?? { label: t?.label ?? `전용 ${l.exclusive}㎡`, color: t?.color ?? null, supply: l.supply, lines: [] };
      g.lines.push(String(Number(l.line)));
      groups.set(key, g);
    }
    return [...groups.entries()]
      .sort((a, b) => Number(b[0] === pickedType) - Number(a[0] === pickedType) || a[1].supply - b[1].supply)
      .map(([id, g]) => ({ id, ...g }));
  }, [sel, typeOptions, pickedType]);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // 시트를 접었을 때 한 줄 요약
  const summary =
    mode === "base"
      ? picked
        ? `${picked.label} · 동 ${picked.dongs.size}개 · ${picked.households.toLocaleString("ko-KR")}세대`
        : `동 ${dongs.length}개 · 타입이나 동을 골라 보세요`
      : mode === "floors"
        ? `층 구간별 3.3㎡당 가격 · ${d?.floorBandsBasis ?? ""}`
        : mode === "types"
          ? `평형 ${typeLegend.length}개 · 동별 주력 평형 색`
          : mode === "sun"
            ? `${SEASONS.find((x) => x.id === season)!.label} ${String(hour).padStart(2, "0")}:00 · ${
                sunInfo && sunInfo.altitude > 0
                  ? `해 ${Math.round((sunInfo.altitude * 180) / Math.PI)}° ${dirOf((sunInfo.azimuth * 180) / Math.PI)}쪽`
                  : "해 진 뒤"
              }`
            : mode === "view"
              ? sel
                ? `${sel.dong ?? "이 동"} ${floorNow}층 · 트인 방향 ${view ? Math.round(view.openShare * 100) : "—"}%`
                : "조망을 볼 동을 눌러 주세요"
              : `학교·역 ${d?.pois.length ?? 0}곳`;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#f4f7f9]" style={{ touchAction: "none", overscrollBehavior: "none" }}>
      {/* 캔버스 — 화면 전체 */}
      <div ref={hostRef} className="absolute inset-0 touch-none" style={{ isolation: "isolate" }} />
      {query.isLoading ? <div className="absolute inset-0 flex items-center justify-center detail-meta">3D 모형을 불러오는 중…</div> : null}
      {query.isError ? <div className="absolute inset-0 flex items-center justify-center detail-body">{(query.error as Error).message}</div> : null}
      {d && !hasShape ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="detail-subsection-title">아직 이 단지의 건물 모양 데이터가 없어요</p>
          <p className="detail-meta">
            국토교통부 GIS건물통합정보를 순서대로 적재하고 있어요. 동 {d.coverage.buildings}개의 층수·세대수는 이미 있어요.
          </p>
        </div>
      ) : null}
      {webglError ? (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center detail-body">
          이 기기에서는 3D 화면(WebGL)을 켤 수 없어요.
        </div>
      ) : null}

      {/* 위: 뒤로·단지명 · 모드 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-2 pt-[calc(env(safe-area-inset-top)+8px)]">
        <div className="flex items-center gap-2 px-3">
          <div className={`pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${FLOAT}`}>
            <BackLink fallback={d?.href ?? "/complexes"} compact hideLabel />
          </div>
          <div className={`pointer-events-auto min-w-0 rounded-full px-3.5 py-1.5 ${FLOAT}`}>
            <p className="truncate text-[15px] font-bold leading-5 text-[color:var(--lab-navy-950)]">{d?.name ?? "3D 단지 탐색"}</p>
            {d ? <p className="truncate text-[11px] leading-4 text-[color:var(--lab-muted)]">{d.place}</p> : null}
          </div>
        </div>
        <div className="pointer-events-auto flex gap-1.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              aria-pressed={mode === m.id}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition active:scale-95 ${
                mode === m.id
                  ? "bg-[color:var(--lab-brand-primary)] text-white shadow-[0_2px_10px_rgba(15,118,110,0.35)]"
                  : `${FLOAT} text-[color:var(--lab-navy-950)]`
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {d && hasShape && d.coverage.withShape < d.coverage.buildings ? (
          <p className={`mx-3 self-start rounded-md px-2 py-1 text-[11px] text-[color:var(--lab-muted)] ${FLOAT}`}>
            동 {d.coverage.buildings}개 중 {d.coverage.withShape}개 모양 · 나머지는 준비 중
          </p>
        ) : null}
      </div>

      {/* 오른쪽: 나침반 · 단지 전체 · 위에서 보기 */}
      {ready ? (
        <div className="absolute right-3 z-10 flex flex-col gap-2" style={{ top: "calc(env(safe-area-inset-top) + 104px)" }}>
          <button
            type="button"
            onClick={() => sceneRef.current?.northUp()}
            aria-label="북쪽을 위로"
            className={`flex h-10 w-10 items-center justify-center rounded-full ${FLOAT} active:scale-95`}
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" style={{ transform: `rotate(${heading}deg)` }} aria-hidden>
              <path d="M12 3 L15.5 12 H8.5 Z" fill="#e11d48" />
              <path d="M12 21 L8.5 12 H15.5 Z" fill="#94a3b8" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => sceneRef.current?.resetView()}
            aria-label="단지 전체 보기"
            className={`flex h-10 w-10 items-center justify-center rounded-full ${FLOAT} active:scale-95`}
          >
            <Maximize2 className="h-[18px] w-[18px] text-[color:var(--lab-navy-950)]" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => sceneRef.current?.topView()}
            aria-label="위에서 보기"
            className={`flex h-10 w-10 items-center justify-center rounded-full ${FLOAT} active:scale-95`}
          >
            <SquareDashed className="h-[18px] w-[18px] text-[color:var(--lab-navy-950)]" aria-hidden />
          </button>

        </div>
      ) : null}

      {/* 고른 동 정보 — 시트와 따로, 시트 바로 위에 떠 있다 */}
      {sel && d && hasShape && mode !== "around" && mode !== "sun" ? (
        <div
          className="absolute left-3 right-3 z-20 sm:right-auto sm:w-[400px]"
          style={{ bottom: sheetH + (wide ? 20 : 8), transition: dragDy == null ? "bottom 220ms ease" : "none" }}
        >
          <DongCard
            sel={sel}
            nearest={nearest}
            lines={selLines}
            onClose={() => {
              sceneRef.current?.select(null);
              setSelected(null);
              setNearest(null);
            }}
          />
        </div>
      ) : null}

      {/* 아래: 접히는 시트 — 접으면 한 줄 요약, 펼치면 모드별 내용 */}
      {d && hasShape ? (
        <div ref={sheetRef} className="absolute inset-x-0 bottom-0 z-10 sm:bottom-3 sm:left-3 sm:right-auto sm:w-[400px]">
          <div className="rounded-t-2xl bg-white shadow-[0_-4px_20px_rgba(15,23,42,0.12)] sm:rounded-2xl">
            <button
              type="button"
              {...dragHandlers}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSheetOpen((v) => !v);
                }
              }}
              aria-expanded={sheetOpen}
              className="flex w-full touch-none select-none flex-col items-stretch px-4 pb-2.5 pt-2 text-left"
            >
              <span className="mx-auto mb-2 h-1 w-9 rounded-full bg-slate-200 sm:hidden" aria-hidden />
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tabular-nums text-[color:var(--lab-navy-950)]">
                  {summary}
                </span>
                <ChevronUp
                  className={`hidden h-4 w-4 shrink-0 text-slate-400 transition sm:block ${sheetOpen ? "rotate-180" : ""}`}
                  aria-hidden
                />
              </span>
            </button>

            {/* 조작은 접어도 보인다 — 타입 고르기, 일조 시각, 조망 층 */}
            {mode === "base" && typeOptions.length ? (
              <div
                className="flex gap-1.5 overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                style={{ touchAction: "pan-x" }}
              >
                {[{ id: null as string | null, label: "전체 타입", color: null as string | null }, ...typeOptions].map((t) => {
                  const on = pickedType === t.id;
                  return (
                    <button
                      key={t.id ?? "all"}
                      type="button"
                      onClick={() => setPickedType(t.id)}
                      aria-pressed={on}
                      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold tabular-nums transition active:scale-95 ${
                        on
                          ? "border-[color:var(--lab-navy-950)] bg-[color:var(--lab-navy-950)] text-white"
                          : "border-[color:var(--lab-border)] bg-white text-[color:var(--lab-navy-950)]"
                      }`}
                    >
                      {t.color ? <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} aria-hidden /> : null}
                      {t.label}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {mode === "sun" ? (
              <div className="flex flex-col gap-2 px-4 pb-3">
                <LabTabs
                  variant="compact"
                  ariaLabel="계절"
                  items={SEASONS.map((s) => ({ id: s.id, label: s.label }))}
                  value={season}
                  onChange={setSeason}
                />
                <input
                  type="range"
                  min={6}
                  max={19}
                  step={1}
                  value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                  className="w-full accent-[color:var(--lab-brand-primary)]"
                  aria-label="시각"
                />
              </div>
            ) : null}
            {mode === "view" && sel ? (
              <div className="px-4 pb-3">
                <input
                  type="range"
                  min={1}
                  max={Math.max(1, maxFloors)}
                  step={1}
                  value={floorNow}
                  onChange={(e) => setViewFloor(Number(e.target.value))}
                  className="w-full accent-[color:var(--lab-brand-primary)]"
                  aria-label="층"
                />
              </div>
            ) : null}

            {/* 펼친 내용 — 드래그하는 동안 손가락을 따라 높이가 바뀌고, 놓으면 열림·닫힘으로 붙는다 */}
            <div
              aria-hidden={!sheetOpen && dragDy == null}
              style={{
                maxHeight: contentHeight,
                overflowY: sheetOpen && dragDy == null ? "auto" : "hidden",
                transition: dragDy == null ? "max-height 220ms ease" : "none",
                touchAction: "pan-y",
                overscrollBehavior: "contain",
              }}
            >
              <div className="px-4 pb-3 pt-1">
                {mode === "base" ? (
                  <div className="flex flex-col gap-3">
                    <div>
                      <div className="flex flex-wrap gap-1.5">
                        {dongs.map((b) => (
                          <button
                            key={b.id}
                            type="button"
                            onClick={() => pickDong(b.id)}
                            className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold tabular-nums transition active:scale-95 ${
                              b.id === selected
                                ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] text-[color:var(--lab-teal-700)]"
                                : picked && b.dong && !picked.dongs.has(b.dong)
                                  ? "border-[color:var(--lab-border)] text-slate-300"
                                  : "border-[color:var(--lab-border)] text-[color:var(--lab-navy-950)]"
                            }`}
                            style={picked && b.dong && picked.dongs.has(b.dong) && b.id !== selected ? { borderColor: picked.color } : undefined}
                          >
                            {b.dong}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}

                {mode === "floors" ? (
                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-3 gap-2">
                      {d.floorBands.map((b) => (
                        <div key={b.label} className="rounded-lg border border-[color:var(--lab-border)] px-2.5 py-2">
                          <p className="detail-label">
                            {b.label} {b.fromFloor}~{b.toFloor}층
                          </p>
                          <p className="detail-data-value-emphasis tabular-nums">{b.perPyeong != null ? man(b.perPyeong) : "—"}</p>
                          <p className="detail-meta tabular-nums">{b.count}건</p>
                        </div>
                      ))}
                    </div>
                    <p className="detail-meta">색이 진할수록 비싼 층 구간이에요.</p>
                  </div>
                ) : null}

                {mode === "types" ? (
                  typeLegend.length ? (
                    <div className="flex flex-col gap-2">
                      <ul className="flex flex-col gap-1.5">
                        {typeLegend.map((t) => (
                          <li key={t.label} className="flex items-start gap-2">
                            <span className="mt-1 h-3 w-3 shrink-0 rounded-sm" style={{ background: t.color }} aria-hidden />
                            <span className="min-w-0 flex-1">
                              <span className="detail-data-value tabular-nums">{t.label}</span>
                              <span className="detail-meta ml-1.5 tabular-nums">{t.households.toLocaleString("ko-KR")}세대</span>
                              {t.mainDongs.length ? <span className="detail-meta block">주력 동 {t.mainDongs.join(", ")}</span> : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                      </div>
                  ) : (
                    <p className="detail-body">이 단지는 동별 평형 정보가 아직 없어요.</p>
                  )
                ) : null}

                {mode === "sun" ? (
                  <p className="detail-meta">
                    계절과 시각을 바꾸면 그 시각의 그림자가 보여요. 주변 건물 모양이 없는 곳은 그림자가 빠질 수 있어요.
                  </p>
                ) : null}

                {mode === "view" ? (
                  sel && view ? (
                    <div className="flex flex-col gap-2">
                      <p className="detail-body tabular-nums">
                        {sel.dong ?? "이 동"} {floorNow}층 눈높이에서 200m 안에 가리는 건물이 없는 방향이{" "}
                        <b>{Math.round(view.openShare * 100)}%</b>예요.
                      </p>
                      <OpenDirections view={view} />
                      <p className="detail-meta">
                        청록 = 200m 이상 트임 · 주황 = 80~200m · 빨강 = 80m 안 가림. 주변 건물 모양이 없는 곳은 트인 것으로 보일 수 있어요.
                      </p>
                    </div>
                  ) : (
                    <p className="detail-body">모형에서 동을 누르면 층별 조망을 계산해요.</p>
                  )
                ) : null}

                {mode === "around" ? (
                  d.pois.length ? (
                    <ul className="divide-y divide-[color:var(--lab-border)]">
                      {d.pois.map((p) => (
                        <li key={`${p.kind}-${p.name}`} className="flex items-center justify-between gap-3 py-2">
                          <span className="min-w-0">
                            <span className="detail-data-value">{p.name}</span>
                            <span className="detail-meta ml-1.5">{p.kind === "school" ? schoolLevel(p.sub) : p.sub}</span>
                          </span>
                          <span className="detail-meta shrink-0 tabular-nums">
                            직선 {p.distanceM.toLocaleString("ko-KR")}m · 약 {Math.max(1, Math.round(p.distanceM / 67))}분
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="detail-body">주변 학교·역 정보가 없어요.</p>
                  )
                ) : null}
              </div>
            </div>

            <p {...dragHandlers} className="touch-none select-none px-4 pb-[calc(env(safe-area-inset-bottom)+6px)] text-[10px] leading-4 text-[color:var(--lab-muted)] sm:pb-2">
              건물: 국토교통부 GIS건물통합정보 · 지도 © NAVER Corp.{estimated ? " · 일부 높이는 층수×3m" : ""}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DongCard({
  sel,
  nearest,
  lines,
  onClose,
}: {
  sel: Complex3d["buildings"][number];
  nearest: { dong: string | null; meters: number } | null;
  lines: Array<{ id: string; label: string; color: string | null; lines: string[] }>;
  onClose: () => void;
}) {
  const main = [
    sel.floors ? `${sel.floors}층` : null,
    sel.households ? `${sel.households.toLocaleString("ko-KR")}세대` : null,
    nearest ? `옆 동 ${nearest.meters}m` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="rounded-2xl border border-[color:var(--lab-brand-border)] bg-white px-3.5 py-2.5 shadow-[0_4px_16px_rgba(15,23,42,0.14)]">
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-bold text-[color:var(--lab-teal-700)]">{sel.dong ?? sel.name ?? "동"}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tabular-nums text-[color:var(--lab-navy-950)]">{main}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 active:scale-95"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {lines.length ? (
        <ul className="mt-1 flex flex-col gap-0.5">
          {lines.map((g) => (
            <li key={g.id} className="flex items-center gap-1.5 text-[12px] leading-[18px] tabular-nums text-[color:var(--lab-navy-950)]">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: g.color ?? "#cbd5e1" }} aria-hidden />
              <span className="font-semibold">{g.label}</span>
              <span className="text-[color:var(--lab-muted)]">{g.lines.join("·")}호 라인</span>
            </li>
          ))}
        </ul>
      ) : sel.units.length ? (
        <p className="mt-1 text-[12px] leading-[18px] tabular-nums text-[color:var(--lab-muted)]">
          {sel.units.map((u) => `${u.label} ${u.households}세대`).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function schoolLevel(v: string | null): string {
  return v === "elementary" ? "초등학교" : v === "middle" ? "중학교" : v === "high" ? "고등학교" : v ?? "";
}

/** 8방위별로 트임(200m+) 비율 */
function OpenDirections({ view }: { view: ViewResult }) {
  const sectors = DIRS.map((label, i) => {
    const rays = view.rays.filter((r) => Math.round((((r.azimuth % 360) + 360) % 360) / 45) % 8 === i);
    const open = rays.filter((r) => r.distance == null || r.distance >= 200).length / Math.max(1, rays.length);
    const nearestHit = Math.min(...rays.map((r) => r.distance ?? Infinity));
    return { label, open, nearestHit };
  });
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {sectors.map((s) => (
        <div
          key={s.label}
          className="rounded-md border px-2 py-1.5 text-center"
          style={{
            borderColor: s.open >= 0.6 ? "var(--lab-brand-border)" : "var(--lab-border)",
            background: s.open >= 0.6 ? "var(--lab-brand-subtle)" : "white",
          }}
        >
          <p className="detail-label">{s.label}</p>
          <p className="detail-meta tabular-nums">
            {s.open >= 0.6 ? "트임" : Number.isFinite(s.nearestHit) ? `${s.nearestHit}m 가림` : "트임"}
          </p>
        </div>
      ))}
    </div>
  );
}
