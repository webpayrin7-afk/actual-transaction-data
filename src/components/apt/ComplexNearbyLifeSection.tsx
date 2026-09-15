"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { NaverMap, type NaverMapMarker } from "@/components/map/NaverMap";
import { LabCard, labSecondaryTabClass , labSegmentedClass } from "@/components/ui/lab";
import { InfoTip } from "@/components/ui/InfoTip";
import type { LatLng } from "@/lib/nearby-map/geo";
import {
  resolveComplexMapAnchor,
  subwayLineColor,
  type ComplexMapAnchorResult,
} from "@/lib/nearby-map/complex-map-anchor";
import { Bus, ChevronRight } from "lucide-react";

export type NearbyLifeCategory = "transport" | "living" | "commerce" | "school";

type AddressMeta = {
  available: boolean;
  address: string | null;
  addressType: string | null;
  addressSource: string | null;
};

type PoiItem = {
  id: string;
  name: string;
  subcategory: string;
  distanceMeters: number;
  distanceLabel: string;
  lat: number;
  lng: number;
  /** Official subway line numbers when present. */
  lines?: string[];
  /** Official bus route numbers joined by stop id. */
  routes?: string[];
};

type SchoolItem = {
  id: string;
  name: string;
  level: string;
  foundation: string | null;
  distanceMeters: number | null;
  distanceLabel: string | null;
  lat: number | null;
  lng: number | null;
};

type CategoryPayload<T> = {
  status: string;
  reason?: string;
  note?: string | null;
  items: T[];
};

type NearbyLifeResponse = {
  address: AddressMeta;
  coords: LatLng | null;
  transport: CategoryPayload<PoiItem>;
  living: CategoryPayload<PoiItem>;
  commerce: CategoryPayload<PoiItem> & { summary: null | unknown };
  school: CategoryPayload<SchoolItem>;
};

const TABS: Array<{ id: NearbyLifeCategory; label: string }> = [
  { id: "transport", label: "교통" },
  { id: "living", label: "생활" },
  { id: "commerce", label: "상권" },
  { id: "school", label: "학교" },
];

const LEVEL_LABEL: Record<string, string> = {
  elementary: "초등학교",
  middle: "중학교",
  high: "고등학교",
  other: "학교",
};

const LIST_LIMIT = 5;
/** Bus stops shown before “더보기” (subway always fully listed). */
const TRANSPORT_BUS_LIST_LIMIT = 4;
/** Bus map markers — mirror listed stops. */
const TRANSPORT_BUS_MARKER_LIMIT = 4;

function isSubwayPoi(p: { name: string; subcategory: string }): boolean {
  const s = `${p.subcategory} ${p.name}`;
  if (/버스|정류|ARS/.test(s)) return false;
  return /지하철|전철|\d호선|역/.test(s);
}

function subwayLinesOf(p: PoiItem): string[] {
  if (p.lines && p.lines.length > 0) {
    return p.lines.map((l) => l.replace(/호선$/u, "").trim()).filter(Boolean);
  }
  const matches = [...(p.subcategory || "").matchAll(/(\d+)\s*호선/g)].map(
    (m) => m[1],
  );
  if (matches.length) return matches;
  const m = (p.subcategory || "").match(/(\d+)/);
  return m ? [m[1]] : [];
}

