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
import { usePathname, useRouter } from "next/navigation";
import {
  NaverMap,
  type NaverMapMarker,
  type LivingMarkerCategory,
} from "@/components/map/NaverMap";
import {
  LabCard,
  LabState,
  labSecondaryTabClass,
  labSegmentedClass,
} from "@/components/ui/lab";
import { InfoTip } from "@/components/ui/InfoTip";
import type { LatLng } from "@/lib/nearby-map/geo";
import {
  resolveComplexMapAnchor,
  subwayLineColor,
  type ComplexMapAnchorResult,
} from "@/lib/nearby-map/complex-map-anchor";
import {
  Bus,
  ChevronRight,
  Coffee,
  Hospital,
  Pill,
  ShoppingCart,
  Store,
  Trees,
  UtensilsCrossed,
} from "lucide-react";
import {
  loadNearbySchoolsForMap,
  type NearbySchoolsClientResult,
} from "@/lib/complex-detail/nearby-schools-client";
import {
  SCHOOL_LEVEL_BADGE,
  type SchoolLevelCode,
} from "@/lib/complex-detail/nearby-schools";

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

/** Stable DOM id for living list rows (marker → list scroll). */
function livingRowDomId(poiId: string): string {
  return `living-row-${poiId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

type LivingOnlyCategory =
  | "HOSPITAL"
  | "PHARMACY"
  | "MART"
  | "CONVENIENCE"
  | "PARK";

/** Product chip order — 병원 → 약국 → 마트 → 편의점 → 공원 */
const LIVING_CHIP_ORDER: LivingOnlyCategory[] = [
  "HOSPITAL",
  "PHARMACY",
  "MART",
  "CONVENIENCE",
  "PARK",
];

const LIVING_CHIP_LABEL: Record<LivingOnlyCategory, string> = {
  HOSPITAL: "병원",
  PHARMACY: "약국",
  MART: "마트",
  CONVENIENCE: "편의점",
  PARK: "공원",
};

const LIVING_DEFAULT_CATEGORY: LivingOnlyCategory = "HOSPITAL";

/** Contextual list subtitle — not a radius census count. */
const LIVING_LIST_SUBTITLE = "가까운 순 · 주요 시설";

type CommerceMarkerCategory = "MART" | "CONVENIENCE" | "CAFE" | "RESTAURANT";

const COMMERCE_SECTION_ORDER: CommerceMarkerCategory[] = [
  "MART",
  "CONVENIENCE",
  "CAFE",
  "RESTAURANT",
];

const COMMERCE_SECTION_LABEL: Record<CommerceMarkerCategory, string> = {
  MART: "대형마트",
  CONVENIENCE: "편의점",
  CAFE: "카페",
  RESTAURANT: "음식점",
};

type LivingPlaceDto = {
  id: string;
  name: string;
  category: LivingMarkerCategory;
  sourceCategory: string | null;
  address: string | null;
  roadAddress: string | null;
  lat: number;
  lng: number;
  distanceM: number;
  source: "NAVER_LOCAL";
  medicalType?: "GENERAL_MEDICAL" | "GENERAL_HOSPITAL";
};

type LivingCategoryDto = {
  category: LivingMarkerCategory;
  label: string;
  primaryQuery: string;
  fallbackQuery: string | null;
  usedFallback: boolean;
  apiCalls: number;
  places: LivingPlaceDto[];
  error?: string;
};

type NearbyLivingResponse = {
  status: "READY" | "HOLD" | "EMPTY" | "ERROR";
  reason: string | null;
  configured?: boolean;
  requiredEnv?: string[];
  apiCallCount?: number;
  duplicatesRemoved?: number;
  overRadiusRemoved?: number;
  categories: LivingCategoryDto[];
  places: LivingPlaceDto[];
};

type CommercePlaceDto = {
  id: string;
  name: string;
  category: CommerceMarkerCategory;
  sourceCategory: string | null;
  address: string | null;
  roadAddress: string | null;
  lat: number | null;
  lng: number | null;
  distanceM: number | null;
  source: "NAVER_LOCAL";
};

type CommerceCategoryDto = {
  category: CommerceMarkerCategory;
  label: string;
  primaryQuery: string;
  fallbackQuery: string | null;
  usedFallback: boolean;
  apiCalls: number;
  places: CommercePlaceDto[];
  error?: string;
};

type NearbyCommerceResponse = {
  status: "READY" | "HOLD" | "EMPTY" | "ERROR";
  reason: string | null;
  configured?: boolean;
  requiredEnv?: string[];
  apiCallCount?: number;
  duplicatesRemoved?: number;
  overRadiusRemoved?: number;
  categories: CommerceCategoryDto[];
  places: CommercePlaceDto[];
};


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


async function fetchNearbyLiving(
  aptName: string,
  coords: LatLng,
  identity?: {
    sigungu?: string | null;
    legalDongName?: string | null;
  } | null,
): Promise<NearbyLivingResponse> {
  const qs = new URLSearchParams({
    aptName,
    lat: String(coords.lat),
    lng: String(coords.lng),
  });
  if (identity?.sigungu) qs.set("sigungu", identity.sigungu);
  if (identity?.legalDongName) qs.set("legalDong", identity.legalDongName);
  const res = await fetch(`/api/complex-nearby-living?${qs}`);
  if (!res.ok) {
    throw new Error("주변 정보를 불러오지 못했어요");
  }
  return res.json();
}

async function fetchNearbyCommerce(
  aptName: string,
  coords: LatLng,
  identity?: {
    sigungu?: string | null;
    legalDongName?: string | null;
  } | null,
): Promise<NearbyCommerceResponse> {
  const qs = new URLSearchParams({
    aptName,
    lat: String(coords.lat),
    lng: String(coords.lng),
  });
  if (identity?.sigungu) qs.set("sigungu", identity.sigungu);
  if (identity?.legalDongName) qs.set("legalDong", identity.legalDongName);
  const res = await fetch(`/api/complex-nearby-commerce?${qs}`);
  if (!res.ok) {
    throw new Error("주변 정보를 불러오지 못했어요");
  }
  return res.json();
}

function LivingCategoryIcon({
  category,
  className = "h-2.5 w-2.5",
}: {
  category: LivingMarkerCategory;
  className?: string;
}) {
  switch (category) {
    case "MART":
      return <ShoppingCart className={className} aria-hidden />;
    case "HOSPITAL":
      return <Hospital className={className} aria-hidden />;
    case "PHARMACY":
      return <Pill className={className} aria-hidden />;
    case "CONVENIENCE":
      return <Store className={className} aria-hidden />;
    case "PARK":
      return <Trees className={className} aria-hidden />;
    case "CAFE":
      return <Coffee className={className} aria-hidden />;
    case "RESTAURANT":
      return <UtensilsCrossed className={className} aria-hidden />;
    default:
      return <Store className={className} aria-hidden />;
  }
}

function formatDistanceOnly(distanceM: number | null | undefined): string {
  if (distanceM == null || !Number.isFinite(distanceM) || distanceM < 0) {
    return "거리 정보 없음";
  }
  return formatMeters(distanceM);
}

function livingPlaceAddress(p: {
  roadAddress: string | null;
  address: string | null;
}): string | null {
  const road = p.roadAddress?.trim() || "";
  const addr = p.address?.trim() || "";
  let raw = road || addr;
  if (!raw) return null;
  // Drop city-level prefix (서울특별시 / OO광역시 / OO시) — keep 구·동·도로명.
  raw = raw.replace(
    /^[가-힣0-9]+(?:특별시|광역시|특별자치시)\s+/,
    "",
  );
  raw = raw.replace(/^[가-힣0-9]+시\s+/, "");
  raw = raw.trim();
  if (!raw) return null;
  // Keep secondary line short on mobile.
  return raw.length > 42 ? `${raw.slice(0, 40)}…` : raw;
}

function livingChipClass(active: boolean): string {
  return [
    "inline-flex shrink-0 items-center justify-center whitespace-nowrap",
    "h-7 rounded-full px-2.5 text-[12px] font-semibold leading-none",
    "border transition-colors",
    active
      ? "border-[color-mix(in_srgb,var(--lab-teal-600)_35%,transparent)] bg-[var(--lab-teal-50)] text-[var(--lab-teal-700)]"
      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
  ].join(" ");
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
  initialTab,
}: {
  aptName: string;
  identity?: {
    roadAddress?: string | null;
    sido?: string | null;
    sigungu?: string | null;
    legalDongName?: string | null;
    jibun?: string | null;
  } | null;
  /** Restore tab when returning from school detail (?nearbyTab=school). */
  initialTab?: NearbyLifeCategory;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<NearbyLifeCategory>(
    initialTab === "school" ||
      initialTab === "transport" ||
      initialTab === "living" ||
      initialTab === "commerce"
      ? initialTab
      : "transport",
  );
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
  const [livingCategory, setLivingCategory] = useState<LivingOnlyCategory>(
    LIVING_DEFAULT_CATEGORY,
  );
  /** After marker click, scroll to this living row once it is in the DOM. */
  const [pendingListScrollId, setPendingListScrollId] = useState<string | null>(
    null,
  );
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

  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduceMotion(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  const livingQuery = useQuery({
    queryKey: [
      "complex-nearby-living",
      aptName,
      coords?.lat ?? null,
      coords?.lng ?? null,
      identity?.sigungu ?? null,
      identity?.legalDongName ?? null,
    ],
    queryFn: () => fetchNearbyLiving(aptName, coords!, identity),
    enabled: tab === "living" && !!coords && geocodeStatus === "ready",
    staleTime: 24 * 60 * 60 * 1000,
    retry: 0,
  });

  const commerceQuery = useQuery({
    queryKey: [
      "complex-nearby-commerce",
      aptName,
      coords?.lat ?? null,
      coords?.lng ?? null,
      identity?.sigungu ?? null,
      identity?.legalDongName ?? null,
    ],
    queryFn: () => fetchNearbyCommerce(aptName, coords!, identity),
    enabled: tab === "commerce" && !!coords && geocodeStatus === "ready",
    staleTime: 24 * 60 * 60 * 1000,
    retry: 0,
  });

  const schoolQuery = useQuery({
    queryKey: [
      "complex-nearby-schools",
      aptName,
      coords?.lat ?? null,
      coords?.lng ?? null,
    ],
    queryFn: () =>
      loadNearbySchoolsForMap({
        aptName,
        center: coords!,
      }),
    enabled: tab === "school" && !!coords && geocodeStatus === "ready",
    staleTime: 24 * 60 * 60 * 1000,
    retry: 0,
  });



  const selectTab = useCallback((next: NearbyLifeCategory) => {
    setTab(next);
    setSelectedId(null);
    setExpanded(false);
    setPendingListScrollId(null);
    if (next === "living") {
      setLivingCategory(LIVING_DEFAULT_CATEGORY);
    }
  }, []);

  const selectLivingCategory = useCallback((next: LivingOnlyCategory) => {
    setLivingCategory(next);
    setSelectedId(null);
    setExpanded(false);
    setPendingListScrollId(null);
  }, []);

  /** Current living-chip valid POIs (all radius/semantic passers — not list-capped). */
  const livingValidPlaces = useMemo(() => {
    const living = livingQuery.data;
    if (!living || living.status !== "READY") return [] as LivingPlaceDto[];
    const fromApi = living.categories?.find(
      (c) => c.category === livingCategory,
    );
    return (fromApi?.places ??
      living.places.filter((p) => p.category === livingCategory))
      .slice()
      .sort((a, b) => a.distanceM - b.distanceM);
  }, [livingQuery.data, livingCategory]);

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
    if (!coords) return [];
    const data = lifeQuery.data;
    if (tab === "transport") {
      if (!data) return [];
      const withCoords = data.transport.items.filter(
        (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
      );
      const subways = withCoords
        .filter(isSubwayPoi)
        .sort((a, b) => a.distanceMeters - b.distanceMeters);
      const buses = withCoords
        .filter((p) => !isSubwayPoi(p))
        .sort((a, b) => a.distanceMeters - b.distanceMeters);
      // Subway + bus: always show all transport POIs on the map.
      // List “더보기” only limits the bus list rows, not map markers.
      return [
        ...subways.map((p) => {
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
        ...buses.map((p) => ({
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
      const places = livingQuery.data?.places ?? [];
      return places
        .filter(
          (p) =>
            p.category === livingCategory &&
            Number.isFinite(p.lat) &&
            Number.isFinite(p.lng),
        )
        .map((p) => ({
          id: p.id,
          position: { lat: p.lat, lng: p.lng },
          title: p.name,
          kind: "LIVING" as const,
          livingCategory: p.category,
          hospitalEmphasis: p.medicalType === "GENERAL_HOSPITAL",
          selected: selectedId === p.id,
        }));
    }
    if (tab === "commerce") {
      const places = commerceQuery.data?.places ?? [];
      return places
        .filter(
          (p) =>
            p.lat != null &&
            p.lng != null &&
            Number.isFinite(p.lat) &&
            Number.isFinite(p.lng),
        )
        .map((p) => ({
          id: p.id,
          position: { lat: p.lat as number, lng: p.lng as number },
          title: p.name,
          kind: "LIVING" as const,
          livingCategory: p.category as LivingMarkerCategory,
          selected: selectedId === p.id,
        }));
    }
    if (tab === "school") {
      const places = schoolQuery.data?.places ?? [];
      return places
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
        .map((s) => ({
          id: s.id,
          position: { lat: s.lat, lng: s.lng },
          title: s.name,
          label: s.name,
          kind: "SCHOOL" as const,
          schoolLevel: s.schoolLevel,
          selected: selectedId === s.id,
        }));
    }
    return [];
  }, [
    lifeQuery.data,
    livingQuery.data,
    commerceQuery.data,
    schoolQuery.data,
    tab,
    livingCategory,
    coords,
    selectedId,
  ]);

  const markers = useMemo(() => {
    const list = [...tabMarkers];
    if (complexMarker) list.unshift(complexMarker);
    return list;
  }, [tabMarkers, complexMarker]);

  const livingFitToken = useMemo(() => {
    if (tab !== "living" || !coords) return null;
    const ids = tabMarkers
      .map((m) => m.id)
      .slice()
      .sort()
      .join("|");
    return `living:${livingCategory}:${ids}`;
  }, [tab, coords, livingCategory, tabMarkers]);

  const onMarkerClick = useCallback(
    (id: string) => {
      setSelectedId(id);
      if (tab !== "living" || id === "complex") {
        setPendingListScrollId(null);
        return;
      }
      const idx = livingValidPlaces.findIndex((p) => p.id === id);
      if (idx < 0) {
        setPendingListScrollId(null);
        return;
      }
      if (idx >= LIST_LIMIT && !expanded) {
        setExpanded(true);
      }
      setPendingListScrollId(id);
    },
    [tab, livingValidPlaces, expanded],
  );

  // Marker → list: scroll after expand renders the target row.
  useEffect(() => {
    if (!pendingListScrollId || tab !== "living") return;
    const el = document.getElementById(livingRowDomId(pendingListScrollId));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setPendingListScrollId(null);
  }, [pendingListScrollId, expanded, livingValidPlaces, tab]);

  const mapCenter = useMemo(() => {
    // Living category overview stays apartment-centered; list click still pans via NaverMap.
    if (tab === "living" && !selectedId) return coords;
    if (selectedId && selectedId !== "complex") {
      const m = tabMarkers.find((x) => x.id === selectedId);
      if (m) return m.position;
    }
    return coords;
  }, [selectedId, tabMarkers, coords, tab]);

  const summaryText = useMemo(() => {
    const data = lifeQuery.data;
    if (!data) return null;
    if (tab === "transport" && data.transport.status === "READY") {
      return `교통 · ${data.transport.items.length}곳 · 직선거리`;
    }
    if (tab === "school" && schoolQuery.data?.status === "READY") {
      return `인근 학교 · ${schoolQuery.data.places.length}곳 · 직선거리`;
    }
    return null;
  }, [lifeQuery.data, schoolQuery.data, tab]);

  const listContent = (() => {
    if (geocodeStatus === "loading" || geocodeStatus === "idle") {
      return <EmptyBlock>위치 정보를 확인하는 중…</EmptyBlock>;
    }
    if (geocodeStatus === "error" || !coords) {
      return (
        <EmptyBlock>{geocodeReason || "위치 정보를 확인 중입니다"}</EmptyBlock>
      );
    }
    if (tab !== "living" && tab !== "commerce" && tab !== "school") {
      if (lifeQuery.isLoading) {
        return <EmptyBlock>주변 생활 정보를 불러오는 중…</EmptyBlock>;
      }
      if (lifeQuery.isError || !lifeQuery.data) {
        return <EmptyBlock>주변 정보를 불러오지 못했어요</EmptyBlock>;
      }
    }


    const data = lifeQuery.data;

    if (tab === "commerce") {
      if (commerceQuery.isLoading) {
        return <EmptyBlock>주변 상권 정보를 불러오는 중…</EmptyBlock>;
      }
      if (commerceQuery.isError) {
        return <EmptyBlock>주변 정보를 불러오지 못했어요</EmptyBlock>;
      }
      const commerce = commerceQuery.data;
      if (!commerce || commerce.status === "HOLD") {
        return (
          <EmptyBlock>
            {commerce?.reason || "주변 정보를 찾지 못했어요"}
          </EmptyBlock>
        );
      }
      if (commerce.status === "ERROR") {
        return (
          <EmptyBlock>
            {commerce.reason || "주변 정보를 불러오지 못했어요"}
          </EmptyBlock>
        );
      }
      if (commerce.status === "EMPTY") {
        return (
          <EmptyBlock>
            {commerce.reason || "주변 정보를 찾지 못했어요"}
          </EmptyBlock>
        );
      }
      const sections = COMMERCE_SECTION_ORDER.map((cat) => {
        const fromApi = commerce.categories?.find((c) => c.category === cat);
        const places = (
          fromApi?.places ?? commerce.places.filter((p) => p.category === cat)
        )
          .slice()
          .sort((a, b) => {
            if (a.distanceM == null && b.distanceM == null) return 0;
            if (a.distanceM == null) return 1;
            if (b.distanceM == null) return -1;
            return a.distanceM - b.distanceM;
          });
        return { cat, places };
      }).filter((s) => s.places.length > 0);

      if (!sections.length) {
        return <EmptyBlock>주변 정보를 찾지 못했어요</EmptyBlock>;
      }

      return (
        <div className="space-y-4">
          {sections.map(({ cat, places }) => (
            <div key={cat}>
              <p className="mb-1.5 text-[17px] font-semibold text-slate-800">
                {COMMERCE_SECTION_LABEL[cat]}
              </p>
              <ul className="space-y-1">
                {places.map((p) => {
                  const hasCoords =
                    p.lat != null &&
                    p.lng != null &&
                    Number.isFinite(p.lat) &&
                    Number.isFinite(p.lng);
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (hasCoords) selectFromList(p.id);
                        }}
                        disabled={!hasCoords}
                        aria-label={
                          hasCoords
                            ? `${p.name} 지도에서 보기`
                            : `${p.name} (지도 위치 없음)`
                        }
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                          hasCoords
                            ? selectedRowClass(selectedId === p.id)
                            : "cursor-default opacity-90"
                        }`}
                      >
                        <span className="mt-0.5 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-slate-300 bg-white text-[#1e3a5f]">
                          <LivingCategoryIcon category={cat} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-slate-800">
                            {p.name}
                          </span>
                          <span className="mt-0.5 block text-[10px] text-slate-500">
                            {formatDistanceOnly(p.distanceM)}
                          </span>
                        </span>
                        {hasCoords ? (
                          <ChevronRight
                            className="h-4 w-4 shrink-0 text-slate-400"
                            aria-hidden
                          />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      );
    }

    if (tab === "transport") {
      if (!data || data.transport.status !== "READY" || !data.transport.items.length) {
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
              <p className="mb-1.5 text-[17px] font-semibold text-slate-800">
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
                                className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-black/25 px-1 text-[9px] font-bold text-white shadow-sm"
                                style={{
                                  backgroundColor: subwayLineColor(line),
                                }}
                              >
                                {line}
                              </span>
                            ))
                          ) : (
                            <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-black/25 bg-amber-700 px-1 text-[9px] font-bold text-white shadow-sm">
                              역
                            </span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-slate-800">
                            {p.name}
                          </span>
                          <span className="mt-0.5 block text-[10px] text-slate-500">
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
              <p className="mb-1.5 text-[17px] font-semibold text-slate-800">
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
                        <span className="mt-0.5 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-slate-300 bg-white text-[#1e3a5f]">
                          <Bus className="h-2.5 w-2.5" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="min-w-0 truncate text-[13px] font-medium text-slate-800">
                              {p.name}
                            </span>
                            <span className="shrink-0 text-[10px] text-slate-500">
                              {metaText}
                            </span>
                          </span>
                          {routes.length > 0 ? (
                            <span className="mt-1.5 flex flex-wrap items-center gap-1">
                              {routes.map((route) => (
                                <span
                                  key={`${p.id}-${route}`}
                                  className="inline-flex h-[18px] items-center rounded border border-slate-200 bg-slate-50 px-1.5 text-[9px] font-semibold text-slate-700"
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
      if (livingQuery.isLoading) {
        return <LabState tone="loading" />;
      }
      if (livingQuery.isError) {
        return <EmptyBlock>주변 정보를 불러오지 못했어요</EmptyBlock>;
      }
      const living = livingQuery.data;
      if (!living || living.status === "HOLD") {
        return (
          <EmptyBlock>
            {living?.reason || "주변 정보를 찾지 못했어요"}
          </EmptyBlock>
        );
      }
      if (living.status === "ERROR") {
        return <EmptyBlock>주변 정보를 불러오지 못했어요</EmptyBlock>;
      }
      if (living.status === "EMPTY") {
        return (
          <EmptyBlock>
            주변 정보를 찾지 못했어요
            <br />
            <span className="text-[12px] text-slate-500">
              주변에 표시할 주요 시설이 없어요
            </span>
          </EmptyBlock>
        );
      }

      const fromApi = living.categories?.find(
        (c) => c.category === livingCategory,
      );
      const places = (
        fromApi?.places ??
        living.places.filter((p) => p.category === livingCategory)
      )
        .slice()
        .sort((a, b) => a.distanceM - b.distanceM);

      const label = LIVING_CHIP_LABEL[livingCategory];
      const visiblePlaces = expanded
        ? places
        : places.slice(0, LIST_LIMIT);

      if (!places.length) {
        return (
          <div>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <p className="text-[15px] font-semibold text-slate-800">{label}</p>
              <p className="text-[11px] text-slate-500">{LIVING_LIST_SUBTITLE}</p>
            </div>
            <EmptyBlock>
              주변 정보를 찾지 못했어요
              <br />
              <span className="text-[12px] text-slate-500">
                주변에 표시할 주요 시설이 없어요
              </span>
            </EmptyBlock>
            <p className="mt-2 text-[11px] text-slate-400">네이버 지역검색</p>
          </div>
        );
      }

      return (
        <div>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <p className="text-[15px] font-semibold text-slate-800">{label}</p>
            <p className="shrink-0 text-[11px] text-slate-500">
              {LIVING_LIST_SUBTITLE}
            </p>
          </div>
          <ul className="space-y-1">
            {visiblePlaces.map((p) => {
              const address = livingPlaceAddress(p);
              const hasCoords =
                Number.isFinite(p.lat) && Number.isFinite(p.lng);
              return (
                <li key={p.id} id={livingRowDomId(p.id)}>
                  <button
                    type="button"
                    onClick={() => {
                      if (hasCoords) selectFromList(p.id);
                    }}
                    disabled={!hasCoords}
                    aria-label={
                      hasCoords
                        ? `${p.name} 지도에서 보기`
                        : `${p.name} (지도 위치 없음)`
                    }
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                      hasCoords
                        ? selectedRowClass(selectedId === p.id)
                        : "cursor-default opacity-90"
                    }`}
                  >
                    <span className="mt-0.5 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-slate-300 bg-white text-[#1e3a5f]">
                      <LivingCategoryIcon category={livingCategory} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 truncate text-[13px] font-medium text-slate-800">
                          {p.name}
                        </span>
                        {p.medicalType === "GENERAL_HOSPITAL" ? (
                          <span className="inline-flex shrink-0 items-center rounded border border-[color-mix(in_srgb,var(--lab-teal-600)_28%,transparent)] bg-[var(--lab-teal-50)] px-1 py-px text-[9px] font-semibold leading-none text-[var(--lab-teal-700)]">
                            종합병원
                          </span>
                        ) : null}
                      </span>
                      {address ? (
                        <span className="mt-0.5 block truncate text-[10px] text-slate-500">
                          {address}
                        </span>
                      ) : (
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          {formatDistanceOnly(p.distanceM)}
                          {" · 직선거리"}
                        </span>
                      )}
                    </span>
                    {address ? (
                      <span className="shrink-0 text-[10px] text-slate-500">
                        {formatDistanceOnly(p.distanceM)}
                      </span>
                    ) : null}
                    {hasCoords ? (
                      <ChevronRight
                        className="h-4 w-4 shrink-0 text-slate-400"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[11px] text-slate-400">네이버 지역검색</p>
        </div>
      );
    }

    if (tab === "school") {
      if (schoolQuery.isLoading) {
        return <EmptyBlock>인근 학교를 불러오는 중…</EmptyBlock>;
      }
      if (schoolQuery.isError) {
        return (
          <EmptyBlock>현재 확인 가능한 인근 학교 정보가 없습니다.</EmptyBlock>
        );
      }
      const school = schoolQuery.data;
      if (!school || school.status === "PILOT_ONLY") {
        return (
          <EmptyBlock>
            {school?.reason || "인근 학교 실데이터는 준비 중입니다."}
          </EmptyBlock>
        );
      }
      if (school.status === "ERROR") {
        return (
          <EmptyBlock>
            {school.reason || "인근 학교 정보를 불러오지 못했습니다."}
          </EmptyBlock>
        );
      }
      if (school.status !== "READY" || !school.categories.length) {
        return (
          <EmptyBlock>
            {school.reason || "현재 확인 가능한 인근 학교 정보가 없습니다."}
          </EmptyBlock>
        );
      }

      return (
        <div className="space-y-4">
          {school.categories.map((section) => (
            <div key={section.level}>
              <p className="mb-1.5 text-[17px] font-semibold text-slate-800">
                {section.label}
              </p>
              <ul className="space-y-1">
                {section.places.map((s) => {
                  const metaParts = [
                    s.establishment,
                    `${formatMeters(s.distanceM)} · 직선거리`,
                  ].filter(Boolean);
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => {
                          const code = s.schoolCode?.trim();
                          if (!code) {
                            selectFromList(s.id);
                            return;
                          }
                          // Clean apt URL only — nearbyTab/hash are added on back.
                          let from = pathname;
                          if (typeof window !== "undefined") {
                            const params = new URLSearchParams(
                              window.location.search,
                            );
                            params.delete("nearbyTab");
                            const q = params.toString();
                            from = `${pathname}${q ? `?${q}` : ""}`;
                          }
                          const qs = new URLSearchParams({
                            name: s.name,
                            from,
                            nearbyTab: "school",
                          });
                          router.push(`/school/${encodeURIComponent(code)}?${qs}`);
                        }}
                        aria-label={`${s.name} 상세 보기`}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${selectedRowClass(selectedId === s.id)}`}
                      >
                        <span className="mt-0.5 inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded border border-slate-300 bg-white px-0.5 text-[9px] font-bold text-[#1e3a5f]">
                          {SCHOOL_LEVEL_BADGE[s.schoolLevel as SchoolLevelCode]}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-slate-800">
                            {s.name}
                          </span>
                          <span className="mt-0.5 block text-[10px] text-slate-500">
                            {metaParts.join(" · ")}
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
          ))}
        </div>
      );
    }

    if (!data) {
      return <EmptyBlock>주변 정보를 불러오지 못했어요</EmptyBlock>;
    }

    return (
      <EmptyBlock>주변 정보를 찾지 못했어요</EmptyBlock>
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
      return Math.max(0, livingValidPlaces.length - LIST_LIMIT);
    }
    if (tab === "commerce") {
      return 0;
    }
    if (tab === "school") {
      return 0;
    }
    return 0;
  })();

  return (
    <LabCard
      className={`p-4 sm:p-5 ${tab === "living" ? "overflow-visible" : ""}`}
    >
      <div className="lab-section-heading mb-px flex-wrap items-center gap-x-2 gap-y-2">
        <div className="min-w-0 shrink">
          <h2 className="flex items-center">
            주변 생활
            <InfoTip aria-label="주변 생활 출처 안내" className="ml-1.5 text-[13px]">
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
                학교: NEIS schoolInfo (인근 학교 · 배정/통학구역 아님)
                <br />
                생활시설·상권: NAVER 지역 검색
                <br />
                지역 검색 결과 기준이며 전체 시설 수를 의미하지 않습니다.
              </p>
            </InfoTip>
          </h2>
        </div>
        <div
          className={labSegmentedClass("ml-auto shrink-0")}
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
      </div>

      <div className="mt-3 space-y-3">
        {tab === "living" ? (
          <div
            className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            role="tablist"
            aria-label="생활 시설 종류"
          >
            {LIVING_CHIP_ORDER.map((cat) => (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={livingCategory === cat}
                onClick={() => selectLivingCategory(cat)}
                className={livingChipClass(livingCategory === cat)}
              >
                {LIVING_CHIP_LABEL[cat]}
              </button>
            ))}
          </div>
        ) : null}

        {/* One NAVER map instance — height animates; never remount on tab change. */}
        <div
          ref={mapSectionRef}
          className={
            tab === "living"
              ? // Full-bleed width; living map slightly taller than other tabs.
                "relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen overflow-hidden bg-slate-50/40"
              : "relative -mx-4 overflow-hidden bg-slate-50/40 sm:-mx-5 sm:rounded-none"
          }
        >
          {coords && geocodeStatus === "ready" ? (
            <div
              className={
                tab === "living"
                  ? "h-[348px] w-full sm:h-[392px] lg:h-[440px]"
                  : tab === "commerce"
                    ? "h-[324px] w-full sm:h-[350px] lg:h-[400px]"
                    : tab === "school"
                      ? "h-[310px] w-full sm:h-[340px] lg:h-[380px]"
                      : "h-[240px] w-full sm:h-[280px] lg:h-[330px]"
              }
              style={{
                transition: reduceMotion ? undefined : "height 280ms ease-out",
              }}
            >
              <NaverMap
                center={mapCenter ?? coords}
                zoom={15}
                markers={markers}
                selectedId={selectedId}
                onMarkerClick={onMarkerClick}
                fitBoundsToken={livingFitToken}
                fitAnchor={tab === "living" ? coords : null}
                ariaLabel={
                  tab === "living"
                    ? `${aptName} 주변 생활시설 지도`
                    : tab === "commerce"
                      ? `${aptName} 주변 상권 지도`
                      : tab === "school"
                        ? `${aptName} 인근 학교 지도`
                        : tab === "transport"
                          ? `${aptName} 주변 교통 지도`
                          : `${aptName} 주변 생활 지도`
                }
                className="h-full w-full rounded-none"
              />
            </div>
          ) : (
            <div
              className={`flex items-center justify-center px-4 text-center text-sm text-slate-500 ${
                tab === "living"
                  ? "h-[348px] sm:h-[392px] lg:h-[440px]"
                  : tab === "commerce"
                    ? "h-[324px] sm:h-[350px] lg:h-[400px]"
                    : tab === "school"
                      ? "h-[310px] sm:h-[340px] lg:h-[380px]"
                      : "h-[240px] sm:h-[280px] lg:h-[330px]"
              }`}
            >
              {geocodeStatus === "loading" || geocodeStatus === "idle"
                ? "지도를 준비하는 중…"
                : geocodeReason || "위치 정보를 확인 중입니다"}
            </div>
          )}
        </div>

        <div className="min-w-0">
          {listContent}
          {moreCount > 0 && (tab === "transport" || tab === "living") ? (
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="text-[13px] font-medium text-[var(--lab-teal-700)] hover:underline"
              >
                {tab === "transport"
                  ? `버스 정류장 더보기 · ${moreCount}곳`
                  : `더보기 · ${moreCount}곳`}
              </button>
            </div>
          ) : null}
        </div>
      </div>
</LabCard>
  );
}
