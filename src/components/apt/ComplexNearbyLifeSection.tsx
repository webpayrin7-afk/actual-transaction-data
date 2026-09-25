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
import { LabState } from "@/components/ui/lab";
import { LabSection } from "@/components/ui/LabSection";
import { LabMoreButton } from "@/components/ui/LabMoreButton";
import { LabTabs } from "@/components/ui/LabTabs";
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
import type { SchoolLevel } from "@/lib/complex-detail/neis";
import { SchoolDistrictBlock } from "@/components/apt/SchoolDistrictBlock";
import { AttendanceZoneBlock } from "@/components/apt/AttendanceZoneBlock";
import {
  getCommerceSnapshot,
  type CommerceSnapshot,
} from "@/lib/complex-detail/commerce-snapshot";
import { ComplexCommerceStats } from "@/components/apt/ComplexCommerceSection";
import { ComplexLivingCensus } from "@/components/apt/ComplexLivingCensus";

export type NearbyLifeCategory = "commerce" | "living" | "transport" | "school";

type SchoolLevelTab = SchoolLevel;

const SCHOOL_LEVEL_TABS: Array<{ id: SchoolLevelTab; label: string }> = [
  { id: "elementary", label: "초등학교" },
  { id: "middle", label: "중학교" },
  { id: "high", label: "고등학교" },
];

const NEARBY_LEVEL_HEADING: Record<SchoolLevelTab, string> = {
  elementary: "주변 초등학교",
  middle: "주변 중학교",
  high: "주변 고등학교",
};

function parseSchoolLevelTab(raw: string | null | undefined): SchoolLevelTab | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "elementary" || v === "middle" || v === "high") return v;
  return null;
}

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
  { id: "commerce", label: "상권" },
  { id: "living", label: "생활" },
  { id: "transport", label: "교통" },
  { id: "school", label: "학교" },
];

const LIST_LIMIT = 5;

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

function LivingDistanceSubtitle() {
  return (
    <span className="detail-meta inline-flex shrink-0 items-center">
      <span>{LIVING_LIST_SUBTITLE}</span>
      <InfoTip aria-label="생활 시설 거리 기준 안내" className="detail-meta">
        <p className="detail-body">
          표시된 거리는 아파트와 시설 간 직선거리입니다.
          <br />
          실제 도보·차량 이동거리는 다를 수 있습니다.
        </p>
      </InfoTip>
    </span>
  );
}

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