function busRoutesOf(p: PoiItem): string[] {
  if (!p.routes?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of p.routes) {
    const t = String(r || "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function formatMeters(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `${Math.round(meters)}m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

async function fetchNearbyLife(
  aptName: string,
  coords: LatLng,
): Promise<NearbyLifeResponse> {
  const qs = new URLSearchParams({
    aptName,
    lat: String(coords.lat),
    lng: String(coords.lng),
  });
  const res = await fetch(`/api/complex-nearby-life?${qs}`);
  if (!res.ok) {
    throw new Error("주변 생활 정보를 불러오지 못했습니다.");
  }
  return res.json();
}

function EmptyBlock({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-3">
      <p className="text-sm text-slate-600">{children}</p>
    </div>
  );
}

function selectedRowClass(active: boolean): string {
  return active
    ? "bg-[var(--lab-teal-50)] ring-1 ring-[color-mix(in_srgb,var(--lab-teal-600)_30%,transparent)]"
    : "hover:bg-slate-50";
}

/**
 * Complex Detail — “주변 생활”
 * One shared NAVER map + category tabs. Client geocode; no DB write.
 */
export function ComplexNearbyLifeSection({
  aptName,
  identity,
}: {
  aptName: string;
  identity?: {
    roadAddress?: string | null;
    sido?: string | null;
    sigungu?: string | null;
    legalDongName?: string | null;
    jibun?: string | null;
  } | null;
}) {
  const [tab, setTab] = useState<NearbyLifeCategory>("transport");
  const [coords, setCoords] = useState<LatLng | null>(null);
  const [mapAnchor, setMapAnchor] = useState<ComplexMapAnchorResult | null>(
    null,
  );
  const [geocodeStatus, setGeocodeStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [geocodeReason, setGeocodeReason] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const mapSectionRef = useRef<HTMLDivElement | null>(null);

  const selectFromList = useCallback((id: string) => {
    setSelectedId(id);
    mapSectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        setGeocodeStatus("loading");

        let apiAddress: string | null = null;
        try {
          const qs = new URLSearchParams({ aptName });
          const res = await fetch(`/api/complex-nearby-life?${qs}`);
          if (res.ok) {
            const json = (await res.json()) as NearbyLifeResponse;
            apiAddress = json.address?.address?.trim() || null;
          }
        } catch {
          /* optional — identity / pilot addresses still tried */
        }
        if (cancelled) return;

        const result = await resolveComplexMapAnchor({
          aptName,
          identity,
          apiAddress,
        });
        if (cancelled) return;
        setMapAnchor(result);
        if (!result.ok) {
          setGeocodeStatus("error");
          setGeocodeReason("위치 정보를 확인 중입니다");
          setCoords(null);
          return;
        }
        setCoords(result.coordinate);
        setGeocodeStatus("ready");
        setGeocodeReason(null);
      })();
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [identity, aptName]);

  const lifeQuery = useQuery({
    queryKey: [
      "complex-nearby-life",
      aptName,
      coords?.lat ?? null,
      coords?.lng ?? null,
    ],
    queryFn: () => fetchNearbyLife(aptName, coords!),
    enabled: !!coords && geocodeStatus === "ready",
    staleTime: 60 * 60 * 1000,
    retry: 0,
  });

  const selectTab = useCallback((next: NearbyLifeCategory) => {
    setTab(next);
    setSelectedId(null);
    setExpanded(false);
  }, []);

  const complexMarker: NaverMapMarker | null = useMemo(
    () =>
      coords
        ? {
            id: "complex",
            position: coords,
            title: aptName,
            label: aptName,
            kind: "COMPLEX",
            selected: selectedId === "complex",
          }
        : null,
    [coords, aptName, selectedId],
  );

  const tabMarkers: NaverMapMarker[] = useMemo(() => {
    const data = lifeQuery.data;
    if (!data || !coords) return [];
    if (tab === "transport") {
      const withCoords = data.transport.items.filter(
        (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
      );
      const subways = withCoords
        .filter(isSubwayPoi)
        .sort((a, b) => a.distanceMeters - b.distanceMeters);
      const buses = withCoords
        .filter((p) => !isSubwayPoi(p))
        .sort((a, b) => a.distanceMeters - b.distanceMeters);
      // Subway: always show all listed stations on the map.
      const subwayShown = subways;
      const busShown = expanded
        ? buses
        : buses.slice(0, Math.min(TRANSPORT_BUS_LIST_LIMIT, TRANSPORT_BUS_MARKER_LIMIT));
      return [
        ...subwayShown.map((p) => {
          const lines = subwayLinesOf(p);
          return {
            id: p.id,
            position: { lat: p.lat, lng: p.lng },
            title: p.name,
            label: p.name.replace(/역$/, ""),
            badge: lines[0] || "역",
            color: subwayLineColor(lines[0] || p.subcategory || ""),
            badges: lines.map((line) => ({
              text: line,
              color: subwayLineColor(line),
            })),
            kind: "TRANSIT" as const,
            selected: selectedId === p.id,
          };
        }),
        ...busShown.map((p) => ({
          id: p.id,
          position: { lat: p.lat, lng: p.lng },
          title: p.name,
          kind: "OTHER" as const,
          variant: "bus-stop" as const,
          selected: selectedId === p.id,
        })),
      ];
    }
    if (tab === "living") {
      return data.living.items
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map((p) => ({
          id: p.id,
          position: { lat: p.lat, lng: p.lng },
          title: p.name,
          kind:
            p.subcategory === "병원"
              ? ("MEDICAL" as const)
              : ("LIVING" as const),
          selected: selectedId === p.id,
        }));
    }
    if (tab === "school") {
      return data.school.items
        .filter(
          (s): s is SchoolItem & { lat: number; lng: number } =>
            s.lat != null &&
            s.lng != null &&
            Number.isFinite(s.lat) &&
            Number.isFinite(s.lng),
        )
        .map((s) => ({
          id: s.id,
          position: { lat: s.lat, lng: s.lng },
          title: s.name,
          kind: "SCHOOL" as const,
          selected: selectedId === s.id,
        }));
    }
    return [];
  }, [lifeQuery.data, tab, coords, selectedId, expanded]);

  const markers = useMemo(() => {
    const list = [...tabMarkers];
    if (complexMarker) list.unshift(complexMarker);
    return list;
  }, [tabMarkers, complexMarker]);

  const onMarkerClick = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const mapCenter = useMemo(() => {
    if (selectedId && selectedId !== "complex") {
      const m = tabMarkers.find((x) => x.id === selectedId);
      if (m) return m.position;
    }
    return coords;
  }, [selectedId, tabMarkers, coords]);

  const summaryText = useMemo(() => {
    const data = lifeQuery.data;
    if (!data) return null;
    if (tab === "transport" && data.transport.status === "READY") {
      return `교통 · ${data.transport.items.length}곳 · 직선거리`;
    }
    if (tab === "living" && data.living.status === "READY") {
      return `생활 · ${data.living.items.length}곳 · 직선거리`;
    }
    if (tab === "school" && data.school.status === "READY") {
      return `인근 학교 · ${data.school.items.length}곳 · 직선거리`;
    }
    return null;
  }, [lifeQuery.data, tab]);

  const listContent = (() => {
    if (geocodeStatus === "loading" || geocodeStatus === "idle") {
      return <EmptyBlock>위치 정보를 확인하는 중…</EmptyBlock>;
    }
    if (geocodeStatus === "error" || !coords) {
      return (
        <EmptyBlock>{geocodeReason || "위치 정보를 확인 중입니다"}</EmptyBlock>
      );
    }
    if (lifeQuery.isLoading) {
      return <EmptyBlock>주변 생활 정보를 불러오는 중…</EmptyBlock>;
    }
    if (lifeQuery.isError || !lifeQuery.data) {
      return <EmptyBlock>주변 생활 정보를 불러오지 못했습니다.</EmptyBlock>;
    }

    const data = lifeQuery.data;

    if (tab === "commerce") {
      return (
        <EmptyBlock>
          {data.commerce.reason || "상권 상세 분석 준비 중"}
        </EmptyBlock>
      );
    }

    if (tab === "transport") {
      if (data.transport.status !== "READY" || !data.transport.items.length) {
        return (
          <EmptyBlock>
            현재 확인 가능한 주변 교통 정보가 없습니다.
          </EmptyBlock>
        );
      }
      const subways = data.transport.items
        .filter(isSubwayPoi)
        .sort((a, b) => a.distanceMeters - b.distanceMeters);
      const buses = data.transport.items
        .filter((p) => !isSubwayPoi(p))
        .sort((a, b) => a.distanceMeters - b.distanceMeters);
      // Subway: always list all nearby stations. Bus: 4 default, expand via 더보기.
      const subwayItems = subways;
      const busItems = expanded
        ? buses
        : buses.slice(0, TRANSPORT_BUS_LIST_LIMIT);

      return (
        <div className="space-y-4">
          {subwayItems.length > 0 ? (
            <div>
              <p className="mb-1.5 text-[12px] font-semibold text-slate-700">
                지하철
              </p>
              <ul className="space-y-1">
                {subwayItems.map((p) => {
                  const lines = subwayLinesOf(p);
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => selectFromList(p.id)}
                        aria-label={`${p.name} 지도에서 보기`}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${selectedRowClass(selectedId === p.id)}`}
                      >
                        <span className="mt-0.5 flex shrink-0 items-center gap-0.5">
                          {lines.length > 0 ? (
                            lines.map((line) => (
                              <span
                                key={`${p.id}-${line}`}
                                className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-black/25 px-1 text-[10px] font-bold text-white shadow-sm"
                                style={{
                                  backgroundColor: subwayLineColor(line),
                                }}
                              >
                                {line}
                              </span>
                            ))
                          ) : (
                            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-black/25 bg-amber-700 px-1 text-[10px] font-bold text-white shadow-sm">
                              역
                            </span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-slate-800">
                            {p.name}
                          </span>
                          <span className="mt-0.5 block text-[11px] text-slate-500">
                            {formatMeters(p.distanceMeters)}
                            {" · 직선거리"}
                          </span>
                        </span>
                        <ChevronRight
                          className="h-4 w-4 shrink-0 text-slate-400"
                          aria-hidden
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {busItems.length > 0 ? (
            <div>
              <p className="mb-1.5 text-[12px] font-semibold text-slate-700">
                버스
              </p>
              <ul className="space-y-1">
                {busItems.map((p) => {
                  const routes = busRoutesOf(p);
                  const metaText = `${formatMeters(p.distanceMeters)} · 직선거리`;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => selectFromList(p.id)}
                        aria-label={`${p.name} 지도에서 보기`}
                        className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition ${selectedRowClass(selectedId === p.id)}`}
                      >
                        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-slate-300 bg-white text-[#1e3a5f]">
                          <Bus className="h-3 w-3" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="min-w-0 truncate text-sm font-medium text-slate-800">
                              {p.name}
                            </span>
                            <span className="shrink-0 text-[11px] text-slate-500">
                              {metaText}
                            </span>
                          </span>
                          {routes.length > 0 ? (
                            <span className="mt-1.5 flex flex-wrap items-center gap-1">
                              {routes.map((route) => (
                                <span
                                  key={`${p.id}-${route}`}
                                  className="inline-flex h-5 items-center rounded border border-slate-200 bg-slate-50 px-1.5 text-[10px] font-semibold text-slate-700"
                                >
                                  {route}
                                </span>
                              ))}
                            </span>
                          ) : null}
                        </span>
                        <ChevronRight
                          className="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
                          aria-hidden
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      );
    }

    if (tab === "living") {
      if (data.living.status !== "READY" || !data.living.items.length) {
        return (
          <EmptyBlock>
            {data.living.reason || "표시할 생활 시설이 없습니다."}
          </EmptyBlock>
        );
      }
      const items = expanded
        ? data.living.items
        : data.living.items.slice(0, LIST_LIMIT);
      return (
        <ul className="space-y-1.5">
          {items.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => selectFromList(p.id)}
                className={`flex w-full items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition ${selectedRowClass(selectedId === p.id)}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-800">
                    {p.name}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-slate-500">
                    {p.subcategory}
                  </span>
                </span>
                <span className="shrink-0 text-right text-[11px] tabular-nums text-slate-500">
                  <span className="block">
                    {p.distanceLabel.replace(/^직선거리\s*/, "")}
                  </span>
                  <span className="block text-[10px] text-slate-400">
                    직선거리
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      );
    }

    if (data.school.status === "PILOT_ONLY") {
      return (
        <EmptyBlock>
          {data.school.note || "인근 학교 실데이터는 준비 중입니다."}
        </EmptyBlock>
      );
    }
    if (data.school.status === "ERROR") {
      return (
        <EmptyBlock>
          {data.school.note || "인근 학교 정보를 불러오지 못했습니다."}
        </EmptyBlock>
      );
    }
    if (data.school.status !== "READY" || !data.school.items.length) {
      return (
        <EmptyBlock>
          {data.school.note || "표시할 인근 학교가 없습니다."}
        </EmptyBlock>
      );
    }
    const items = expanded
      ? data.school.items
      : data.school.items.slice(0, LIST_LIMIT);
    return (
      <ul className="space-y-1.5">
        {items.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => selectFromList(s.id)}
              disabled={s.lat == null || s.lng == null}
              className={`flex w-full items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition disabled:cursor-default ${selectedRowClass(selectedId === s.id)}`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-slate-800">
                  {s.name}
                </span>
                <span className="mt-0.5 block text-[11px] text-slate-500">
                  {[LEVEL_LABEL[s.level] ?? "인근 학교", s.foundation]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="shrink-0 text-right text-[11px] tabular-nums text-slate-500">
                {s.distanceLabel ? (
                  <>
                    <span className="block">
                      {s.distanceLabel.replace(/^직선거리\s*/, "")}
                    </span>
                    <span className="block text-[10px] text-slate-400">
                      직선거리
                    </span>
                  </>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  })();

  const moreCount = (() => {
    const data = lifeQuery.data;
    if (!data || expanded) return 0;
    if (tab === "transport") {
      // 더보기 expands bus stops only — subway is always fully listed.
      const buses = data.transport.items.filter((p) => !isSubwayPoi(p)).length;
      return Math.max(0, buses - TRANSPORT_BUS_LIST_LIMIT);
    }
    if (tab === "living") {
      return Math.max(0, data.living.items.length - LIST_LIMIT);
    }
    if (tab === "school") {
      return Math.max(0, data.school.items.length - LIST_LIMIT);
    }
    return 0;
  })();

  return (
    <LabCard className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-1">
        <h2 className="text-base font-semibold text-[var(--lab-navy-950)]">
          주변 생활
        </h2>
        <InfoTip aria-label="주변 생활 출처 안내" className="ml-0.5">
          <p className="text-[12px] leading-relaxed text-slate-600">
            지도: NAVER Maps
            <br />
            단지 위치:{" "}
            {mapAnchor?.ok && mapAnchor.anchorType === "NAVER_POI"
              ? "NAVER POI"
              : "NAVER Geocode"}
            {mapAnchor &&
            (!mapAnchor.ok || mapAnchor.poiLookup === "HOLD")
              ? " (POI HOLD)"
              : ""}
            <br />
            지하철: 서울교통공사 1–8호선 + 9호선 2·3단계
            <br />
            버스정류장: 서울특별시
            <br />
            버스노선: 서울시 버스 노선별정류소 (정류소 ID 조인)
            <br />
            거리: 직선거리
            <br />
            학교: NEIS schoolInfo (인근 학교)
            <br />
            생활: 공개 장소검색 · 직선거리
          </p>
        </InfoTip>
      </div>
      <p className="mt-1 text-[13px] text-slate-500">
        {aptName} 주변 생활환경
      </p>

      <div
        className={labSegmentedClass("mt-3")}
        role="tablist"
        aria-label="주변 생활 카테고리"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => selectTab(t.id)}
            className={labSecondaryTabClass(tab === t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "transport" ? (
        <div className="mt-3 space-y-3">
          {/* Full-bleed map — width retained, height reduced so list peeks in */}
          <div
            ref={mapSectionRef}
            className="relative -mx-4 overflow-hidden bg-slate-50/40 sm:-mx-5 sm:rounded-none"
          >
            {coords && geocodeStatus === "ready" ? (
              <NaverMap
                center={mapCenter ?? coords}
                zoom={15}
                markers={markers}
                selectedId={selectedId}
                onMarkerClick={onMarkerClick}
                ariaLabel={`${aptName} 주변 교통 지도`}
                className="h-[240px] w-full sm:h-[280px] lg:h-[330px]"
              />
            ) : (
              <div className="flex h-[240px] items-center justify-center px-4 text-center text-sm text-slate-500 sm:h-[280px] lg:h-[330px]">
                {geocodeStatus === "loading" || geocodeStatus === "idle"
                  ? "지도를 준비하는 중…"
                  : geocodeReason || "위치 정보를 확인 중입니다"}
              </div>
            )}
          </div>

          <div className="min-w-0">{listContent}
            {moreCount > 0 ? (
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="text-[14px] font-medium text-[var(--lab-teal-700)] hover:underline"
                >
                  버스 정류장 더보기 · {moreCount}곳
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:items-start">
          <div
            ref={mapSectionRef}
            className="min-w-0 overflow-hidden rounded-xl bg-slate-50/40"
          >
            {coords && geocodeStatus === "ready" ? (
              <NaverMap
                center={mapCenter ?? coords}
                zoom={15}
                markers={markers}
                selectedId={selectedId}
                onMarkerClick={onMarkerClick}
                ariaLabel={`${aptName} 주변 생활 지도`}
                className="h-[280px] w-full sm:h-[300px] lg:h-[360px]"
              />
            ) : (
              <div className="flex h-[280px] items-center justify-center px-4 text-center text-sm text-slate-500 sm:h-[300px] lg:h-[360px]">
                {geocodeStatus === "loading" || geocodeStatus === "idle"
                  ? "지도를 준비하는 중…"
                  : geocodeReason || "위치 정보를 확인 중입니다"}
              </div>
            )}
          </div>

          <div className="min-w-0">
            {summaryText ? (
              <p className="mb-2 text-[12px] font-medium text-slate-500">
                {summaryText}
              </p>
            ) : null}
            {listContent}
            {moreCount > 0 ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="mt-2 text-[12px] font-medium text-[var(--lab-teal-700)] hover:underline"
              >
                더보기 · {moreCount}곳
              </button>
            ) : null}
          </div>
        </div>
      )}
    </LabCard>
  );
}
