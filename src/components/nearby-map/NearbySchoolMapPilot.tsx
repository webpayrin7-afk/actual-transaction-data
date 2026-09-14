"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { NaverMap, type NaverMapMarker } from "@/components/map/NaverMap";
import type { LatLng } from "@/lib/nearby-map/geo";

type SchoolLevel = "elementary" | "middle" | "high" | "other";

type SchoolItem = {
  id: string;
  name: string;
  level: SchoolLevel;
  schoolType: string;
  foundation: string | null;
  address: string | null;
  lat: number;
  lng: number;
  distanceM: number;
  distanceLabel: string;
  classification: "NEARBY_SCHOOL";
};

type PoiItem = {
  id: string;
  name: string;
  category: "transit" | "living" | "medical";
  subcategory: string;
  lat: number;
  lng: number;
  distanceM: number;
  distanceLabel: string;
};

type PilotPayload = {
  complex: {
    name: string;
    complexId: string;
    complexKey: string;
    coords: LatLng | null;
    coordSource: string;
    coordAccuracy: string;
    coordDetail: string;
  };
  catchment: {
    decision: "VERIFIED" | "HOLD";
    evidence: string;
  };
  summary: {
    transit: { label: string; value: string; name: string } | null;
    elementary: {
      label: string;
      value: string;
      name: string;
      classification: string;
    } | null;
    medical: { label: string; value: string } | null;
  };
  schools: {
    status: string;
    reason: string;
    items: SchoolItem[];
  };
  pois: {
    status: string;
    reason: string;
    items: PoiItem[];
    categories: { transit: number; living: number; medical: number };
    naverLocalPlaceApi: string;
  };
  meta: {
    distanceMethod: string;
    naverMapsJs: string;
    geocoding: string;
    reverseGeocoding: string;
    naverLocalPlaceSearch: string;
  };
};

type CategoryFilter = "all" | "transit" | "living" | "medical" | "school";

const LEVEL_LABEL: Record<SchoolLevel, string> = {
  elementary: "초등학교",
  middle: "중학교",
  high: "고등학교",
  other: "기타",
};

const POI_LABEL: Record<PoiItem["category"], string> = {
  transit: "교통",
  living: "생활",
  medical: "의료",
};

function poiKind(cat: PoiItem["category"]): NaverMapMarker["kind"] {
  if (cat === "transit") return "TRANSIT";
  if (cat === "living") return "LIVING";
  return "MEDICAL";
}