function EmptyBlock({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-3">
      <p className="detail-body">{children}</p>
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
  initialSchoolLevel,
  presetAnchor = null,
}: {
  aptName: string;
  identity?: {
    complexId?: string | null;
    roadAddress?: string | null;
    sido?: string | null;
    sigungu?: string | null;
    legalDongName?: string | null;
    jibun?: string | null;
  } | null;
  /** Restore tab when returning from school detail (?nearbyTab=school). */
  initialTab?: NearbyLifeCategory;
  /** Restore school-level sub-tab (?schoolLevel=high). */
  initialSchoolLevel?: string;
  /** NAVER geocoded center stored in complex_map_anchor — skips the in-browser geocode. */
  presetAnchor?: { lat: number; lng: number; matchedAddress: string | null } | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<NearbyLifeCategory>(
    initialTab === "school" ||
      initialTab === "transport" ||
      initialTab === "living" ||
      initialTab === "commerce"
      ? initialTab
      : "commerce",
  );
  const [schoolLevel, setSchoolLevel] = useState<SchoolLevelTab>(
    () => parseSchoolLevelTab(initialSchoolLevel) ?? "elementary",
  );
  const [resolvedCoords, setCoords] = useState<LatLng | null>(null);
  const [mapAnchor, setMapAnchor] = useState<ComplexMapAnchorResult | null>(
    null,
  );
  const [resolvedGeocodeStatus, setGeocodeStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [geocodeReason, setGeocodeReason] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [livingCategory, setLivingCategory] = useState<LivingOnlyCategory>(
    LIVING_DEFAULT_CATEGORY,
  );
  /** 잠실엘스 pilot fixture (static) — wins over the national DB snapshot. */
  const pilotCommerceSnapshot = useMemo(
    () =>
      getCommerceSnapshot({
        complexId: identity?.complexId,
        aptName,
      }),
    [identity?.complexId, aptName],
  );
  const commerceComplexId = identity?.complexId ?? null;
  /** National SEMAS snapshot (complex_commerce_snapshots). Fetched on the commerce tab only. */
  const nationalCommerceQuery = useQuery({
    queryKey: ["complex-commerce", commerceComplexId],
    queryFn: async (): Promise<CommerceSnapshot | null> => {
      const res = await fetch(
        `/api/complex-commerce?complex_id=${encodeURIComponent(commerceComplexId ?? "")}`,
      );
      if (!res.ok) throw new Error("complex-commerce");
      const json = (await res.json()) as
        | { status: "ok"; snapshot: CommerceSnapshot }
        | { status: string };
      return json.status === "ok" && "snapshot" in json ? json.snapshot : null;
    },
    enabled: !pilotCommerceSnapshot && !!commerceComplexId && tab === "commerce",
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });
  const commerceSnapshot: CommerceSnapshot | null =
    pilotCommerceSnapshot ?? nationalCommerceQuery.data ?? null;
  const commerceLoading =
    !pilotCommerceSnapshot && !!commerceComplexId && nationalCommerceQuery.isPending;
  // One-center contract for national snapshots: once the commerce point cloud
  // arrives, its origin (the stored complex center) is the map center so the
  // marker, 1km ring and points line up — same rule as the pilot below.
  const nationalCommercePoints = nationalCommerceQuery.data?.mapPoints ?? null;
  const nationalCommerceCenter = useMemo<LatLng | null>(
    () =>
      nationalCommercePoints
        ? {
            lat: nationalCommercePoints.originLat,
            lng: nationalCommercePoints.originLng,
          }
        : null,
    [nationalCommercePoints],
  );
  const coords = nationalCommerceCenter ?? resolvedCoords;
  const geocodeStatus = nationalCommerceCenter ? "ready" : resolvedGeocodeStatus;
  /** After marker click, scroll to this living row once it is in the DOM. */
  const pendingListScrollIdRef = useRef<string | null>(null);
  const mapSectionRef = useRef<HTMLDivElement | null>(null);

  const selectFromList = useCallback((id: string) => {
    setSelectedId(id);
    mapSectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, []);

  /** Same URL as school list rows — marker + list must stay in sync. */
  const openSchoolDetail = useCallback(
    (s: {
      schoolCode: string | null | undefined;
      name: string;
      level: string;
      address: string | null | undefined;
    }) => {
      const code = s.schoolCode?.trim();
      if (!code) return false;
      let from = pathname;
      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        params.delete("nearbyTab");
        params.delete("schoolLevel");
        const q = params.toString();
        from = `${pathname}${q ? `?${q}` : ""}`;
      }
      const qs = new URLSearchParams({
        name: s.name,
        from,
        nearbyTab: "school",
        schoolLevel,
        kind: s.level,
      });
      if (s.address?.trim()) {
        qs.set("address", s.address.trim());
      }
      router.push(`/school/${encodeURIComponent(code)}?${qs}`);
      return true;
    },
    [pathname, router, schoolLevel],
  );

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        setGeocodeStatus("loading");

        // Stored NAVER anchor (same geocoder, precomputed) — no network round-trips.
        // The 잠실엘스 commerce pilot origin still wins below via canonicalFromCommerce.
        if (presetAnchor && !pilotCommerceSnapshot?.mapPoints) {
          const coordinate = { lat: presetAnchor.lat, lng: presetAnchor.lng };
          setMapAnchor({
            ok: true,
            coordinate,
            anchorType: "NAVER_GEOCODE",
            addressUsed: presetAnchor.matchedAddress ?? "",
            matchedAddress: presetAnchor.matchedAddress ?? "",
            poiLookup: "HOLD",
            poiLookupReason: null,
          });
          setCoords(coordinate);
          setGeocodeStatus("ready");
          setGeocodeReason(null);
          return;
        }

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

        // C4 one-center contract: when commerce map points exist, their
        // origin is the canonical apartment center (product mapAnchor
        // snapshot). Marker, 1km ring, fit, and point cloud share it.
        const canonicalFromCommerce = pilotCommerceSnapshot?.mapPoints
          ? {
              lat: pilotCommerceSnapshot.mapPoints.originLat,
              lng: pilotCommerceSnapshot.mapPoints.originLng,
            }
          : null;

        if (canonicalFromCommerce) {
          setCoords(canonicalFromCommerce);
          setGeocodeStatus("ready");
          setGeocodeReason(null);
          return;
        }

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
  }, [identity, aptName, pilotCommerceSnapshot, presetAnchor]);



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

  const schoolQuery = useQuery({
    queryKey: [
      "complex-nearby-schools",
      aptName,
      identity?.complexId ?? null,
      coords?.lat ?? null,
      coords?.lng ?? null,
    ],
    queryFn: () =>
      loadNearbySchoolsForMap({
        aptName,
        center: coords!,
        complexId: identity?.complexId ?? null,
      }),
    enabled: tab === "school" && !!coords && geocodeStatus === "ready",
    staleTime: 24 * 60 * 60 * 1000,
    retry: 0,
  });



  const selectTab = useCallback((next: NearbyLifeCategory) => {
    setTab(next);
    setSelectedId(null);
    setExpanded(false);
    pendingListScrollIdRef.current = null;
    if (next === "living") {
      setLivingCategory(LIVING_DEFAULT_CATEGORY);
    }
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      if (next === "school") {
        u.searchParams.set("nearbyTab", "school");
        u.searchParams.set("schoolLevel", schoolLevel);
        window.history.replaceState(window.history.state, "", u.toString());
      } else if (u.searchParams.has("nearbyTab") || u.searchParams.has("schoolLevel")) {
        u.searchParams.delete("nearbyTab");
        u.searchParams.delete("schoolLevel");
        window.history.replaceState(window.history.state, "", u.toString());
      }
    }
  }, [schoolLevel]);

  const selectSchoolLevel = useCallback((next: SchoolLevelTab) => {
    setSchoolLevel(next);
    setSelectedId(null);
    setExpanded(false);
    pendingListScrollIdRef.current = null;
    // Sync URL without scroll so back-from-detail / share keep the level.
    if (typeof window !== "undefined" && tab === "school") {
      const u = new URL(window.location.href);
      u.searchParams.set("nearbyTab", "school");
      u.searchParams.set("schoolLevel", next);
      window.history.replaceState(window.history.state, "", u.toString());
    }
  }, [tab]);

  const selectLivingCategory = useCallback((next: LivingOnlyCategory) => {
    setLivingCategory(next);
    setSelectedId(null);
    setExpanded(false);
    pendingListScrollIdRef.current = null;
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
      return livingValidPlaces
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
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
      // Point-cloud canvas carries SEMAS P2; no NAVER POI markers.
      return [];
    }
    if (tab === "school") {
      const places = schoolQuery.data?.places ?? [];
      return places
        .filter(
          (s) =>
            s.level === schoolLevel &&
            Number.isFinite(s.lat) &&
            Number.isFinite(s.lng),
        )
        .map((s) => ({
          id: s.id,
          position: { lat: s.lat, lng: s.lng },
          title: s.name,
          label: s.name,
          kind: "SCHOOL" as const,
          schoolLevel: s.schoolLevel,
          schoolCode: s.schoolCode,
          schoolKind: s.level,
          schoolAddress: s.address,
          selected: selectedId === s.id,
        }));
    }
    return [];
  }, [
    lifeQuery.data,
    livingValidPlaces,
    schoolQuery.data,
    tab,
    schoolLevel,
    coords,
    selectedId,
  ]);

  const markers = useMemo(() => {
    const list = [...tabMarkers];
    if (complexMarker) list.unshift(complexMarker);
    return list;
  }, [tabMarkers, complexMarker]);

  const mapFitToken = useMemo(() => {
    if (!coords) return null;
    if (tab !== "living" && tab !== "commerce" && tab !== "school") {
      return null;
    }
    if (tab === "commerce") {
      const pts = commerceSnapshot?.mapPoints?.pointCount ?? 0;
      // Radius-only fit (no POI markers) — token remounts when points load.
      return `commerce:points:${pts || "pending"}`;
    }
    // Wait until POI markers exist — empty token must not trigger a no-op/default zoom.
    if (tabMarkers.length === 0) return null;
    const ids = tabMarkers
      .map((m) => m.id)
      .slice()
      .sort()
      .join("|");
    // Include count so tab switches always remount the fit even if id sets collide.
    if (tab === "living") {
      return `living:${livingCategory}:${tabMarkers.length}:${ids}`;
    }
    if (tab === "school") {
      return `school:${schoolLevel}:${tabMarkers.length}:${ids}`;
    }
    return `${tab}:${tabMarkers.length}:${ids}`;
  }, [tab, schoolLevel, coords, livingCategory, tabMarkers, commerceSnapshot?.mapPoints?.pointCount]);

  const onMarkerClick = useCallback(
    (id: string) => {
      setSelectedId(id);
      if (tab === "school" && id !== "complex") {
        pendingListScrollIdRef.current = null;
        const place = schoolQuery.data?.places.find((p) => p.id === id);
        const marker = tabMarkers.find((m) => m.id === id);
        const opened = openSchoolDetail({
          schoolCode: place?.schoolCode ?? marker?.schoolCode ?? null,
          name: place?.name ?? marker?.title ?? marker?.label ?? "",
          level: place?.level ?? marker?.schoolKind ?? "middle",
          address: place?.address ?? marker?.schoolAddress ?? null,
        });
        if (!opened) {
          // No NEIS code yet — keep selection highlight only.
          selectFromList(id);
        }
        return;
      }
      if (tab !== "living" || id === "complex") {
        pendingListScrollIdRef.current = null;
        return;
      }
      const idx = livingValidPlaces.findIndex((p) => p.id === id);
      if (idx < 0) {
        pendingListScrollIdRef.current = null;
        return;
      }
      pendingListScrollIdRef.current = id;
      if (idx >= LIST_LIMIT && !expanded) {
        setExpanded(true);
      }
    },
    [
      tab,
      livingValidPlaces,
      expanded,
      schoolQuery.data?.places,
      tabMarkers,
      openSchoolDetail,
      selectFromList,
    ],
  );

  // Marker → list: scroll after expand renders the target row (DOM only).
  useEffect(() => {
    const targetId = pendingListScrollIdRef.current;
    if (!targetId || tab !== "living") return;
    const el = document.getElementById(livingRowDomId(targetId));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    pendingListScrollIdRef.current = null;
  }, [selectedId, expanded, livingValidPlaces, tab]);

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
      if (commerceSnapshot) {
        return <ComplexCommerceStats snapshot={commerceSnapshot} />;
      }
      return commerceLoading ? (
        <EmptyBlock>상권 정보를 불러오는 중…</EmptyBlock>
      ) : (
        <ComplexLivingCensus complexId={identity?.complexId ?? null} />
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
      // 지하철 먼저, 버스로 채워 합계 5개 (policy §12.4). 더보기로 전체.
      const subwayItems = expanded ? subways : subways.slice(0, LIST_LIMIT);
      const busItems = expanded
        ? buses
        : buses.slice(0, Math.max(0, LIST_LIMIT - subwayItems.length));

      return (
        <div className="space-y-4">
          {subwayItems.length > 0 ? (
            <div>
              <p className="detail-subsection-title mb-1.5">
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
                                className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-black/25 detail-micro px-1 font-bold text-white shadow-sm"
                                style={{
                                  backgroundColor: subwayLineColor(line),
                                }}
                              >
                                {line}
                              </span>
                            ))
                          ) : (
                            <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-black/25 bg-amber-700 detail-micro px-1 font-bold text-white shadow-sm">
                              역
                            </span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="detail-label min-w-0 truncate font-medium text-[color:var(--lab-navy-950)]">
                              {p.name}
                            </span>
                            <span className="detail-meta shrink-0">
                              {formatMeters(p.distanceMeters)}
                              {" · 직선거리"}
                            </span>
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
              <p className="detail-subsection-title mb-1.5">
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
                            <span className="detail-label min-w-0 truncate font-medium text-[color:var(--lab-navy-950)]">
                              {p.name}
                            </span>
                            <span className="detail-meta shrink-0">
                              {metaText}
                            </span>
                          </span>
                          {routes.length > 0 ? (
                            <span className="mt-1.5 flex flex-wrap items-center gap-1">
                              {routes.map((route) => (
                                <span
                                  key={`${p.id}-${route}`}
                                  className="inline-flex h-[18px] items-center rounded border border-slate-200 bg-slate-50 detail-micro px-1.5 font-semibold text-slate-700"
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
            <span className="detail-meta">
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
              <p className="detail-subsection-title">{label}</p>
              <LivingDistanceSubtitle />
            </div>
            <EmptyBlock>
              주변 정보를 찾지 못했어요
              <br />
              <span className="detail-meta">
                주변에 표시할 주요 시설이 없어요
              </span>
            </EmptyBlock>
          </div>
        );
      }

      return (
        <div>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <p className="detail-subsection-title">{label}</p>
            <LivingDistanceSubtitle />
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
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="detail-label min-w-0 truncate font-medium text-[color:var(--lab-navy-950)]">
                          {p.name}
                        </span>
                        {p.medicalType === "GENERAL_HOSPITAL" ? (
                          <span className="inline-flex shrink-0 items-center rounded border border-[color-mix(in_srgb,var(--lab-teal-600)_28%,transparent)] bg-[var(--lab-teal-50)] detail-micro px-1 py-px font-semibold leading-none text-[var(--lab-teal-700)]">
                            종합병원
                          </span>
                        ) : null}
                        <span className="detail-meta shrink-0">
                          {formatDistanceOnly(p.distanceM)}
                        </span>
                      </span>
                      {address ? (
                        <span className="detail-meta mt-0.5 block truncate">
                          {address}
                        </span>
                      ) : null}
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
        if (
          !(
            (schoolLevel === "high" && school.schoolDistricts?.high) ||
            (schoolLevel === "middle" && school.schoolDistricts?.middle) ||
            (schoolLevel === "elementary" && school.attendanceZone?.elementary)
          )
        ) {
          return (
            <EmptyBlock>
              {school.reason || "인근 학교 정보를 불러오지 못했습니다."}
            </EmptyBlock>
          );
        }
        // Keep education-area metadata visible even when nearby NEIS fetch failed.
      }
      if (
        school.status !== "READY" &&
        school.status !== "EMPTY" &&
        school.status !== "ERROR" &&
        !(
          (schoolLevel === "high" && school.schoolDistricts?.high) ||
          (schoolLevel === "middle" && school.schoolDistricts?.middle) ||
          (schoolLevel === "elementary" && school.attendanceZone?.elementary)
        )
      ) {
        return (
          <EmptyBlock>
            {school.reason || "현재 확인 가능한 인근 학교 정보가 없습니다."}
          </EmptyBlock>
        );
      }

      const highDistrict =
        schoolLevel === "high" ? (school.schoolDistricts?.high ?? null) : null;
      const middleDistrict =
        schoolLevel === "middle"
          ? (school.schoolDistricts?.middle ?? null)
          : null;
      const elementaryZone =
        schoolLevel === "elementary"
          ? (school.attendanceZone?.elementary ?? null)
          : null;
      const section =
        school.categories.find((c) => c.level === schoolLevel) ?? null;
      const places = section?.places ?? [];
      const heading = NEARBY_LEVEL_HEADING[schoolLevel];

      return (
        <div className="space-y-2.5" data-school-level={schoolLevel}>
          {elementaryZone ? (
            <AttendanceZoneBlock
              zone={elementaryZone}
              onOpenSchool={(s) => {
                if (!openSchoolDetail(s)) {
                  /* no code — stay on list */
                }
              }}
            />
          ) : null}
          {middleDistrict ? (
            <SchoolDistrictBlock
              district={middleDistrict}
              onOpenSchool={(s) => {
                if (!openSchoolDetail(s)) {
                  /* no code — stay on list */
                }
              }}
            />
          ) : null}
          {highDistrict ? (
            <SchoolDistrictBlock
              district={highDistrict}
              onOpenSchool={(s) => {
                if (!openSchoolDetail(s)) {
                  /* no code — stay on list */
                }
              }}
            />
          ) : null}
          <div>
            <p className="detail-subsection-title mb-1">
              {heading}
            </p>
            {places.length === 0 ? (
              <p className="detail-meta px-0.5 py-1.5">
                주변에서 확인된 학교가 없습니다.
              </p>
            ) : (
              <ul className="space-y-0">
                {(expanded ? places : places.slice(0, LIST_LIMIT)).map((s) => {
                  const metaParts = [
                    s.establishment,
                    `${formatMeters(s.distanceM)} · 직선거리`,
                  ].filter(Boolean);
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(s.id);
                          const opened = openSchoolDetail(s);
                          if (!opened) {
                            selectFromList(s.id);
                          }
                        }}
                        aria-label={`${s.name} 상세 보기`}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-[5px] text-left transition active:scale-[0.99] active:bg-slate-100 ${selectedRowClass(selectedId === s.id)}`}
                      >
                        <span className="mt-0.5 inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded border border-slate-300 bg-white detail-micro px-0.5 font-bold text-[color:var(--lab-navy-950)]">
                          {SCHOOL_LEVEL_BADGE[s.schoolLevel as SchoolLevelCode]}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="detail-label block truncate font-medium text-[color:var(--lab-navy-950)]">
                            {s.name}
                          </span>
                          <span className="detail-meta mt-0.5 block">
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
            )}
          </div>
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
    if (!data) return 0;
    if (tab === "transport") {
      return Math.max(0, data.transport.items.length - LIST_LIMIT);
    }
    if (tab === "living") {
      return Math.max(0, livingValidPlaces.length - LIST_LIMIT);
    }
    if (tab === "commerce") {
      return 0;
    }
    if (tab === "school") {
      const places =
        schoolQuery.data?.categories?.find((c) => c.level === schoolLevel)
          ?.places ?? [];
      return Math.max(0, places.length - LIST_LIMIT);
    }
    return 0;
  })();

  return (
    <LabSection
      id="section-nearby-life"
      title="주변 생활"
      className={`gap-3 ${tab === "living" ? "overflow-visible" : ""}`}
      tip={<>
              <p className="detail-body">
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
                학교: 학교알리미·NEIS schoolInfo (인근 학교 · 배정/통학구역 아님)
                <br />
                생활시설: NAVER 지역 검색
                <br />
                상권 규모·업종·지도 점: 소상공인시장진흥공단 상가업소 (생활 밀착)
                <br />
                상권 지도 점 1개 = 생활업소 1곳 (대표 매장 검색 아님)
                <br />
                지역 검색 결과 기준이며 전체 시설 수를 의미하지 않습니다.
              </p>
      </>}
    >
      <LabTabs
        variant="secondary"
        ariaLabel="주변 생활 카테고리"
        value={tab}
        items={TABS}
        onChange={selectTab}
      />

      <div className="space-y-3">
        {tab === "living" ? (
          <LabTabs
            variant="secondary"
            ariaLabel="생활 시설 종류"
            value={livingCategory}
            items={LIVING_CHIP_ORDER.map((cat) => ({
              id: cat,
              label: LIVING_CHIP_LABEL[cat],
            }))}
            onChange={selectLivingCategory}
          />
        ) : null}

        {tab === "school" ? (
          <div data-testid="school-level-tabs">
            <LabTabs
              variant="secondary"
              ariaLabel="학교급"
              value={schoolLevel}
              items={SCHOOL_LEVEL_TABS}
              onChange={selectSchoolLevel}
            />
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
                  ? "relative h-[348px] w-full sm:h-[392px] lg:h-[440px]"
                  : tab === "commerce"
                    ? "relative h-[300px] w-full sm:h-[320px] lg:h-[360px]"
                    : tab === "school"
                      ? "relative h-[290px] w-full sm:h-[320px] lg:h-[360px]"
                      : "relative h-[240px] w-full sm:h-[280px] lg:h-[330px]"
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
                fitBoundsToken={mapFitToken}
                fitAnchor={
                  tab === "living" || tab === "commerce" || tab === "school"
                    ? coords
                    : null
                }
                fitRadiusM={
                  tab === "commerce" ? commerceSnapshot?.radiusM ?? 1000 : null
                }
                pointCloud={
                  tab === "commerce"
                    ? commerceSnapshot?.mapPoints ?? null
                    : null
                }
                referenceRadiusM={
                  tab === "commerce" && commerceSnapshot?.mapPoints
                    ? commerceSnapshot.radiusM
                    : null
                }
                ariaLabel={
                  tab === "living"
                    ? `${aptName} 주변 생활시설 지도`
                    : tab === "commerce"
                      ? `${aptName} 반경 1km 생활 상권 지도`
                      : tab === "school"
                        ? `${aptName} 인근 학교 지도`
                        : tab === "transport"
                          ? `${aptName} 주변 교통 지도`
                          : `${aptName} 주변 생활 지도`
                }
                className="h-full w-full rounded-none"
              />
              {tab === "commerce" && commerceSnapshot?.mapPoints ? (
                <p className="detail-meta pointer-events-none absolute bottom-2 left-3 rounded bg-white/90 px-1.5 py-0.5 font-medium text-slate-600">
                  점 1개 = 생활업소 1곳 · 색 = 업종 대분류
                </p>
              ) : null}
            </div>
          ) : (
            <div
              className={`flex items-center justify-center px-4 text-center text-sm text-slate-500 ${
                tab === "living"
                  ? "h-[348px] sm:h-[392px] lg:h-[440px]"
                  : tab === "commerce"
                    ? "h-[300px] sm:h-[320px] lg:h-[360px]"
                    : tab === "school"
                      ? "h-[290px] sm:h-[320px] lg:h-[360px]"
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
          {moreCount > 0 &&
          (tab === "transport" || tab === "living" || tab === "school") ? (
            <div className="mt-3">
              <LabMoreButton
                expanded={expanded}
                onToggle={() => setExpanded((v) => !v)}
                label={
                  tab === "transport"
                    ? `교통 ${moreCount}곳 더보기`
                    : tab === "school"
                      ? `학교 ${moreCount}곳 더보기`
                      : `${LIVING_CHIP_LABEL[livingCategory]} ${moreCount}곳 더보기`
                }
              />
            </div>
          ) : null}
        </div>
      </div>
    </LabSection>
  );
}
