"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { NaverMap, type NaverMapMarker } from "@/components/map/NaverMap";
import { LabCard, labSecondaryTabClass } from "@/components/ui/lab";
import { InfoTip } from "@/components/ui/InfoTip";
import { geocodeAddressWithNaver } from "@/lib/nearby-map/naver-sdk";
import type { LatLng } from "@/lib/nearby-map/geo";

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
const TRANSPORT_LIST_LIMIT = 5;
const TRANSPORT_MARKER_LIMIT = 6;

function isSubwayPoi(p: { name: string; subcategory: string }): boolean {
  const s = `${p.subcategory} ${p.name}`;
  if (/버스|정류/.test(s)) return false;
  return /지하철|전철|\d호선|역/.test(s);
}

function formatMeters(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `${Math.round(meters)}m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

function buildAddressFromIdentity(identity?: {
  roadAddress?: string | null;
  sido?: string | null;
  sigungu?: string | null;
  legalDongName?: string | null;
  jibun?: string | null;
} | null): string | null {
  const road = identity?.roadAddress?.trim();
  if (road) return road;
  const parts = [
    identity?.sido?.trim(),
    identity?.sigungu?.trim(),
    identity?.legalDongName?.trim(),
    identity?.jibun?.trim(),
  ].filter(Boolean);
  if (parts.length >= 4) return parts.join(" ");
  return null;
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
  const [geocodeStatus, setGeocodeStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [geocodeReason, setGeocodeReason] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const seedAddress = useMemo(
    () => buildAddressFromIdentity(identity),
    [identity],
  );

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        setGeocodeStatus("loading");

        let address = seedAddress;
        if (!address) {
          try {
            const qs = new URLSearchParams({ aptName });
            const res = await fetch(`/api/complex-nearby-life?${qs}`);
            if (res.ok) {
              const json = (await res.json()) as NearbyLifeResponse;
              address = json.address?.address?.trim() || null;
            }
          } catch {
            /* fail-closed below */
          }
        }

        if (cancelled) return;
        if (!address) {
          setGeocodeStatus("error");
          setGeocodeReason("위치 정보를 확인 중입니다");
          setCoords(null);
          return;
        }

        const result = await geocodeAddressWithNaver(address);
        if (cancelled) return;
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
  }, [seedAddress, aptName]);

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
      const ranked = [...data.transport.items]
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .sort((a, b) => {
          const as = isSubwayPoi(a) ? 0 : 1;
          const bs = isSubwayPoi(b) ? 0 : 1;
          if (as !== bs) return as - bs;
          return a.distanceMeters - b.distanceMeters;
        })
        .slice(0, TRANSPORT_MARKER_LIMIT);
      return ranked.map((p) => ({
        id: p.id,
        position: { lat: p.lat, lng: p.lng },
        title: p.name,
        // Subway markers use TRANSIT (larger); bus uses OTHER.
        kind: (isSubwayPoi(p) ? "TRANSIT" : "OTHER") as NaverMapMarker["kind"],
        selected: selectedId === p.id,
      }));
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
  }, [lifeQuery.data, tab, coords, selectedId]);

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
      const ranked = [...data.transport.items].sort((a, b) => {
        const as = isSubwayPoi(a) ? 0 : 1;
        const bs = isSubwayPoi(b) ? 0 : 1;
        if (as !== bs) return as - bs;
        return a.distanceMeters - b.distanceMeters;
      });
      const items = expanded
        ? ranked
        : ranked.slice(0, TRANSPORT_LIST_LIMIT);
      return (
        <ul className="space-y-1.5">
          {items.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={`flex w-full items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition ${selectedRowClass(selectedId === p.id)}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-800">
                    {p.name}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-slate-500">
                    {isSubwayPoi(p) ? p.subcategory || "지하철" : "버스"}
                    {" · "}
                    {formatMeters(p.distanceMeters)}
                    {" · 직선거리"}
                  </span>
                </span>
                <span className="shrink-0 text-right text-[11px] tabular-nums text-slate-500">
                  <span className="block">{formatMeters(p.distanceMeters)}</span>
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
                onClick={() => setSelectedId(p.id)}
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
              onClick={() => setSelectedId(s.id)}
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
      return Math.max(0, data.transport.items.length - TRANSPORT_LIST_LIMIT);
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
            위치: 단지 주소 기반 NAVER Geocoding
            <br />
            교통: 공식 지하철 CSV · 공공데이터포털 버스정류소 · 직선거리
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
        className="mt-3 flex flex-wrap gap-1.5"
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
          {/* Full-width map — transport hero */}
          <div className="relative -mx-4 overflow-hidden bg-slate-50/40 sm:-mx-5 sm:rounded-none">
            {coords && geocodeStatus === "ready" ? (
              <NaverMap
                center={mapCenter ?? coords}
                zoom={15}
                markers={markers}
                selectedId={selectedId}
                onMarkerClick={onMarkerClick}
                ariaLabel={`${aptName} 주변 교통 지도`}
                className="h-[320px] w-full sm:h-[340px] lg:h-[460px]"
              />
            ) : (
              <div className="flex h-[320px] items-center justify-center px-4 text-center text-sm text-slate-500 sm:h-[340px] lg:h-[460px]">
                {geocodeStatus === "loading" || geocodeStatus === "idle"
                  ? "지도를 준비하는 중…"
                  : geocodeReason || "위치 정보를 확인 중입니다"}
              </div>
            )}
          </div>

          <div className="min-w-0">
            {lifeQuery.data?.transport.status === "READY" &&
            lifeQuery.data.transport.items.length > 0 ? (
              <TransportSummary items={lifeQuery.data.transport.items} />
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
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:items-start">
          <div className="min-w-0 overflow-hidden rounded-xl bg-slate-50/40">
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

function TransportSummary({ items }: { items: PoiItem[] }) {
  const ranked = [...items].sort((a, b) => {
    const as = isSubwayPoi(a) ? 0 : 1;
    const bs = isSubwayPoi(b) ? 0 : 1;
    if (as !== bs) return as - bs;
    return a.distanceMeters - b.distanceMeters;
  });
  const nearestSubway = ranked.find(isSubwayPoi) ?? null;
  const buses = ranked.filter((p) => !isSubwayPoi(p));
  const busesWithin500 = buses.filter((p) => p.distanceMeters <= 500);
  const lineLabel =
    nearestSubway &&
    nearestSubway.subcategory &&
    /호선/.test(nearestSubway.subcategory)
      ? nearestSubway.subcategory
      : null;

  if (!nearestSubway && buses.length === 0) return null;

  return (
    <div className="mb-3 space-y-2 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-3">
      {nearestSubway ? (
        <div>
          <p className="text-[11px] font-medium text-slate-500">
            가장 가까운 지하철
          </p>
          <p className="mt-0.5 text-sm font-medium text-slate-800">
            {nearestSubway.name}
            {lineLabel ? (
              <span className="font-normal text-slate-500">
                {" · "}
                {lineLabel}
              </span>
            ) : null}
            <span className="font-normal text-slate-500">
              {" · "}
              {formatMeters(nearestSubway.distanceMeters)}
            </span>
          </p>
        </div>
      ) : null}
      {busesWithin500.length > 0 ? (
        <div>
          <p className="text-[11px] font-medium text-slate-500">
            500m 이내 버스정류장
          </p>
          <p className="mt-0.5 text-sm font-medium text-slate-800">
            {busesWithin500.length}개
          </p>
        </div>
      ) : buses.length > 0 ? (
        <div>
          <p className="text-[11px] font-medium text-slate-500">버스정류장</p>
          <p className="mt-0.5 text-sm font-medium text-slate-800">
            {buses[0].name}
            <span className="font-normal text-slate-500">
              {" · "}
              {formatMeters(buses[0].distanceMeters)}
            </span>
          </p>
        </div>
      ) : null}
      <p className="text-[10px] text-slate-400">거리는 직선거리입니다.</p>
    </div>
  );
}
