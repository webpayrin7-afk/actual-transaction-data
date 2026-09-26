"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  AppWindow,
  Footprints,
  Maximize2,
  RotateCcw,
  SquareDashed,
  X,
} from "lucide-react";
import type { Complex3d } from "@/lib/complex-3d/read";
import { groundSizeM, WALK_VERSION, type TerrainGridPayload } from "@/lib/complex-3d/ground";
import type { WalkDestination, WalkPayload } from "@/lib/complex-3d/walk";
import {
  DEFAULT_WALKER,
  isWalkerId,
  WALKER_IDS,
  WALKER_LABEL,
  walkerAvoidsSteps,
  type WalkerId,
} from "@/lib/complex-3d/walker-profiles";
import { Map3dAttribution, type AttributionLine } from "@/components/map3d/Map3dAttribution";
import { has3dModel } from "@/lib/complex-3d/gate";
import { BackLink } from "@/components/layout/BackLink";
import { InfoTip } from "@/components/ui/InfoTip";
import type {
  Complex3dScene,
  SceneMode,
  SunHours,
  ViewResult,
  DongContext,
  WindowViewInfo,
  FacadeSunProgress,
} from "@/components/complex-3d/scene";
import { FACADE_SUN_COLORS } from "@/components/complex-3d/facade-sun";
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
  { id: "sun", label: "일조" },
  { id: "view", label: "조망" },
  { id: "floors", label: "층별가" },
  { id: "around", label: "주변" },
  { id: "walk", label: "걷기" },
];

async function fetchTerrain(id: string): Promise<TerrainGridPayload | null> {
  const res = await fetch(`/api/complex-3d/${encodeURIComponent(id)}/terrain`);
  return res.ok ? res.json() : null;
}