export function NearbySchoolMapPilot() {
  const [data, setData] = useState<PilotPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dev/nearby-school");
        const json = (await res.json()) as PilotPayload & { error?: string };
        if (!res.ok) {
          throw new Error(json.error || "파일럿 데이터를 불러오지 못했습니다.");
        }
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "로드 실패");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const availableFilters = useMemo(() => {
    if (!data) return [] as { id: CategoryFilter; label: string }[];
    const all: { id: CategoryFilter; label: string }[] = [
      { id: "all", label: "전체" },
    ];
    if (data.pois.categories.transit > 0)
      all.push({ id: "transit", label: "교통" });
    if (data.pois.categories.living > 0)
      all.push({ id: "living", label: "생활" });
    if (data.pois.categories.medical > 0)
      all.push({ id: "medical", label: "의료" });
    if (data.schools.items.length > 0)
      all.push({ id: "school", label: "학교" });
    return all;
  }, [data]);

  const markers: NaverMapMarker[] = useMemo(() => {
    if (!data?.complex.coords) return [];
    const out: NaverMapMarker[] = [
      {
        id: "complex:jamsil-els",
        position: data.complex.coords,
        title: data.complex.name,
        kind: "COMPLEX",
        selected: selectedId === "complex:jamsil-els",
      },
    ];
    if (filter === "all" || filter === "school") {
      for (const s of data.schools.items) {
        const id = `school:${s.id}`;
        out.push({
          id,
          position: { lat: s.lat, lng: s.lng },
          title: s.name,
          kind: "SCHOOL",
          selected: selectedId === id,
        });
      }
    }
    for (const p of data.pois.items) {
      if (filter !== "all" && filter !== p.category) continue;
      out.push({
        id: p.id,
        position: { lat: p.lat, lng: p.lng },
        title: p.name,
        kind: poiKind(p.category),
        selected: selectedId === p.id,
      });
    }
    return out;
  }, [data, filter, selectedId]);

  const onSelect = useCallback((id: string) => {
    setSelectedId(id);
    const el = document.getElementById(`row-${CSS.escape(id)}`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  if (loadError) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        {loadError}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        파일럿 데이터 불러오는 중…
      </div>
    );
  }

  const coords = data.complex.coords;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6">
      <header className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-teal-800">
          DEV · Phase 8.1
        </p>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">
          주변환경 · 학군 지도 파일럿
        </h1>
        <p className="text-sm text-slate-600">
          {data.complex.name} · NAVER Map(2D 위치) + NEIS(학교 구조 데이터)
        </p>
      </header>

      <section className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700 sm:grid-cols-3">
        {data.summary.transit ? (
          <SummaryCell
            label={data.summary.transit.label}
            value={data.summary.transit.value}
            hint={data.summary.transit.name}
          />
        ) : null}
        {data.summary.elementary ? (
          <SummaryCell
            label={data.summary.elementary.label}
            value={data.summary.elementary.value}
            hint={`${data.summary.elementary.name} · NEARBY_SCHOOL`}
          />
        ) : null}
        {data.summary.medical ? (
          <SummaryCell
            label={data.summary.medical.label}
            value={data.summary.medical.value}
            hint="직선거리 1km"
          />
        ) : (
          <SummaryCell
            label="통학구역"
            value={
              data.catchment.decision === "VERIFIED" ? "확인됨" : "미검증(HOLD)"
            }
            hint="배정학교 미표시"
          />
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {coords ? (
            <NaverMap
              center={coords}
              zoom={16}
              markers={markers}
              selectedId={selectedId}
              onMarkerClick={onSelect}
              className="h-[260px] sm:h-[360px]"
              ariaLabel={`${data.complex.name} 주변 지도`}
            />
          ) : (
            <div className="flex h-[260px] items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-4 text-center text-sm text-slate-600 sm:h-[360px]">
              단지 좌표를 확보하지 못해 지도를 중심 고정할 수 없습니다.
              <br />
              (master 좌표 또는 VWORLD_API_KEY 지오코딩 필요 — 임의 좌표 사용 안
              함)
            </div>
          )}
          <p className="text-[11px] text-slate-400">
            지도: NAVER Cloud Platform Web Dynamic Map · 필수 저작권/로고 유지
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {availableFilters.map((f) => {
              const active = filter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={`rounded-lg px-3 py-1.5 text-[13px] transition ${
                    active
                      ? "bg-teal-50 font-medium text-teal-900 ring-1 ring-teal-200"
                      : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          {(filter === "all" || filter === "school") && (
            <ListBlock title="학교 (인근 · NEIS)">
              {data.catchment.decision === "HOLD" ? (
                <p className="mb-2 text-[12px] leading-relaxed text-slate-500">
                  공식 통학구역/배정학교는 미검증입니다. 아래는{" "}
                  <span className="font-medium text-slate-700">인근 학교</span>
                  만 표시합니다.
                </p>
              ) : null}
              {data.schools.status !== "OK" ? (
                <p className="text-sm text-slate-500">{data.schools.reason}</p>
              ) : (
                (["elementary", "middle", "high"] as SchoolLevel[]).map(
                  (level) => {
                    const rows = data.schools.items.filter(
                      (s) => s.level === level
                    );
                    if (rows.length === 0) return null;
                    return (
                      <div key={level} className="mb-3">
                        <p className="mb-1 text-[11px] font-medium text-slate-500">
                          {LEVEL_LABEL[level]}
                        </p>
                        {rows.map((s) => {
                          const id = `school:${s.id}`;
                          return (
                            <button
                              key={id}
                              id={`row-${id}`}
                              type="button"
                              onClick={() => onSelect(id)}
                              className={`flex w-full items-start justify-between gap-2 border-b border-slate-100 py-2 text-left last:border-0 ${
                                selectedId === id ? "bg-teal-50/60" : ""
                              }`}
                            >
                              <span>
                                <span className="block text-sm font-medium text-slate-900">
                                  {s.name}
                                </span>
                                <span className="mt-0.5 block text-[11px] text-slate-400">
                                  {[
                                    s.schoolType,
                                    s.foundation,
                                    s.distanceLabel,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  }
                )
              )}
            </ListBlock>
          )}

          {(filter === "all" ||
            filter === "transit" ||
            filter === "living" ||
            filter === "medical") && (
            <ListBlock title="주변환경">
              {data.pois.status !== "OK" ? (
                <p className="text-sm text-slate-500">{data.pois.reason}</p>
              ) : (
                data.pois.items
                  .filter((p) => filter === "all" || p.category === filter)
                  .map((p) => (
                    <button
                      key={p.id}
                      id={`row-${p.id}`}
                      type="button"
                      onClick={() => onSelect(p.id)}
                      className={`flex w-full items-start justify-between gap-2 border-b border-slate-100 py-2 text-left last:border-0 ${
                        selectedId === p.id ? "bg-teal-50/60" : ""
                      }`}
                    >
                      <span>
                        <span className="block text-[11px] text-slate-400">
                          {POI_LABEL[p.category]}
                        </span>
                        <span className="block text-sm font-medium text-slate-900">
                          {p.name}
                        </span>
                      </span>
                      <span className="shrink-0 text-[12px] tabular-nums text-slate-500">
                        {p.distanceLabel}
                      </span>
                    </button>
                  ))
              )}
            </ListBlock>
          )}

          <details className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
            <summary className="cursor-pointer text-sm font-medium text-slate-800">
              데이터 기준 보기
            </summary>
            <dl className="mt-2 space-y-2 text-[13px]">
              <Row
                k="단지 좌표"
                v={`${data.complex.coordSource} · ${data.complex.coordAccuracy} — ${data.complex.coordDetail}`}
              />
              <Row k="학교" v="NEIS schoolInfo · 인근(NEARBY_SCHOOL)" />
              <Row
                k="통학구역"
                v={`${data.catchment.decision} — ${data.catchment.evidence}`}
              />
              <Row
                k="주변시설"
                v={`VWorld place search · NAVER Local/Place: ${data.pois.naverLocalPlaceApi}`}
              />
              <Row k="거리" v={data.meta.distanceMethod} />
              <Row k="지도 렌더러" v={data.meta.naverMapsJs} />
              <Row k="지오코딩" v={data.meta.geocoding} />
              <Row k="역지오코딩" v={data.meta.reverseGeocoding} />
            </dl>
          </details>
        </div>
      </div>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div>
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p className="mt-0.5 font-medium text-slate-900">{value}</p>
      <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>
    </div>
  );
}

function ListBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium text-slate-500">{k}</dt>
      <dd className="mt-0.5 leading-relaxed text-slate-700">{v}</dd>
    </div>
  );
}
