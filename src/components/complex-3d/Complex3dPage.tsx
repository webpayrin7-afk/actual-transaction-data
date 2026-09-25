"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  Maximize2,
  SquareDashed,
  X,
} from "lucide-react";
import type { Complex3d } from "@/lib/complex-3d/read";
import { BackLink } from "@/components/layout/BackLink";
import { InfoTip } from "@/components/ui/InfoTip";
import type {
  Complex3dScene,
  SceneMode,
  SunHours,
  ViewResult,
  DongContext,
} from "@/components/complex-3d/scene";
import { TYPE_COLORS } from "@/components/complex-3d/palette";
import { fetchComplexTypes } from "@/lib/apt/area-supply";
import { mergeNearSupply, sameSqm, supplyLabels } from "@/lib/apt/type-labels";

async function fetch3d(id: string): Promise<Complex3d> {
  const res = await fetch(`/api/complex-3d/${encodeURIComponent(id)}?v=2`);
  if (!res.ok)
    throw new Error(
      res.status === 404
        ? "단지를 찾지 못했습니다."
        : "3D 정보를 불러오지 못했습니다.",
    );
  return res.json();
}

const MODES: Array<{ id: SceneMode; label: string }> = [
  { id: "base", label: "동 정보" },
  { id: "floors", label: "층별가" },
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
const dirOf = (deg: number) =>
  DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
const man = (v: number) =>
  v >= 10_000
    ? `${(v / 10_000).toFixed(2)}억`
    : `${Math.round(v).toLocaleString("ko-KR")}만`;

const FLOAT =
  "bg-white/95 shadow-[0_2px_10px_rgba(15,23,42,0.14)] backdrop-blur";

/** 3D 단지 탐색 — 화면 전체가 모형, 위·오른쪽·아래에 떠 있는 조작 */
export function Complex3dPage({ complexId }: { complexId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Complex3dScene | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<SceneMode>("base");
  const [selected, setSelected] = useState<string | null>(null);
  const [season, setSeason] = useState<Season>("winter");
  const [hour, setHour] = useState(14);
  const [sunInfo, setSunInfo] = useState<{
    altitude: number;
    azimuth: number;
  } | null>(null);
  const [viewFloor, setViewFloor] = useState(10);
  const [view, setView] = useState<ViewResult | null>(null);
  const [webglError, setWebglError] = useState(false);
  const [nearest, setNearest] = useState<DongContext | null>(null);
  const [heading, setHeading] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToastRef = useRef<(msg: string) => void>(() => {});
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  };
  useEffect(() => {
    showToastRef.current = showToast;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelH, setPanelH] = useState(0);
  const [sunStats, setSunStats] = useState<SunHours | null>(null);
  const [pickedType, setPickedType] = useState<string | null>(null);
  const [picker, setPicker] = useState<"dong" | "type" | null>(null);
  // 모바일에서 아래 정보 패널이 가리는 만큼 모형 중심을 위로 (넓은 화면은 패널이 옆에 떠 있어 그대로)
  useEffect(() => {
    if (!ready) return;
    const sync = () => {
      const panel = panelRef.current?.offsetHeight ?? 0;
      setPanelH(panel);
      sceneRef.current?.setBottomInset(
        window.innerWidth < 640 && panel ? panel + 24 : 0,
      );
    };
    sync();
    const ro = new ResizeObserver(sync);
    if (panelRef.current) ro.observe(panelRef.current);
    return () => ro.disconnect();
  }, [ready, mode, selected, pickedType]);

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

  const query = useQuery({
    queryKey: ["complex-3d", complexId],
    queryFn: () => fetch3d(complexId),
    staleTime: 60 * 60_000,
  });
  const d = query.data;
  const hasShape = (d?.coverage.withShape ?? 0) > 0;

  // 타입 (단지 상세 타입·동과 같은 이름·합치기) — 고르면 그 타입이 있는 동만 색칠
  const typesQuery = useQuery({
    queryKey: ["complex-types", complexId],
    queryFn: () => fetchComplexTypes(complexId),
    staleTime: 60 * 60_000,
  });
  const typeOptions = useMemo(() => {
    const merged = mergeNearSupply(typesQuery.data?.types ?? []).filter(
      (t) => t.supplySqm != null && t.dongs.length,
    );
    const labels = supplyLabels(merged);
    return [...merged]
      .sort(
        (a, b) =>
          (a.supplySqm ?? 0) - (b.supplySqm ?? 0) ||
          a.exclusiveSqm - b.exclusiveSqm,
      )
      .map((t, i) => ({
        id: t.id,
        label: labels.get(t.id) ?? `${t.supplySqm}㎡`,
        exclusive: t.exclusiveSqm,
        supply: t.supplySqm!,
        households:
          t.households ?? t.dongs.reduce((n, x) => n + x.households, 0),
        dongs: new Set(t.dongs.map((x) => x.dong)),
        color: TYPE_COLORS[i % TYPE_COLORS.length]!,
      }));
  }, [typesQuery.data]);
  const picked = typeOptions.find((t) => t.id === pickedType) ?? null;

  useEffect(() => {
    const s = sceneRef.current;
    if (!s || !d) return;
    if (mode === "floors" || !picked) {
      s.setHighlight(null);
      return;
    }
    s.setHighlight(
      new Set(
        d.buildings
          .filter((b) => b.dong && picked.dongs.has(b.dong))
          .map((b) => b.id),
      ),
      picked.color,
    );
  }, [picked, mode, d, ready]);

  // 고른 타입 요약 — 이 타입이 있는 동을 "몇 호 라인"이 같은 것끼리 묶는다
  const typeGroups = useMemo(() => {
    if (!picked || !d) return [];
    const byKey = new Map<string, string[]>();
    for (const b of d.buildings) {
      if (!b.dong || !picked.dongs.has(b.dong)) continue;
      const own = [
        ...new Set(
          (b.lines ?? [])
            .filter(
              (l) =>
                sameSqm(l.exclusive, picked.exclusive) &&
                Math.abs(l.supply - picked.supply) < 1,
            )
            .map((l) => Number(l.line)),
        ),
      ].sort((x, y) => x - y);
      const key = own.length ? `${own.join("·")}호 라인` : "라인 정보 없음";
      byKey.set(key, [...(byKey.get(key) ?? []), b.dong]);
    }
    const num = (s: string) => Number(/\d+/.exec(s)?.[0] ?? 0);
    return [...byKey.entries()]
      .map(([key, list]) => ({
        key,
        dongs: list.sort((a, b) => a.localeCompare(b, "ko", { numeric: true })),
      }))
      .sort((a, b) =>
        a.key === "라인 정보 없음"
          ? 1
          : b.key === "라인 정보 없음"
            ? -1
            : b.dongs.length - a.dongs.length || num(a.key) - num(b.key),
      );
  }, [picked, d]);

  // 동 목록 (모양이 있는 주거동, 동 번호 순)
  const dongs = useMemo(
    () =>
      (d?.buildings ?? [])
        .filter((b) => b.rings && b.dong)
        .sort((a, b) =>
          a.dong!.localeCompare(b.dong!, "ko", { numeric: true }),
        ),
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
        const mpp =
          (40075016.686 * Math.cos((d.center.lat * Math.PI) / 180)) /
          (256 * 2 ** 15);
        scene.setGroundMap(
          `/api/complex-3d/${d.complexId}/ground?v=2`,
          512 * mpp,
        );
        scene.setFloorBands(d.floorBands);
        scene.setPois(d.pois);
        const s = scene;
        s.onSelect = (id) => {
          setSelected(id);
          setNearest(id ? s.dongContext(id) : null);
          if (id) showToastRef.current("두 번 누르면 해당 동으로 이동합니다");
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
  }, [d, hasShape]);

  useEffect(() => {
    sceneRef.current?.setMode(mode);
    sceneRef.current?.setShadows(
      mode === "sun" || mode === "base" || mode === "view",
    );
  }, [mode, ready]);

  useEffect(() => {
    const s = SEASONS.find((x) => x.id === season)!;
    const date = new Date(
      Date.UTC(new Date().getFullYear(), s.md[0] - 1, s.md[1]),
    );
    const p = sceneRef.current?.setSun(date, hour);
    if (p) setSunInfo(p);
  }, [season, hour, ready]);

  const sel = useMemo(
    () => d?.buildings.find((b) => b.id === selected) ?? null,
    [d, selected],
  );

  // 일조 시간 — 고른 동·층·계절이 바뀔 때
  useEffect(() => {
    if (mode !== "sun" || !selected || !ready) return;
    const t = window.setTimeout(() => {
      const se = SEASONS.find((x) => x.id === season)!;
      const date = new Date(
        Date.UTC(new Date().getFullYear(), se.md[0] - 1, se.md[1]),
      );
      setSunStats(
        sceneRef.current?.computeSunHours(selected, viewFloor, date) ?? null,
      );
    }, 60);
    return () => window.clearTimeout(t);
  }, [mode, selected, viewFloor, season, ready]);

  // 주변 — 표시한 곳이 모두 보이게
  // 주변에서 다른 탭으로 나오면 — 고른 동이 있으면 그 동으로, 없으면 단지 전체로
  const prevMode = useRef<SceneMode>(mode);
  useEffect(() => {
    if (!ready) return;
    const from = prevMode.current;
    prevMode.current = mode;
    let run: (() => void) | null = null;
    if (mode === "around") run = () => sceneRef.current?.fitPois();
    else if (from === "around")
      run = () =>
        selected
          ? sceneRef.current?.focus(selected)
          : sceneRef.current?.resetView();
    if (!run) return;
    // 정보 패널 높이가 잡힌 뒤에 맞춘다
    const t = window.setTimeout(run, 350);
    return () => window.clearTimeout(t);
    // 고른 동이 바뀔 때는 다시 맞추지 않는다 (탭을 바꿀 때만)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ready]);

  // 조망 계산 — 고른 동과 층이 바뀔 때
  useEffect(() => {
    if (mode !== "view" || !selected || !ready) return;
    const t = window.setTimeout(
      () => setView(sceneRef.current?.computeView(selected, viewFloor) ?? null),
      60,
    );
    return () => window.clearTimeout(t);
  }, [mode, selected, viewFloor, ready]);

  const maxFloors = sel?.floors ?? 1;
  const floorNow = Math.min(viewFloor, maxFloors);

  const pickDong = (id: string) => {
    const s = sceneRef.current;
    if (!s) return;
    s.select(id);
    s.focus(id);
    setSelected(id);
    setNearest(s.dongContext(id));
  };

  // 고른 동의 호 라인을 타입별로 묶기 (고른 타입이 먼저)
  const selLines = useMemo(() => {
    if (!sel) return [];
    const groups = new Map<
      string,
      { label: string; color: string | null; supply: number; lines: string[] }
    >();
    for (const l of sel.lines ?? []) {
      const t =
        typeOptions.find(
          (x) =>
            sameSqm(x.exclusive, l.exclusive) &&
            Math.abs(x.supply - l.supply) < 1,
        ) ?? null;
      const key = t?.id ?? `ex${l.exclusive}`;
      const g = groups.get(key) ?? {
        label: t?.label ?? `전용 ${l.exclusive}㎡`,
        color: t?.color ?? null,
        supply: l.supply,
        lines: [],
      };
      g.lines.push(String(Number(l.line)));
      groups.set(key, g);
    }
    return [...groups.entries()]
      .sort(
        (a, b) =>
          Number(b[0] === pickedType) - Number(a[0] === pickedType) ||
          a[1].supply - b[1].supply,
      )
      .map(([id, g]) => ({ id, ...g }));
  }, [sel, typeOptions, pickedType]);
  const closeDong = () => {
    sceneRef.current?.select(null);
    setSelected(null);
    setNearest(null);
  };

  // 정보 패널 — 모드마다 보여줄 내용 (없으면 패널을 숨긴다)
  const showPanel = !!d && hasShape;
  const modeTitle = MODES.find((m) => m.id === mode)!.label;

  const floorSlider = sel ? (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between text-[12px] text-[color:var(--lab-muted)]">
        <span>
          몇 층에서 볼까요?{" "}
          <b className="text-[14px] tabular-nums text-[color:var(--lab-navy-950)]">
            {floorNow}층
          </b>
        </span>
        <span className="tabular-nums">1층 ~ {maxFloors}층</span>
      </span>
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
    </label>
  ) : null;

  return (
    <div
      className="fixed inset-0 overflow-hidden bg-[#f4f7f9]"
      style={{ touchAction: "none", overscrollBehavior: "none" }}
    >
      {/* 캔버스 — 화면 전체 */}
      <div
        ref={hostRef}
        className="absolute inset-0 touch-none"
        style={{ isolation: "isolate" }}
      />
      {query.isLoading ? (
        <div className="absolute inset-0 flex items-center justify-center detail-meta">
          3D 모형을 불러오는 중…
        </div>
      ) : null}
      {query.isError ? (
        <div className="absolute inset-0 flex items-center justify-center detail-body">
          {(query.error as Error).message}
        </div>
      ) : null}
      {d && !hasShape ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="detail-subsection-title">
            아직 이 단지의 건물 모양 데이터가 없어요
          </p>
          <p className="detail-meta">
            국토교통부 GIS건물통합정보를 순서대로 적재하고 있어요. 동{" "}
            {d.coverage.buildings}개의 층수·세대수는 이미 있어요.
          </p>
        </div>
      ) : null}
      {webglError ? (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center detail-body">
          이 기기에서는 3D 화면(WebGL)을 켤 수 없어요.
        </div>
      ) : null}

      {/* 위: 뒤로·단지명 · 동/타입 필터 · 모드 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col gap-2 pt-[calc(env(safe-area-inset-top)+8px)]">
        <div className="flex items-center gap-1.5 px-3">
          <div
            className={`pointer-events-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${FLOAT}`}
          >
            <BackLink fallback={d?.href ?? "/complexes"} compact hideLabel />
          </div>
          {d?.href ? (
            <Link
              href={d.href}
              aria-label={`${d.name} 단지 상세로`}
              className={`pointer-events-auto flex h-8 min-w-0 items-center gap-0.5 rounded-full pl-3 pr-2 text-[14px] font-bold text-[color:var(--lab-navy-950)] transition active:scale-95 ${FLOAT}`}
            >
              <span className="min-w-0 truncate">{d.name}</span>
              <span className="ml-1 shrink-0 text-[12px] font-semibold text-[color:var(--lab-muted)]">상세</span>
              <ChevronRight
                className="h-4 w-4 shrink-0 text-slate-400"
                aria-hidden
              />
            </Link>
          ) : (
            <p
              className={`pointer-events-auto flex h-8 min-w-0 items-center rounded-full px-3 text-[14px] font-bold text-[color:var(--lab-navy-950)] ${FLOAT}`}
            >
              <span className="truncate">{d?.name ?? "3D 단지 탐색"}</span>
            </p>
          )}
          {d && hasShape ? (
            <div className="pointer-events-auto ml-auto flex shrink-0 gap-1.5">
              {(
                [
                  { id: "type", label: picked?.label ?? "타입", on: !!picked },
                  { id: "dong", label: sel?.dong ?? "동", on: !!sel },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setPicker((v) => (v === f.id ? null : f.id))}
                  aria-expanded={picker === f.id}
                  className={`flex h-8 items-center gap-1 rounded-full px-3 text-[13px] font-semibold tabular-nums transition active:scale-95 ${
                    f.on
                      ? "bg-[color:var(--lab-navy-950)] text-white shadow-[0_2px_10px_rgba(15,23,42,0.25)]"
                      : `${FLOAT} text-[color:var(--lab-navy-950)]`
                  }`}
                >
                  {f.id === "type" && picked ? (
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: picked.color }}
                      aria-hidden
                    />
                  ) : null}
                  <span className="max-w-[92px] truncate">{f.label}</span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition ${picker === f.id ? "rotate-180" : ""}`}
                    aria-hidden
                  />
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* 필터 목록 */}
        {picker && d ? (
          <div
            className="pointer-events-auto mx-3 overflow-y-auto rounded-2xl bg-white p-3 shadow-[0_8px_24px_rgba(15,23,42,0.18)]"
            style={{
              maxHeight: "52dvh",
              touchAction: "pan-y",
              overscrollBehavior: "contain",
            }}
          >
            {picker === "dong" ? (
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    closeDong();
                    setPicker(null);
                  }}
                  className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold ${
                    !sel
                      ? "border-[color:var(--lab-navy-950)] bg-[color:var(--lab-navy-950)] text-white"
                      : "border-[color:var(--lab-border)] text-[color:var(--lab-navy-950)]"
                  }`}
                >
                  전체
                </button>
                {(picked
                  ? [...dongs].sort(
                      (a, b) =>
                        Number(picked.dongs.has(b.dong!)) -
                        Number(picked.dongs.has(a.dong!)),
                    )
                  : dongs
                ).map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => {
                      pickDong(b.id);
                      setPicker(null);
                    }}
                    className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold tabular-nums transition active:scale-95 ${
                      b.id === selected
                        ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] text-[color:var(--lab-teal-700)]"
                        : picked && b.dong && !picked.dongs.has(b.dong)
                          ? "border-[color:var(--lab-border)] text-slate-300"
                          : "border-[color:var(--lab-border)] text-[color:var(--lab-navy-950)]"
                    }`}
                    style={
                      picked &&
                      b.dong &&
                      picked.dongs.has(b.dong) &&
                      b.id !== selected
                        ? { borderColor: picked.color }
                        : undefined
                    }
                  >
                    {b.dong}
                  </button>
                ))}
              </div>
            ) : (
              <ul className="flex flex-col">
                {[
                  {
                    id: null as string | null,
                    label: "전체 타입",
                    color: null as string | null,
                    sub: `${typeOptions.length}개 타입`,
                  },
                  ...typeOptions.map((t) => ({
                    id: t.id as string | null,
                    label: t.label,
                    color: t.color as string | null,
                    sub: `동 ${t.dongs.size}개 · ${t.households.toLocaleString("ko-KR")}세대`,
                  })),
                ].map((t) => (
                  <li key={t.id ?? "all"}>
                    <button
                      type="button"
                      onClick={() => {
                        setPickedType(t.id);
                        setPicker(null);
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition active:scale-[0.99] ${
                        pickedType === t.id
                          ? "bg-[color:var(--lab-brand-subtle)]"
                          : ""
                      }`}
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          background: t.color ?? "transparent",
                          border: t.color ? undefined : "1px solid #cbd5e1",
                        }}
                        aria-hidden
                      />
                      <span className="flex-1 text-[14px] font-semibold tabular-nums text-[color:var(--lab-navy-950)]">
                        {t.label}
                      </span>
                      <span className="text-[12px] tabular-nums text-[color:var(--lab-muted)]">
                        {t.sub}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
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
        )}
        {!picker &&
        d &&
        hasShape &&
        d.coverage.withShape < d.coverage.buildings ? (
          <p
            className={`mx-3 self-start rounded-md px-2 py-1 text-[11px] text-[color:var(--lab-muted)] ${FLOAT}`}
          >
            동 {d.coverage.buildings}개 중 {d.coverage.withShape}개 모양 ·
            나머지는 준비 중
          </p>
        ) : null}
      </div>
      {/* 필터 목록 바깥을 누르면 닫기 */}
      {picker ? (
        <button
          type="button"
          aria-label="닫기"
          className="absolute inset-0 z-20 cursor-default"
          onClick={() => setPicker(null)}
        />
      ) : null}

      {/* 안내 토스트 */}
      {toast ? (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-full bg-[color:var(--lab-navy-950)]/90 px-3.5 py-2 text-[13px] font-semibold text-white shadow-lg"
          style={{
            bottom: panelH
              ? `calc(env(safe-area-inset-bottom) + ${panelH + 34}px)`
              : "calc(env(safe-area-inset-bottom) + 34px)",
          }}
        >
          {toast}
        </div>
      ) : null}

      {/* 오른쪽: 나침반 · 단지 전체 · 위에서 보기 */}
      {ready ? (
        <div
          className="absolute right-3 z-10 flex flex-col gap-2"
          style={{ top: "calc(env(safe-area-inset-top) + 92px)" }}
        >
          <button
            type="button"
            onClick={() => sceneRef.current?.northUp()}
            aria-label="북쪽을 위로"
            className={`flex h-10 w-10 items-center justify-center rounded-full ${FLOAT} active:scale-95`}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6"
              style={{ transform: `rotate(${heading}deg)` }}
              aria-hidden
            >
              <path d="M12 3 L15.5 12 H8.5 Z" fill="#e11d48" />
              <path d="M12 21 L8.5 12 H15.5 Z" fill="#94a3b8" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() =>
              mode === "around"
                ? sceneRef.current?.fitPois()
                : sceneRef.current?.resetView()
            }
            aria-label="전체 보기"
            className={`flex h-10 w-10 items-center justify-center rounded-full ${FLOAT} active:scale-95`}
          >
            <Maximize2
              className="h-[18px] w-[18px] text-[color:var(--lab-navy-950)]"
              aria-hidden
            />
          </button>
          <button
            type="button"
            onClick={() => sceneRef.current?.topView()}
            aria-label="위에서 보기"
            className={`flex h-10 w-10 items-center justify-center rounded-full ${FLOAT} active:scale-95`}
          >
            <SquareDashed
              className="h-[18px] w-[18px] text-[color:var(--lab-navy-950)]"
              aria-hidden
            />
          </button>
        </div>
      ) : null}

      {/* 정보 패널 — 동·타입 필터를 고른 상태에서 모드별 정보를 한곳에 */}
      {showPanel && d ? (
        <div
          ref={panelRef}
          className="absolute left-3 right-3 z-20 sm:right-auto sm:w-[400px]"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 10px)" }}
        >
          <div
            className={`overflow-y-auto rounded-2xl border border-[color:var(--lab-brand-border)] bg-white px-3.5 py-2.5 shadow-[0_4px_16px_rgba(15,23,42,0.14)]`}
            style={{
              maxHeight:
                mode === "around"
                  ? "24dvh"
                  : mode === "sun" || mode === "view"
                    ? "60dvh"
                    : "38dvh",
              touchAction: "pan-y",
              overscrollBehavior: "contain",
            }}
          >
            {/* 고른 동 (모든 모드 공통 머리) */}
            {sel ? (
              <DongHeader sel={sel} nearest={mode === "base" ? nearest : null} onClose={closeDong} />
            ) : mode === "base" ? null : (
              <p className="text-[13px] font-bold text-[color:var(--lab-navy-950)]">
                {modeTitle}
              </p>
            )}

            {mode === "base" && !sel && !picked ? (
              <p className="text-[13px] text-[color:var(--lab-navy-950)]">
                <b>동 정보</b>
                <span className="mt-0.5 block text-[13px] text-[color:var(--lab-muted)]">
                  상단의 타입·동을 선택하시거나 건물을 직접 눌러보세요.
                </span>
              </p>
            ) : null}
            {mode === "base" && sel ? (
              <>
                <DongLines lines={selLines} fallback={sel.units} />
                {sel.dong ? <DongTrades complexId={complexId} dong={sel.dong} /> : null}
              </>
            ) : null}
            {mode === "base" && !sel && picked ? (
              <div>
                <p className="flex items-center gap-1.5 text-[14px] font-bold tabular-nums text-[color:var(--lab-navy-950)]">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: picked.color }}
                    aria-hidden
                  />
                  {picked.label}
                  <span className="text-[13px] font-semibold text-[color:var(--lab-muted)]">
                    동 {picked.dongs.size}개 ·{" "}
                    {picked.households.toLocaleString("ko-KR")}세대
                  </span>
                </p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {typeGroups.map((g) => (
                    <li
                      key={g.key}
                      className="text-[13px] leading-[20px] tabular-nums"
                    >
                      <span className="font-semibold text-[color:var(--lab-navy-950)]">
                        {g.key}
                      </span>
                      <span className="text-[color:var(--lab-muted)]">
                        {" "}
                        · {g.dongs.join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {mode === "floors" ? (
              <div className="mt-2 flex flex-col gap-1.5">
                <div className="grid grid-cols-3 gap-1.5">
                  {d.floorBands.map((b) => (
                    <div
                      key={b.label}
                      className="rounded-lg border border-[color:var(--lab-border)] px-2 py-1.5"
                    >
                      <p className="text-[12px] text-[color:var(--lab-muted)] tabular-nums">
                        {b.label} {b.fromFloor}~{b.toFloor}층
                      </p>
                      <p className="text-[14px] font-bold tabular-nums text-[color:var(--lab-navy-950)]">
                        {b.perPyeong != null ? man(b.perPyeong) : "—"}
                      </p>
                      <p className="text-[12px] tabular-nums text-[color:var(--lab-muted)]">
                        {b.count}건
                      </p>
                    </div>
                  ))}
                </div>
                <p className="text-[12px] text-[color:var(--lab-muted)]">
                  전용 3.3㎡당 · {d.floorBandsBasis} · 색이 진할수록 비싼 층
                </p>
              </div>
            ) : null}

            {mode === "sun" ? (
              <div className="mt-1.5 flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-[12px] tabular-nums text-[color:var(--lab-muted)]">
                    {sunInfo && sunInfo.altitude > 0
                      ? `해 ${Math.round((sunInfo.altitude * 180) / Math.PI)}° ${dirOf((sunInfo.azimuth * 180) / Math.PI)}쪽`
                      : "해 진 뒤"}
                    {sel ? " · 남쪽 창 기준 추정" : ""}
                  </span>
                  <div className="ml-auto flex shrink-0 rounded-full bg-slate-100 p-0.5">
                    {SEASONS.map((x) => (
                      <button
                        key={x.id}
                        type="button"
                        onClick={() => setSeason(x.id)}
                        aria-pressed={season === x.id}
                        className={`rounded-full px-2 py-0.5 text-[12px] font-semibold transition active:scale-95 ${
                          season === x.id
                            ? "bg-white text-[color:var(--lab-navy-950)] shadow-sm"
                            : "text-[color:var(--lab-muted)]"
                        }`}
                      >
                        {x.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="flex items-center gap-2">
                  <span className="w-[92px] shrink-0 whitespace-nowrap text-[13px] text-[color:var(--lab-muted)]">
                    그림자{" "}
                    <b className="text-[13px] tabular-nums text-[color:var(--lab-navy-950)]">
                      {String(hour).padStart(2, "0")}:00
                    </b>
                  </span>
                  <input
                    type="range"
                    min={6}
                    max={19}
                    step={1}
                    value={hour}
                    onChange={(e) => setHour(Number(e.target.value))}
                    className="min-w-0 flex-1 accent-[color:var(--lab-brand-primary)]"
                    aria-label="그림자 시각"
                  />
                </label>
                {sel ? (
                  <>
                    <label className="flex items-center gap-2">
                      <span className="w-[92px] shrink-0 whitespace-nowrap text-[13px] text-[color:var(--lab-muted)]">
                        층{" "}
                        <b className="text-[13px] tabular-nums text-[color:var(--lab-navy-950)]">
                          {floorNow}층
                        </b>
                      </span>
                      <input
                        type="range"
                        min={1}
                        max={Math.max(1, maxFloors)}
                        step={1}
                        value={floorNow}
                        onChange={(e) => setViewFloor(Number(e.target.value))}
                        className="min-w-0 flex-1 accent-[color:var(--lab-brand-primary)]"
                        aria-label="층"
                      />
                    </label>
                    {sunStats ? (
                      <SunStatsView stats={sunStats} season={season} />
                    ) : null}
                  </>
                ) : (
                  <p className="text-[13px] text-[color:var(--lab-muted)]">
                    동을 선택하면 해당 동·층의 하루 일조 시간을 계산해요.
                  </p>
                )}
              </div>
            ) : null}

            {mode === "view" ? (
              sel ? (
                <div className="mt-2 flex flex-col gap-2">
                  {floorSlider}
                  {view ? (
                    <>
                      <p className="text-[13px] tabular-nums text-[color:var(--lab-navy-950)]">
                        {floorNow}층 눈높이에서 200m 안에 막힘없는 방향{" "}
                        <b className="text-[15px]">
                          {Math.round(view.openShare * 100)}%
                        </b>
                      </p>
                      <OpenDirections view={view} />
                      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] text-[color:var(--lab-muted)]">
                        
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-sm" style={{ background: "#0e9aa0" }} aria-hidden />
                          200m 넘게 막힘없음
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-sm" style={{ background: "#f59e0b" }} aria-hidden />
                          80~200m에 건물
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-sm" style={{ background: "#ef4444" }} aria-hidden />
                          80m 안에 건물
                        </span>
                      </p>
                    </>
                  ) : null}
                </div>
              ) : (
                <p className="mt-1 text-[13px] text-[color:var(--lab-muted)]">
                  동을 선택하면 층별 조망을 계산해요.
                </p>
              )
            ) : null}

            {mode === "around" ? (
              d.pois.length ? (
                <ul className="mt-1 divide-y divide-[color:var(--lab-border)]">
                  {d.pois.map((p) => (
                    <li
                      key={`${p.kind}-${p.name}`}
                      className="flex items-center justify-between gap-3 py-1.5 text-[13px]"
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-semibold text-[color:var(--lab-navy-950)]">
                          {p.name}
                        </span>
                        <span className="ml-1.5 text-[color:var(--lab-muted)]">
                          {p.kind === "school" ? schoolLevel(p.sub) : p.sub}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums text-[color:var(--lab-muted)]">
                        {p.distanceM.toLocaleString("ko-KR")}m · 약{" "}
                        {Math.max(1, Math.round(p.distanceM / 67))}분
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[13px] text-[color:var(--lab-muted)]">
                  주변 학교·역 정보가 없어요.
                </p>
              )
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DongHeader({
  sel,
  nearest,
  onClose,
}: {
  sel: Complex3d["buildings"][number];
  nearest: DongContext | null;
  onClose: () => void;
}) {
  const main = [
    sel.floors ? `${sel.floors}층` : null,
    sel.households ? `${sel.households.toLocaleString("ko-KR")}세대` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const around = nearest
    ? [
        nearest.front
          ? `앞 동 ${nearest.front.dong ?? ""} ${nearest.front.meters}m`
          : "앞이 트임",
        nearest.near
          ? `옆 동 ${nearest.near.dong ?? ""} ${nearest.near.meters}m`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-bold text-[color:var(--lab-teal-700)]">
          {sel.dong ?? sel.name ?? "동"}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tabular-nums text-[color:var(--lab-navy-950)]">
          {main}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="동 선택 해제"
          className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 active:scale-95"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {around ? (
        <p className="-mt-0.5 text-[13px] font-semibold tabular-nums text-[color:var(--lab-navy-950)]">
          {around}
        </p>
      ) : null}
    </div>
  );
}

function DongLines({
  lines,
  fallback,
}: {
  lines: Array<{
    id: string;
    label: string;
    color: string | null;
    lines: string[];
  }>;
  fallback: Array<{ label: string; households: number }>;
}) {
  if (lines.length) {
    return (
      <ul className="mt-1 flex flex-col gap-0.5">
        {lines.map((g) => (
          <li
            key={g.id}
            className="flex items-center gap-1.5 text-[13px] leading-[20px] tabular-nums text-[color:var(--lab-navy-950)]"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: g.color ?? "#cbd5e1" }}
              aria-hidden
            />
            <span className="font-semibold">{g.label}</span>
            <span className="text-[color:var(--lab-muted)]">
              {g.lines.join("·")}호 라인
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (!fallback.length) return null;
  return (
    <p className="mt-1 text-[13px] leading-[20px] tabular-nums text-[color:var(--lab-muted)]">
      {fallback.map((u) => `${u.label} ${u.households}세대`).join(" · ")}
    </p>
  );
}

const hm = (min: number) =>
  min >= 60
    ? `${Math.floor(min / 60)}시간${min % 60 ? ` ${min % 60}분` : ""}`
    : `${min}분`;

/** 하루 일조 — 큰 숫자 두 개 + 7~18시 막대 */
function SunStatsView({ stats, season }: { stats: SunHours; season: Season }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        <div className="rounded-lg bg-[color:var(--lab-brand-subtle)] px-2.5 py-1.5">
          <p className="text-[12px] text-[color:var(--lab-teal-700)]">
            하루 해 드는 시간
          </p>
          <p className="text-[16px] font-bold tabular-nums text-[color:var(--lab-navy-950)]">
            {hm(stats.totalMin)}
          </p>
        </div>
        <div className="rounded-lg bg-[color:var(--lab-brand-subtle)] px-2.5 py-1.5">
          <p className="whitespace-nowrap text-[12px] text-[color:var(--lab-teal-700)]">9~15시 연속 최대</p>
          <p className="flex items-center gap-1.5 whitespace-nowrap text-[16px] font-bold tabular-nums text-[color:var(--lab-navy-950)]">
            {hm(stats.best9to15Min)}
            {season === "winter" ? (
              <span className="flex items-center">
                <span
                  className={`rounded px-1 text-[11px] font-bold ${stats.best9to15Min >= 120 ? "bg-white text-[color:var(--lab-teal-700)]" : "bg-rose-50 text-rose-600"}`}
                >
                  {stats.best9to15Min >= 120 ? "기준 충족" : "기준 미달"}
                </span>
                <InfoTip aria-label="일조 기준 설명" rootClassName="ml-0.5">
                  동지(12월 22일 무렵)에 9시~15시 사이 <b>연속 2시간 이상</b> 해가 들면 충족으로 봐요. 공동주택 일조권 분쟁에서 법원이
                  흔히 쓰는 기준이에요(또는 8시~16시 사이 합계 4시간 이상). 이 수치는 동 정면 가운데 창 높이 기준 추정이라 실제
                  세대와 다를 수 있어요.
                </InfoTip>
              </span>
            ) : null}
          </p>
        </div>
      </div>
      <div>
        <div
          className="flex h-3 overflow-hidden rounded-full bg-slate-100"
          aria-label="시간대별 해 드는 때"
        >
          {stats.slots.map((x, i) => (
            <span
              key={i}
              className="h-full flex-1"
              style={{
                background: x ? "#f59e0b" : x === false ? "#e2e8f0" : "#f1f5f9",
              }}
            />
          ))}
        </div>
        <div className="mt-0.5 flex justify-between text-[11px] tabular-nums text-[color:var(--lab-muted)]">
          <span>7시</span>
          <span>9</span>
          <span>12</span>
          <span>15</span>
          <span>18시</span>
        </div>
      </div>
    </div>
  );
}

function schoolLevel(v: string | null): string {
  return v === "elementary"
    ? "초등학교"
    : v === "middle"
      ? "중학교"
      : v === "high"
        ? "고등학교"
        : (v ?? "");
}

/** 8방위별로 트임(200m+) 비율 */
function OpenDirections({ view }: { view: ViewResult }) {
  const sectors = DIRS.map((label, i) => {
    const rays = view.rays.filter(
      (r) => Math.round((((r.azimuth % 360) + 360) % 360) / 45) % 8 === i,
    );
    const open =
      rays.filter((r) => r.distance == null || r.distance >= 200).length /
      Math.max(1, rays.length);
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
            borderColor:
              s.open >= 0.6 ? "var(--lab-brand-border)" : "var(--lab-border)",
            background: s.open >= 0.6 ? "var(--lab-brand-subtle)" : "white",
          }}
        >
          <p className="detail-label">{s.label}</p>
          <p className="detail-meta tabular-nums">
            {s.open >= 0.6
              ? "트임"
              : Number.isFinite(s.nearestHit)
                ? `${s.nearestHit}m 가림`
                : "트임"}
          </p>
        </div>
      ))}
    </div>
  );
}

/** 3억 4,000 형식 (만원 단위) */
function eok(man: number): string {
  const e = Math.floor(man / 10_000);
  const r = man % 10_000;
  if (!e) return `${r.toLocaleString("ko-KR")}만`;
  return r ? `${e}억 ${r.toLocaleString("ko-KR")}` : `${e}억`;
}

type DongTradesResponse = {
  total: number;
  available: boolean;
  trades: Array<{ dealDate: string; amount: number; area: number; floor: number; registered: boolean }>;
};

/** 동별 매매 실거래 — 국토부 거래 동(등기된 2023년 이후 거래) */
function DongTrades({ complexId, dong }: { complexId: string; dong: string }) {
  const q = useQuery({
    queryKey: ["dong-trades", complexId, dong],
    queryFn: async (): Promise<DongTradesResponse> => {
      const res = await fetch(`/api/complex-3d/${complexId}/dong-trades?dong=${encodeURIComponent(dong)}`);
      if (!res.ok) return { total: 0, available: false, trades: [] };
      return res.json();
    },
    staleTime: 10 * 60_000,
  });
  if (!q.data) return null;
  const { total, available, trades } = q.data;
  return (
    <div className="mt-1.5 border-t border-[color:var(--lab-border)] pt-1.5">
      <div className="flex items-center justify-between text-[13px] font-semibold text-[color:var(--lab-navy-950)]">
        <span className="flex items-center">
          {dong} 실거래
          <InfoTip aria-label="동별 실거래 안내" rootClassName="ml-0.5">
            동별 실거래는 <b>2023년 거래부터</b> 제공돼요. 국토교통부 실거래 자료에 거래 동이 2023년부터 들어 있고, 등기가 끝난
            거래에만 동이 표시돼요. 그래서 최근 몇 달 거래는 등기 후에 나타날 수 있어요.
          </InfoTip>
        </span>
        <span className="text-[12px] font-normal tabular-nums text-[color:var(--lab-muted)]">
          {available ? `2023년부터 ${total}건` : "준비 중"}
        </span>
      </div>
      {!available ? (
        <p className="text-[12px] text-[color:var(--lab-muted)]">이 단지는 동별 실거래를 모으는 중이에요.</p>
      ) : trades.length ? (
        <ul className="mt-0.5 flex flex-col">
          {trades.slice(0, 3).map((t, i) => (
            <li key={i} className="flex items-baseline gap-2 text-[13px] leading-[20px] tabular-nums">
              <span className="w-[54px] shrink-0 text-[color:var(--lab-muted)]">{t.dealDate.slice(2).replace(/-/g, ".")}</span>
              <span className="font-bold text-[color:var(--lab-teal-700)]">{eok(t.amount)}</span>
              <span className="ml-auto text-[color:var(--lab-muted)]">
                {t.area}㎡ · {t.floor}층
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-[color:var(--lab-muted)]">2023년 이후 등기된 매매가 없어요.</p>
      )}
    </div>
  );
}