async function fetchWalk(
  id: string,
  from: string | null,
  wheel: boolean,
  walker: WalkerId,
): Promise<WalkPayload> {
  const q = new URLSearchParams({ v: String(WALK_VERSION) });
  if (from) q.set("from", from);
  if (wheel) q.set("mode", "wheel");
  // 걷는 사람 속도로 시간 바꾸기는 서버에서 (화면은 결과만)
  q.set("walker", walker);
  const res = await fetch(`/api/complex-3d/${encodeURIComponent(id)}/walk?${q}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "걷기 경로를 불러오지 못했어요.");
  }
  return res.json();
}

const mmss = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, "0")}초`;
};

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

const reducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const FLOAT =
  "bg-white/95 shadow-[0_2px_10px_rgba(15,23,42,0.14)] backdrop-blur";
/** 고른 칩·버튼 — 앱 다른 곳(LabFilterChips·ComplexTypeDongSection)과 같은 청록 선택 모양 */
const CHIP_ON =
  "border border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] text-[color:var(--lab-teal-700)]";
const CHIP_OFF =
  "border border-[color:var(--lab-border)] bg-white text-[color:var(--lab-navy-950)]";
const WALKER_KEY = "ziplab.complex3d.walker";
/** 걷기 길(보행망·계단·횡단보도) 출처 */
const WALK_ATTRIBUTION: AttributionLine[] = [
  { text: "보행 경로 © OpenStreetMap contributors (ODbL)", href: "https://www.openstreetmap.org/copyright" },
];

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
  // 장면 콜백(한 번만 연결)에서 지금 모드를 읽는다
  const modeRef = useRef<SceneMode>("base");
  useEffect(() => {
    showToastRef.current = showToast;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelH, setPanelH] = useState(0);
  const [sunStats, setSunStats] = useState<SunHours | null>(null);
  const [pickedType, setPickedType] = useState<string | null>(null);
  const [picker, setPicker] = useState<"dong" | "type" | null>(null);
  const [walkPick, setWalkPick] = useState<string | null>(null);
  // 걷기 종료 — 누르면 경로를 지우고 도착지 목록만 (다시 고르면 풀린다)
  const [walkEnded, setWalkEnded] = useState(false);
  // 걷는 사람 — 브라우저에 기억 (못 읽으면 기본)
  const [walker, setWalkerState] = useState<WalkerId>(() => {
    if (typeof window === "undefined") return DEFAULT_WALKER;
    try {
      const v = window.localStorage.getItem(WALKER_KEY);
      return isWalkerId(v) ? v : DEFAULT_WALKER;
    } catch {
      return DEFAULT_WALKER;
    }
  });
  const setWalker = (v: WalkerId) => {
    setWalkerState(v);
    try {
      window.localStorage.setItem(WALKER_KEY, v);
    } catch {
      /* 저장 못 해도 이번 화면에서는 그대로 */
    }
  };
  // 유모차·휠체어는 걷는 사람 중 하나 — 고르면 계단 피하는 길(서버 mode=wheel)
  const wheel = walkerAvoidsSteps(walker);
  const [walkProgress, setWalkProgress] = useState<{ sec: number; done: boolean } | null>(null);
  // 걷기 — 사람 뒤에서 따라가는 카메라
  const [walkFollow, setWalkFollow] = useState(false);
  // 일조 — 외벽을 층 구간별 해 드는 시간으로 색칠
  const [facadeOn, setFacadeOn] = useState(false);
  const [facadeProg, setFacadeProg] = useState<FacadeSunProgress | null>(null);
  const [terrainOn, setTerrainOn] = useState(false);
  // 우리 집 창문 시점 — 켜져 있으면 정보(방향·앞 건물·가림)
  const [windowInfo, setWindowInfo] = useState<WindowViewInfo | null>(null);
  const inWindow = !!windowInfo;
  // 창문 시점 방향키(위·아래 = 층)가 최신 층·처리기를 읽게
  const winFloorRef = useRef<{ move: (f: number) => void; floor: number }>({ move: () => {}, floor: 1 });
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
  }, [ready, mode, selected, pickedType, walkPick, inWindow]);

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
  // 3D 카드와 같은 기준 — 어린이집·상가 모양만 있고 주거동 모양이 없으면 "모양 데이터 없음"
  const hasShape = !!d && has3dModel(d.buildings);

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
        scene.setGroundMap(
          `/api/complex-3d/${d.complexId}/ground?v=2`,
          groundSizeM(d.center.lat),
        );
        scene.setFloorBands(d.floorBands);
        scene.setPois(d.pois);
        const s = scene;
        s.onSelect = (id) => {
          setSelected(id);
          setNearest(id ? s.dongContext(id) : null);
          // 일조·조망은 한 번 탭으로 바로 다가가니 안내하지 않는다
          const m = modeRef.current;
          if (id && m !== "sun" && m !== "view")
            showToastRef.current("두 번 누르면 해당 동으로 이동합니다");
        };
        s.onHeading = setHeading;
        s.onWalkProgress = (sec, done) => setWalkProgress({ sec, done });
        s.onWalkFollow = setWalkFollow;
        s.onFacadeSunProgress = setFacadeProg;
        s.onTerrain = () => setTerrainOn(true);
        s.onWindowInfo = (info) => setWindowInfo(info);
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
      setTerrainOn(false);
      setWindowInfo(null);
    };
  }, [d, hasShape]);

  // 지형 — 늦게 와도 장면이 동·주변 건물을 땅 높이에 다시 올린다 (못 받으면 평지 그대로)
  const terrainQuery = useQuery({
    queryKey: ["complex-3d-terrain", complexId],
    queryFn: () => fetchTerrain(complexId),
    staleTime: 24 * 60 * 60_000,
    enabled: !!d && hasShape,
  });
  useEffect(() => {
    const t = terrainQuery.data;
    if (!ready || !t) return;
    sceneRef.current?.setTerrain(t);
  }, [ready, terrainQuery.data]);

  // 걷기 — 고른 동에서 출발 (없으면 단지 가운데 동)
  const walkQuery = useQuery({
    queryKey: ["complex-3d-walk", complexId, selected, wheel, walker],
    queryFn: () => fetchWalk(complexId, selected, wheel, walker),
    staleTime: 60 * 60_000,
    enabled: mode === "walk" && !!d && hasShape,
    retry: 1,
  });
  const walk = walkQuery.data;
  const walkDest: WalkDestination | null = walkEnded
    ? null
    : (walk?.destinations.find((x) => x.id === walkPick) ??
      walk?.destinations[0] ??
      null);
  // 경로 화면 맞추기는 고른 경로(도착지·출발 동·유모차)가 바뀔 때 한 번만 — 지형이 늦게 오거나 걷는 사람만 바꾸면
  // 다시 그리기만 하고 카메라는 사용자가 둔 곳 그대로
  const framedWalk = useRef<string | null>(null);
  useEffect(() => {
    const s = sceneRef.current;
    if (!s || !ready) return;
    if (mode !== "walk" || !walkDest || !walk) {
      s.clearWalk();
      framedWalk.current = null;
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const key = `${walkDest.id}|${walk.from.buildingId}|${walk.mode}`;
    const total = walkDest.walkSec + walkDest.waitSec;
    const scale = walk.walker?.timeScale ?? 1;
    // 패널 높이가 잡힌 뒤 경로가 보이게
    const t = window.setTimeout(() => {
      const frame = framedWalk.current !== key;
      framedWalk.current = key;
      s.showWalk(
        {
          points: walkDest.points,
          marks: walkDest.marks,
          target: walkDest.target,
          name: walkDest.name,
          totalSec: total,
          baseSec: walkDest.walkSec / scale + walkDest.waitSec,
          walker: walk.walker?.id ?? DEFAULT_WALKER,
        },
        reduced,
        frame,
      );
    }, 120);
    return () => window.clearTimeout(t);
  }, [mode, walkDest, walk, ready, terrainOn]);

  // 걷기 종료 — 재생·경로·사람·핀·따라가기를 모두 끄고, 카메라는 고른 동(없으면 단지 전체)으로. 도착지 목록은 그대로
  const endWalk = () => {
    const s = sceneRef.current;
    setWalkEnded(true);
    setWalkPick(null);
    setWalkFollow(false);
    setWalkProgress(null);
    framedWalk.current = null;
    if (!s) return;
    s.endWalk();
    if (selected) s.focus(selected, reducedMotion());
    else s.resetView();
  };
  const endWalkRef = useRef(endWalk);
  useEffect(() => {
    endWalkRef.current = endWalk;
    modeRef.current = mode;
  });
  const walkOn = mode === "walk" && !!walkDest;
  useEffect(() => {
    if (!walkOn || inWindow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") endWalkRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [walkOn, inWindow]);

  // 따라가기 — 걷기 모드에서만 (나가면 끈다)
  useEffect(() => {
    if (!ready) return;
    sceneRef.current?.setWalkFollow(mode === "walk" && walkFollow, reducedMotion());
  }, [mode, walkFollow, ready]);

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

  // 외벽 일조 — 계절이 바뀌면 그 계절로 (계산한 계절은 기억한다)
  useEffect(() => {
    if (!ready) return;
    const s = SEASONS.find((x) => x.id === season)!;
    const date = new Date(Date.UTC(new Date().getFullYear(), s.md[0] - 1, s.md[1]));
    sceneRef.current?.setFacadeSun(facadeOn, date, season);
  }, [facadeOn, season, ready]);

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
  }, [mode, selected, viewFloor, season, ready, terrainOn]);

  // 주변 — 표시한 곳이 모두 보이게
  // 주변에서 다른 탭으로 나오면 — 고른 동이 있으면 그 동으로, 없으면 단지 전체로
  const prevMode = useRef<SceneMode>(mode);
  useEffect(() => {
    if (!ready) return;
    const from = prevMode.current;
    prevMode.current = mode;
    let run: (() => void) | null = null;
    if (mode === "around") run = () => sceneRef.current?.fitPois();
    else if (from === "around" || from === "walk")
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
    // 창문 시점 안에서는 부채꼴이 숨어 있으니 층을 바꿔도 다시 재지 않는다 (나올 때 한 번)
    if (mode !== "view" || !selected || !ready || inWindow) return;
    const t = window.setTimeout(
      () => setView(sceneRef.current?.computeView(selected, viewFloor) ?? null),
      60,
    );
    return () => window.clearTimeout(t);
  }, [mode, selected, viewFloor, ready, terrainOn, inWindow]);

  const maxFloors = sel?.floors ?? 1;
  const floorNow = Math.min(viewFloor, maxFloors);

  const enterWindow = (floor = floorNow) => {
    const s = sceneRef.current;
    if (!s || !selected) return;
    setPicker(null);
    setWindowInfo(s.enterWindowView(selected, floor, reducedMotion()));
  };
  const exitWindow = () => {
    sceneRef.current?.exitWindowView(reducedMotion());
    setWindowInfo(null);
  };
  // 창문 시점에서는 모드·동 고르기를 숨기므로, 나오는 길은 돌아가기·Esc 뿐이다
  // Esc · 방향키
  useEffect(() => {
    if (!inWindow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        sceneRef.current?.exitWindowView(reducedMotion());
        setWindowInfo(null);
        return;
      }
      // 층 슬라이더에 초점이 있으면 방향키는 슬라이더가 (층만 바뀌고 둘러보기는 하지 않게)
      const el = e.target as HTMLElement | null;
      if (el && el.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") sceneRef.current?.lookWindow(-10);
      else if (e.key === "ArrowRight") sceneRef.current?.lookWindow(10);
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const w = winFloorRef.current;
        w.move(w.floor + (e.key === "ArrowUp" ? 1 : -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inWindow]);

  const pickDong = (id: string) => {
    const s = sceneRef.current;
    if (!s) return;
    s.select(id);
    s.focus(id, reducedMotion());
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
    <FloorSlider floor={floorNow} max={maxFloors} onChange={setViewFloor} />
  ) : null;

  // 창문 시점 층 끌기 — 눈높이는 바로 옮기고, 가림 광선은 150ms에 한 번 + 놓을 때 다시 잰다
  const winCalcAt = useRef(0);
  const winTimer = useRef<number | null>(null);
  const recalcWindow = (floor: number) => {
    const s = sceneRef.current;
    if (winTimer.current) window.clearTimeout(winTimer.current);
    winTimer.current = null;
    if (!s || !selected || !s.inWindowView) return;
    winCalcAt.current = performance.now();
    const info = s.enterWindowView(selected, floor, true);
    if (info) setWindowInfo(info);
  };
  const moveWindowFloor = (floor: number) => {
    const s = sceneRef.current;
    if (!s) return;
    const f = Math.max(1, Math.min(maxFloors, Math.round(floor)));
    setViewFloor(f);
    const info = s.setWindowEyeFloor(f);
    if (info) setWindowInfo(info);
    if (winTimer.current) window.clearTimeout(winTimer.current);
    const wait = Math.max(0, 150 - (performance.now() - winCalcAt.current));
    winTimer.current = window.setTimeout(() => recalcWindow(f), wait);
  };
  useEffect(() => {
    winFloorRef.current = { move: moveWindowFloor, floor: windowInfo?.floor ?? floorNow };
  });
  useEffect(
    () => () => {
      if (winTimer.current) window.clearTimeout(winTimer.current);
    },
    [],
  );

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
            {d.coverage.buildings > 0
              ? `동 ${d.coverage.buildings}개의 층수·세대수는 있지만, 국토교통부 GIS건물통합정보의 건물 모양이 아직 연결되지 않았어요.`
              : "건축물대장 동 정보와 건물 모양이 아직 연결되지 않았어요."}
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
          {d && hasShape && !inWindow ? (
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
                      ? `${CHIP_ON} shadow-[0_2px_10px_rgba(15,23,42,0.14)]`
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
        {inWindow ? null : picker && d ? (
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
                      ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] text-[color:var(--lab-teal-700)]"
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
                      aria-pressed={pickedType === t.id}
                      className={`flex w-full items-center gap-2 rounded-lg border px-2 py-2 text-left transition active:scale-[0.99] ${
                        pickedType === t.id
                          ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)]"
                          : "border-transparent"
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
                      <span
                        className={`flex-1 text-[14px] font-semibold tabular-nums ${
                          pickedType === t.id
                            ? "text-[color:var(--lab-teal-700)]"
                            : "text-[color:var(--lab-navy-950)]"
                        }`}
                      >
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
                onClick={() => {
                  setMode(m.id);
                  setWalkEnded(false);
                }}
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
        !inWindow &&
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
      {ready && !inWindow ? (
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
                : mode === "walk" && walkDest
                  ? sceneRef.current?.fitWalk()
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

      {/* 걷기 길 출처 — 오른쪽 컨트롤 아래 ⓘ (처음 잠깐 펼쳤다가 접힌다, 서울 3D 지도와 같은 부품) */}
      {ready && !inWindow && mode === "walk" && walk ? (
        <Map3dAttribution
          id="walk-attribution-full"
          className="z-10"
          style={{ top: "calc(env(safe-area-inset-top) + 236px)" }}
          align="right"
          openDir="down"
          short={walk.attribution}
          lines={WALK_ATTRIBUTION}
        />
      ) : null}

      {/* 정보 패널 — 동·타입 필터를 고른 상태에서 모드별 정보를 한곳에 */}
      {windowInfo && sel ? (
        <WindowOverlay
          info={windowInfo}
          dong={sel.dong ?? "동"}
          maxFloors={maxFloors}
          onFloor={moveWindowFloor}
          onFloorDone={recalcWindow}
          onLook={(deg) => sceneRef.current?.lookWindow(deg)}
          onExit={exitWindow}
        />
      ) : null}

      {showPanel && d && !inWindow ? (
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
                  : mode === "walk"
                    ? "42dvh"
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
                        className={`rounded-full border px-2 py-0.5 text-[12px] font-semibold transition active:scale-95 ${
                          season === x.id
                            ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] text-[color:var(--lab-teal-700)] shadow-sm"
                            : "border-transparent text-[color:var(--lab-muted)]"
                        }`}
                      >
                        {x.label}
                      </button>
                    ))}
                  </div>
                </div>
                <FacadeSunControl
                  on={facadeOn}
                  onToggle={() => setFacadeOn((v) => !v)}
                  progress={facadeProg}
                  seasonLabel={SEASONS.find((x) => x.id === season)!.label}
                  dong={sel?.dong ?? null}
                />
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
                  <button
                    type="button"
                    onClick={() => enterWindow()}
                    disabled={!ready}
                    className="flex h-9 items-center justify-center gap-1.5 rounded-full bg-[color:var(--lab-navy-950)] text-[13px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
                  >
                    <AppWindow className="h-4 w-4" aria-hidden />
                    이 층 창문에서 보기
                  </button>
                  {view ? (
                    <>
                      <p className="text-[13px] tabular-nums text-[color:var(--lab-navy-950)]">
                        {floorNow}층 눈높이에서 200m 안에 막힘없는 방향{" "}
                        <b className="text-[15px]">
                          {Math.round(view.openShare * 100)}%
                        </b>
                      </p>
                      <OpenDirections view={view} />
                      <p className="flex items-center gap-2.5 whitespace-nowrap text-[12px] text-[color:var(--lab-muted)]">
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-sm" style={{ background: "#0ea5e9" }} aria-hidden />
                          200m+ 트임
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-sm" style={{ background: "#f59e0b" }} aria-hidden />
                          80~200m 건물
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-sm" style={{ background: "#ef4444" }} aria-hidden />
                          80m 안 가림
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

            {mode === "walk" ? (
              <WalkPanel
                walk={walk ?? null}
                loading={walkQuery.isFetching && !walk}
                error={walkQuery.isError ? (walkQuery.error as Error).message : null}
                picked={walkDest}
                onPick={(id) => {
                  setWalkEnded(false);
                  setWalkPick(id);
                }}
                onEnd={endWalk}
                walker={walker}
                onWalker={setWalker}
                progress={walkProgress}
                onReplay={() => sceneRef.current?.replayWalk()}
                follow={walkFollow}
                onFollow={setWalkFollow}
                fromDong={sel?.dong ?? walk?.from.dong ?? null}
                terrainLabel={terrainQuery.data?.sourceLabel ?? null}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 창문 시점 — 방향·앞 건물·가림 요약, 층 바꾸기, 둘러보기, 돌아가기 */
function WindowOverlay({
  info,
  dong,
  maxFloors,
  onFloor,
  onFloorDone,
  onLook,
  onExit,
}: {
  info: WindowViewInfo;
  dong: string;
  maxFloors: number;
  onFloor: (f: number) => void;
  onFloorDone: (f: number) => void;
  onLook: (deg: number) => void;
  onExit: () => void;
}) {
  const blocked = Math.round(info.blockedShare * 100);
  const tone =
    blocked >= 60 ? "text-rose-600" : blocked >= 30 ? "text-amber-600" : "text-[color:var(--lab-teal-700)]";
  const stepBtn =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--lab-border)] bg-white text-[color:var(--lab-navy-950)] transition active:scale-95 disabled:opacity-40";
  return (
    <>
      {/* 창틀 느낌의 가장자리 그늘 — 조작은 통과 */}
      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{ boxShadow: "inset 0 0 0 6px rgba(15,23,42,0.55), inset 0 0 60px rgba(15,23,42,0.25)" }}
        aria-hidden
      />
      <p
        className={`pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold text-[color:var(--lab-navy-950)] ${FLOAT}`}
        style={{ top: "calc(env(safe-area-inset-top) + 52px)" }}
      >
        좌우로 끌어 둘러보기
      </p>
      <div
        role="region"
        aria-label="창문 시점"
        className="absolute left-3 right-3 z-20 rounded-2xl border border-[color:var(--lab-brand-border)] bg-white px-3.5 py-2.5 shadow-[0_4px_16px_rgba(15,23,42,0.14)] sm:right-auto sm:w-[400px]"
        style={{ bottom: "calc(env(safe-area-inset-bottom) + 10px)" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-bold text-[color:var(--lab-teal-700)]">{dong}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tabular-nums text-[color:var(--lab-navy-950)]">
            {info.floor}층 창가 · 눈높이 {info.eyeM}m
          </span>
          <button
            type="button"
            onClick={onExit}
            className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-[color:var(--lab-navy-950)] px-3 text-[13px] font-semibold text-white transition active:scale-95"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            돌아가기
          </button>
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-1.5" aria-live="polite">
          <div className="rounded-lg bg-[color:var(--lab-brand-subtle)] px-2 py-1.5">
            <p className="text-[12px] text-[color:var(--lab-teal-700)]">방향</p>
            <p className="text-[15px] font-bold text-[color:var(--lab-navy-950)]">{info.facing}</p>
          </div>
          <div className="rounded-lg bg-[color:var(--lab-brand-subtle)] px-2 py-1.5">
            <p className="text-[12px] text-[color:var(--lab-teal-700)]">{info.frontHill ? "앞 지형까지" : "앞 건물까지"}</p>
            <p className="truncate text-[15px] font-bold tabular-nums text-[color:var(--lab-navy-950)]">
              {info.frontM != null ? `${info.frontM}m` : "500m+"}
            </p>
          </div>
          <div className="rounded-lg bg-[color:var(--lab-brand-subtle)] px-2 py-1.5">
            <p className="text-[12px] text-[color:var(--lab-teal-700)]">가림 비율</p>
            <p className={`text-[15px] font-bold tabular-nums ${tone}`}>{blocked}%</p>
          </div>
        </div>
        <p className="mt-1 text-[12px] leading-[17px] text-[color:var(--lab-muted)]">
          {Math.abs(info.yaw) >= 5
            ? `지금 ${info.lookDir}을 보는 중(정면에서 ${info.yaw > 0 ? "오른쪽" : "왼쪽"} ${Math.abs(info.yaw)}°) · `
            : ""}
          {info.frontHill ? "언덕·산이 먼저 가려요 · " : info.frontDong ? `${info.frontDong}이 먼저 보여요 · ` : ""}가림 = 화면에 보이는 가로 {info.spanDeg}° 중 200m 안에서 막힌 비율
          {info.roughGround ? " · 비탈이라 지형 자료가 거칠어 창 자리 땅높이 기준으로 보여줘요" : ""}
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <button type="button" className={stepBtn} onClick={() => onLook(-15)} aria-label="왼쪽으로 둘러보기">
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" className={stepBtn} onClick={() => onLook(15)} aria-label="오른쪽으로 둘러보기">
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="mt-1.5">
          <FloorSlider floor={info.floor} max={maxFloors} onChange={onFloor} onCommit={onFloorDone} />
        </div>
      </div>
    </>
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

/** 외벽 일조 색칠 — 켜기, 계산 진행, 범례, 고른 동의 층 구간별 요약 */
function FacadeSunControl({
  on,
  onToggle,
  progress,
  seasonLabel,
  dong,
}: {
  on: boolean;
  onToggle: () => void;
  progress: FacadeSunProgress | null;
  seasonLabel: string;
  dong: string | null;
}) {
  const busy = on && progress?.on && progress.done < progress.total;
  const h1 = (v: number) => (Math.round(v * 10) / 10).toString();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          onClick={onToggle}
          className={`flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold transition active:scale-95 ${
            on ? CHIP_ON : CHIP_OFF
          }`}
        >
          외벽 일조 색칠
        </button>
        {on ? (
          <span className="min-w-0 truncate text-[12px] tabular-nums text-[color:var(--lab-muted)]" aria-live="polite">
            {busy ? `계산 중 ${progress!.done}/${progress!.total}동` : `${seasonLabel} · 3개 층마다 · 해 드는 쪽 외벽`}
          </span>
        ) : (
          <span className="min-w-0 truncate text-[12px] text-[color:var(--lab-muted)]">모든 동 외벽을 층별 해 드는 시간으로</span>
        )}
      </div>
      {busy ? (
        <div className="h-1 overflow-hidden rounded-full bg-slate-100" aria-hidden>
          <div
            className="h-full rounded-full bg-[color:var(--lab-brand-primary)]"
            style={{ width: `${Math.round((progress!.done / Math.max(1, progress!.total)) * 100)}%` }}
          />
        </div>
      ) : null}
      {on ? (
        <div>
          <div className="flex h-2.5 overflow-hidden rounded-full" aria-label="하루 해 드는 시간 색 범례">
            {FACADE_SUN_COLORS.map((c) => (
              <span key={c} className="h-full flex-1" style={{ background: c }} />
            ))}
          </div>
          <div className="mt-0.5 flex justify-between text-[11px] tabular-nums text-[color:var(--lab-muted)]">
            <span>0</span>
            <span>2</span>
            <span>4</span>
            <span>6시간+</span>
          </div>
        </div>
      ) : null}
      {on && dong && progress?.selected?.length ? (
        <div>
          <p className="text-[12px] font-semibold text-[color:var(--lab-navy-950)]">
            {dong} 정면 벽 · 층 구간별 하루 해 드는 시간
          </p>
          <ul className="mt-0.5 grid grid-cols-3 gap-1">
            {[...progress.selected].reverse().map((b) => (
              <li
                key={b.from}
                className="flex items-center gap-1 rounded-md border border-[color:var(--lab-border)] px-1.5 py-0.5 text-[11px] tabular-nums text-[color:var(--lab-navy-950)]"
              >
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: FACADE_SUN_COLORS[Math.min(6, Math.floor(b.main))] }} aria-hidden />
                <span className="text-[color:var(--lab-muted)]">{b.from === b.to ? `${b.from}층` : `${b.from}~${b.to}층`}</span>
                <span className="ml-auto font-semibold">{h1(b.main)}시간</span>
              </li>
            ))}
          </ul>
          <p className="mt-0.5 text-[11px] leading-[15px] text-[color:var(--lab-muted)]">
            해 드는 쪽 가장 긴 외벽 기준 · 다른 벽은 모형 색 참고 · 주변 건물·지형 그림자 반영
          </p>
        </div>
      ) : null}
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
  // 모형 위 부채꼴과 같은 색: 트임(200m+) 하늘색(건물 청록과 구분) · 80~200m 주황 · 80m 안 빨강
  const tone = (s: (typeof sectors)[number]) =>
    s.open >= 0.6 || !Number.isFinite(s.nearestHit)
      ? { fg: "#0369a1", bg: "#f0f9ff", border: "#7dd3fc" }
      : s.nearestHit >= 80
        ? { fg: "#b45309", bg: "#fffbeb", border: "#fcd34d" }
        : { fg: "#dc2626", bg: "#fef2f2", border: "#fca5a5" };
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {sectors.map((s) => {
        const t = tone(s);
        return (
          <div key={s.label} className="min-w-0 rounded-md border px-1 py-1.5 text-center" style={{ borderColor: t.border, background: t.bg }}>
            <p className="text-[12px] font-semibold text-[color:var(--lab-navy-950)]">{s.label}</p>
            <p className="whitespace-nowrap text-[12px] font-bold tracking-tight tabular-nums sm:text-[13px]" style={{ color: t.fg }}>
              {s.open >= 0.6 || !Number.isFinite(s.nearestHit) ? "트임" : `${s.nearestHit}m 가림`}
            </p>
          </div>
        );
      })}
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

/** 층 슬라이더 — 조망 패널과 창문 시점이 같은 모양·범위·문구. onCommit은 손을 떼거나 방향키를 놓을 때 */
function FloorSlider({
  floor,
  max,
  onChange,
  onCommit,
}: {
  floor: number;
  max: number;
  onChange: (f: number) => void;
  onCommit?: (f: number) => void;
}) {
  const commit = (e: React.SyntheticEvent<HTMLInputElement>) =>
    onCommit?.(Number(e.currentTarget.value));
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between text-[12px] text-[color:var(--lab-muted)]">
        <span>
          몇 층에서 볼까요?{" "}
          <b className="text-[14px] tabular-nums text-[color:var(--lab-navy-950)]">
            {floor}층
          </b>
        </span>
        <span className="tabular-nums">1층 ~ {max}층</span>
      </span>
      <input
        type="range"
        min={1}
        max={Math.max(1, max)}
        step={1}
        value={floor}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        className="w-full touch-pan-x accent-[color:var(--lab-brand-primary)]"
        aria-label="층"
      />
    </label>
  );
}

/** 걷기 — 걷는 사람 · 도착지 목록 · 고른 경로 요약 · 빨리 감기 시간 · 걷기 종료 */
function WalkPanel({
  walk,
  loading,
  error,
  picked,
  onPick,
  onEnd,
  walker,
  onWalker,
  progress,
  onReplay,
  follow,
  onFollow,
  fromDong,
  terrainLabel,
}: {
  walk: WalkPayload | null;
  loading: boolean;
  error: string | null;
  picked: WalkDestination | null;
  onPick: (id: string) => void;
  onEnd: () => void;
  walker: WalkerId;
  onWalker: (v: WalkerId) => void;
  progress: { sec: number; done: boolean } | null;
  onReplay: () => void;
  follow: boolean;
  onFollow: (v: boolean) => void;
  fromDong: string | null;
  terrainLabel: string | null;
}) {
  const kindLabel = (k: WalkDestination["kind"]) =>
    k === "subway" ? "역" : k === "school" ? "학교" : "버스";
  const summary = (x: WalkDestination) =>
    [
      `${x.distanceM.toLocaleString("ko-KR")}m`,
      x.gainM >= 2 ? `오르막 ${x.gainM}m` : null,
      `횡단보도 ${x.crossings}`,
    ]
      .filter(Boolean)
      .join(" · ");
  const chip =
    "flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold transition active:scale-95";
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[12px] text-[color:var(--lab-muted)]">
          {fromDong ? `${fromDong} 출발` : "단지 출발"} · 동을 누르면 그 동에서 출발
        </p>
        {picked ? (
          <button
            type="button"
            onClick={onEnd}
            aria-label="걷기 종료 (Esc)"
            className="flex h-9 shrink-0 items-center gap-1 rounded-full bg-[color:var(--lab-navy-950)] px-3.5 text-[13px] font-semibold text-white transition active:scale-95"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            걷기 종료
          </button>
        ) : null}
      </div>
      {/* 걷는 사람 — 한 줄에서 하나만. 시간(서버 계산)과 모형 모습이 같이 바뀐다 */}
      <WalkerChips walker={walker} onWalker={onWalker} chip={chip} />
      {loading ? (
        <p className="py-2 text-[13px] text-[color:var(--lab-muted)]">
          걷는 길을 찾는 중…
        </p>
      ) : error ? (
        <p className="py-2 text-[13px] text-[color:var(--lab-muted)]">{error}</p>
      ) : walk && !walk.destinations.length ? (
        <p className="py-2 text-[13px] text-[color:var(--lab-muted)]">
          주변에 걸어서 갈 역·학교 경로를 찾지 못했어요.
        </p>
      ) : walk ? (
        <ul className="flex flex-col gap-0.5">
          {walk.destinations.map((x) => {
            const on = picked?.id === x.id;
            return (
              <li
                key={x.id}
                className={`rounded-lg border ${
                  on
                    ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)]"
                    : "border-transparent"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onPick(x.id)}
                  aria-pressed={on}
                  className="flex w-full flex-col items-start gap-0.5 rounded-lg px-1.5 py-1.5 text-left transition active:scale-[0.99]"
                >
                  <span className="flex w-full items-baseline gap-1.5">
                    <span className="shrink-0 rounded bg-slate-100 px-1 text-[11px] font-semibold text-[color:var(--lab-muted)]">
                      {kindLabel(x.kind)}
                    </span>
                    <span
                      className={`min-w-0 truncate text-[14px] font-bold ${
                        on ? "text-[color:var(--lab-teal-700)]" : "text-[color:var(--lab-navy-950)]"
                      }`}
                    >
                      {x.name}
                    </span>
                    <span className="shrink-0 text-[14px] font-bold tabular-nums text-[color:var(--lab-teal-700)]">
                      {x.totalMin}분
                    </span>
                    {x.sub && x.kind !== "bus" ? (
                      <span className="min-w-0 truncate text-[12px] text-[color:var(--lab-muted)]">
                        {x.sub}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[12px] font-semibold tabular-nums text-[color:var(--lab-muted)]">
                    {summary(x)}
                  </span>
                  {on ? (
                    <span className="flex flex-col gap-0.5 text-[12px] tabular-nums text-[color:var(--lab-muted)]">
                      <span>
                        걷기 {x.walkMin}분
                        {x.waitSec >= 20
                          ? ` + 신호 대기 약 ${Math.max(1, Math.round(x.waitSec / 60))}분`
                          : " · 신호 대기 거의 없음"}
                        {x.signalCrossings ? ` (신호 ${x.signalCrossings}곳)` : ""}
                        {x.range && x.range[0] !== x.range[1]
                          ? ` · 동에 따라 ${x.range[0]}~${x.range[1]}분`
                          : ""}
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {x.majorCrossing ? <Chip tone="rose">큰길 횡단</Chip> : null}
                        {x.maxGradePct >= 8 ? (
                          <Chip tone="amber">가장 가파른 곳 {Math.round(x.maxGradePct)}%</Chip>
                        ) : null}
                        {x.steps ? <Chip tone="violet">계단 있음</Chip> : null}
                        {x.underpasses ? <Chip tone="slate">지하보도 {x.underpasses}</Chip> : null}
                        {x.overpasses ? <Chip tone="slate">육교·보도교 {x.overpasses}</Chip> : null}
                        {x.throughPrivateM >= 30 ? (
                          <Chip tone="slate">다른 단지 안 {x.throughPrivateM}m</Chip>
                        ) : null}
                        {x.gate ? <Chip tone="teal">{x.gate}</Chip> : null}
                      </span>
                    </span>
                  ) : null}
                </button>
                {on && progress ? (
                  <div className="flex items-center gap-1.5 px-1.5 pb-1.5 text-[12px] font-semibold tabular-nums text-[color:var(--lab-teal-700)]">
                    {/* 따라가는 동안은 채운 모양 대신 "따라가는 중…" 글자로 상태를 알린다 (다시 누르면 멈춤) */}
                    <button
                      type="button"
                      aria-pressed={follow}
                      aria-label={follow ? "따라가는 중 — 누르면 멈춤" : "따라가기"}
                      onClick={() => onFollow(!follow)}
                      className={`${chip} border border-[color:var(--lab-border)] bg-white ${
                        follow ? "text-[color:var(--lab-teal-700)]" : "text-[color:var(--lab-navy-950)]"
                      }`}
                      data-walk-follow={follow ? "on" : "off"}
                    >
                      <Footprints className="h-3.5 w-3.5" aria-hidden />
                      {follow ? (
                        <>
                          따라가는 중
                          <span className="lab-ellipsis" aria-hidden>
                            <span>.</span>
                            <span>.</span>
                            <span>.</span>
                          </span>
                        </>
                      ) : (
                        "따라가기"
                      )}
                    </button>
                    <span>
                      {progress.done ? "도착" : "걷는 중"} {mmss(progress.sec)}
                    </span>
                    {progress.done ? (
                      <button
                        type="button"
                        onClick={onReplay}
                        aria-label="다시 걷기"
                        className="flex h-7 w-7 items-center justify-center rounded-full border border-[color:var(--lab-border)] bg-white text-[color:var(--lab-navy-950)] transition active:scale-95"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {walk ? (
        <p className="text-[11px] leading-[15px] text-[color:var(--lab-muted)]">
          {WALKER_LABEL[walk.walker?.id ?? walker]} 평지 시속{" "}
          {walk.walker ? (walk.walker.mps * 3.6).toFixed(1) : "4.5"}km·경사 반영
          {terrainLabel ? ` · 지형 ${terrainLabel}` : ""} · 역 안 승강장까지 시간 제외
        </p>
      ) : null}
    </div>
  );
}

/**
 * 걷는 사람 칩 한 줄 (성인 남성 · 성인 여성 · 어린이 · 어르신 · 유모차·휠체어) — 하나만 고른다.
 * 폭이 모자라면 옆으로 밀고, 더 있는 쪽 끝은 흐리게 보여 준다. 고른 칩은 처음에 보이는 곳으로.
 */
function WalkerChips({
  walker,
  onWalker,
  chip,
}: {
  walker: WalkerId;
  onWalker: (v: WalkerId) => void;
  chip: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdge((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);
  // 처음 한 번만 고른 칩이 보이게 옮기고, 폭이 바뀌면 흐린 끝을 다시 잰다
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = el.querySelector<HTMLElement>('[aria-checked="true"]');
    if (on && (on.offsetLeft + on.offsetWidth > el.clientWidth || on.offsetLeft < el.scrollLeft)) {
      el.scrollLeft = on.offsetLeft - 8;
    }
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  const fade = 20;
  const mask =
    edge.left || edge.right
      ? `linear-gradient(to right, ${edge.left ? `transparent, #000 ${fade}px` : "#000"}, ${
          edge.right ? `#000 calc(100% - ${fade}px), transparent` : "#000"
        })`
      : undefined;
  const pick = (id: WalkerId) => onWalker(id);
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label="걷는 사람"
      onScroll={measure}
      data-walker-chips
      className="-mx-0.5 flex gap-1 overflow-x-auto px-0.5 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {WALKER_IDS.map((id, i) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={walker === id}
          tabIndex={walker === id ? 0 : -1}
          onClick={() => pick(id)}
          onKeyDown={(e) => {
            const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const next = WALKER_IDS[(i + d + WALKER_IDS.length) % WALKER_IDS.length]!;
            pick(next);
            const btn = ref.current?.querySelectorAll<HTMLElement>('[role="radio"]')[WALKER_IDS.indexOf(next)];
            btn?.focus();
            btn?.scrollIntoView({ block: "nearest", inline: "nearest" });
          }}
          className={`${chip} ${walker === id ? CHIP_ON : CHIP_OFF}`}
        >
          {WALKER_LABEL[id]}
        </button>
      ))}
    </div>
  );
}

function Chip({
  tone,
  children,
}: {
  tone: "rose" | "amber" | "violet" | "slate" | "teal";
  children: React.ReactNode;
}) {
  const cls = {
    rose: "bg-rose-50 text-rose-600",
    amber: "bg-amber-50 text-amber-700",
    violet: "bg-violet-50 text-violet-700",
    slate: "bg-slate-100 text-slate-600",
    teal: "bg-[color:var(--lab-brand-subtle)] text-[color:var(--lab-teal-700)]",
  }[tone];
  return <span className={`rounded px-1.5 py-px text-[11px] font-semibold ${cls}`}>{children}</span>;
}
