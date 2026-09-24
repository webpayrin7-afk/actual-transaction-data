"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Complex3d } from "@/lib/complex-3d/read";
import { BackLink } from "@/components/layout/BackLink";
import { LabTabs } from "@/components/ui/LabTabs";
import type { Complex3dScene, SceneMode, ViewResult } from "@/components/complex-3d/scene";
import { TYPE_COLORS } from "@/components/complex-3d/palette";

async function fetch3d(id: string): Promise<Complex3d> {
  const res = await fetch(`/api/complex-3d/${encodeURIComponent(id)}`);
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

/** 3D 단지 탐색 — 실제 높이 모형 · 층별 시세 · 일조 · 조망 · 주변 */
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
        scene.setFloorBands(d.floorBands);
        scene.setPois(d.pois);
        const colors = new Map(typeLegend.map((t) => [t.label, t.color]));
        scene.setTypeColors((label) => colors.get(label) ?? "#d5dbe1");
        const s = scene;
        s.onSelect = (id) => {
          setSelected(id);
          setNearest(id ? s.nearestDistance(id) : null);
        };
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

  return (
    <div className="relative flex flex-col bg-[color:var(--lab-surface)]" style={{ height: "calc(100dvh - var(--site-header-height, 56px))" }}>
      {/* 상단: 뒤로 · 단지명 · 모드 */}
      <div className="z-10 flex flex-col gap-2 border-b border-[color:var(--lab-border)] bg-white px-3 pb-2 pt-1.5">
        <div className="flex min-h-11 items-center gap-1">
          <BackLink fallback={d?.href ?? "/complexes"} compact hideLabel />
          <div className="min-w-0">
            <p className="detail-subsection-title truncate">{d?.name ?? "3D 단지 탐색"}</p>
            {d ? <p className="detail-meta truncate">{d.place} · 3D 단지 탐색</p> : null}
          </div>
        </div>
        <LabTabs variant="secondary" ariaLabel="3D 보기" items={MODES} value={mode} onChange={setMode} />
      </div>

      {/* 캔버스 */}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0 touch-none" />
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
        {d && hasShape && d.coverage.withShape < d.coverage.buildings ? (
          <p className="pointer-events-none absolute left-3 top-3 rounded-md bg-white/90 px-2 py-1 detail-meta shadow-sm">
            동 {d.coverage.buildings}개 중 {d.coverage.withShape}개 모양 · 나머지는 준비 중
          </p>
        ) : null}
        <p className="pointer-events-none absolute bottom-1 right-2 text-[11px] text-[color:var(--lab-muted)]">
          건물: 국토교통부 GIS건물통합정보{estimated ? " · 일부 높이는 층수×3m로 표시" : ""}
        </p>
      </div>

      {/* 하단 패널 — 모드별 조작 + 고른 동 정보 */}
      {d && hasShape ? (
        <div className="z-10 max-h-[42%] overflow-y-auto border-t border-[color:var(--lab-border)] bg-white px-3 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3">
          {mode === "floors" ? (
            <div className="flex flex-col gap-2">
              <p className="detail-label">층 구간별 전용 3.3㎡당 중위가 · {d.floorBandsBasis}</p>
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
                <p className="detail-label">동마다 세대가 가장 많은 평형(주력 평형) 색이에요. 동을 누르면 그 동의 평형 구성이 나와요.</p>
                <ul className="flex flex-col gap-1.5">
                  {typeLegend.map((t) => (
                    <li key={t.label} className="flex items-start gap-2">
                      <span className="mt-1 h-3 w-3 shrink-0 rounded-sm" style={{ background: t.color }} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="detail-data-value tabular-nums">{t.label}</span>
                        <span className="detail-meta ml-1.5 tabular-nums">{t.households.toLocaleString("ko-KR")}세대</span>
                        {t.mainDongs.length ? (
                          <span className="detail-meta block">주력 동 {t.mainDongs.join(", ")}</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="detail-meta">
                  동 안에서 어느 라인이 어느 평형인지(호 라인별)는 건축물대장 전유부 적재 후 보여줄 예정이에요. 라인이 건물 어느 쪽에
                  있는지는 공공데이터에 없어 표시하지 않아요.
                </p>
              </div>
            ) : (
              <p className="detail-body">이 단지는 동별 평형 정보가 아직 없어요.</p>
            )
          ) : null}

          {mode === "sun" ? (
            <div className="flex flex-col gap-2">
              <LabTabs
                variant="compact"
                ariaLabel="계절"
                items={SEASONS.map((s) => ({ id: s.id, label: s.label }))}
                value={season}
                onChange={setSeason}
              />
              <label className="flex items-center gap-3">
                <span className="detail-label w-14 tabular-nums">{String(hour).padStart(2, "0")}:00</span>
                <input
                  type="range"
                  min={6}
                  max={19}
                  step={1}
                  value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                  className="flex-1 accent-[color:var(--lab-brand-primary)]"
                  aria-label="시각"
                />
              </label>
              <p className="detail-meta tabular-nums">
                {sunInfo && sunInfo.altitude > 0
                  ? `해 높이 ${Math.round((sunInfo.altitude * 180) / Math.PI)}° · ${dirOf((sunInfo.azimuth * 180) / Math.PI)}쪽에서 비춰요`
                  : "해가 진 시각이에요"}
              </p>
            </div>
          ) : null}

          {mode === "view" ? (
            !sel ? (
              <p className="detail-body">조망을 볼 동을 눌러 주세요.</p>
            ) : (
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-3">
                  <span className="detail-label w-14 tabular-nums">{Math.min(viewFloor, maxFloors)}층</span>
                  <input
                    type="range"
                    min={1}
                    max={Math.max(1, maxFloors)}
                    step={1}
                    value={Math.min(viewFloor, maxFloors)}
                    onChange={(e) => setViewFloor(Number(e.target.value))}
                    className="flex-1 accent-[color:var(--lab-brand-primary)]"
                    aria-label="층"
                  />
                </label>
                {view ? (
                  <>
                    <p className="detail-body tabular-nums">
                      {sel.dong ?? "이 동"} {Math.min(viewFloor, maxFloors)}층 눈높이에서 200m 안에 가리는 건물이 없는 방향이{" "}
                      <b>{Math.round(view.openShare * 100)}%</b>예요.
                    </p>
                    <OpenDirections view={view} />
                    <p className="detail-meta">
                      청록 = 200m 이상 트임 · 주황 = 80~200m · 빨강 = 80m 안 가림. 주변 건물 모양이 없는 곳은 트인 것으로 보일 수 있어요.
                    </p>
                  </>
                ) : null}
              </div>
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

          {(mode === "base" || mode === "floors" || mode === "types" || mode === "view") && sel ? (
            <div className={`${mode === "base" ? "" : "mt-3 border-t border-[color:var(--lab-border)] pt-3"} flex flex-col gap-1.5`}>
              <p className="detail-subsection-title">{sel.dong ?? sel.name ?? "동"}</p>
              <p className="detail-body tabular-nums">
                {[
                  sel.floors ? `지상 ${sel.floors}층` : null,
                  sel.floorsBelow ? `지하 ${sel.floorsBelow}층` : null,
                  sel.heightM ? `높이 ${sel.heightM}m` : null,
                  sel.households ? `${sel.households.toLocaleString("ko-KR")}세대` : null,
                  sel.approvalDate ? `${sel.approvalDate.slice(0, 4)}년 사용승인` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {sel.units.length ? (
                <p className="detail-meta tabular-nums">평형 {sel.units.map((u) => `${u.label} ${u.households}세대`).join(" · ")}</p>
              ) : null}
              {nearest ? (
                <p className="detail-meta tabular-nums">
                  가장 가까운 동 {nearest.dong ?? ""}까지 {nearest.meters}m
                </p>
              ) : null}
            </div>
          ) : mode === "base" ? (
            <p className="detail-body">
              손가락으로 돌리고 확대해 보세요. 동을 누르면 층수·세대수·평형과 가장 가까운 동까지 거리를 보여줘요.
            </p>
          ) : null}
        </div>
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
