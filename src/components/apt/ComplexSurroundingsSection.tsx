"use client";

import { useQuery } from "@tanstack/react-query";
import { LabCard, LabSectionHeading } from "@/components/ui/lab";
import {
  SURROUNDING_CATEGORY_LABEL,
  type SurroundingCategory,
  type SurroundingPlace,
} from "@/lib/complex-detail/vworld";

type SurroundingsResponse = {
  status: string;
  reason: string;
  places: SurroundingPlace[];
  attribution: string | null;
  distanceType: string;
  routing: boolean;
};

const ORDER: SurroundingCategory[] = [
  "transit",
  "living",
  "medical",
  "park",
  "childcare",
];

async function loadSurroundings(aptName: string): Promise<SurroundingsResponse> {
  const qs = new URLSearchParams({ aptName });
  const res = await fetch(`/api/complex-surroundings?${qs}`);
  if (!res.ok) {
    return {
      status: "ERROR",
      reason: "주변환경 정보를 불러오지 못했습니다.",
      places: [],
      attribution: null,
      distanceType: "straight_line",
      routing: false,
    };
  }
  return res.json();
}

/** Inline 주변환경 — straight-line only; no invented walk times. */
export function ComplexSurroundingsSection({ aptName }: { aptName: string }) {
  const q = useQuery({
    queryKey: ["complex-surroundings", aptName],
    queryFn: () => loadSurroundings(aptName),
    staleTime: 60 * 60 * 1000,
    retry: 0,
  });

  const grouped = new Map<SurroundingCategory, SurroundingPlace[]>();
  for (const place of q.data?.places ?? []) {
    const list = grouped.get(place.category) ?? [];
    list.push(place);
    grouped.set(place.category, list);
  }

  return (
    <LabCard className="p-4 sm:p-5">
      <LabSectionHeading
        title="주변환경"
        description="생활·교통 시설 · 직선거리"
      />

      {q.isLoading ? (
        <p className="mt-3 text-sm text-slate-500">
          주변환경 정보를 불러오는 중…
        </p>
      ) : null}

      {!q.isLoading && q.data?.status !== "READY" ? (
        <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-3">
          <p className="text-sm text-slate-600">
            주변환경 데이터를 아직 표시할 수 없습니다.
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-400">
            {q.data?.reason || "DATA_SOURCE_NOT_READY"}
          </p>
          <p className="mt-2 text-[11px] text-slate-400">
            도보 시간은 경로 API 없이 추정하지 않습니다. 직선거리만 제공합니다.
          </p>
        </div>
      ) : null}

      {q.data?.status === "READY" ? (
        <div className="mt-3 space-y-4">
          {ORDER.map((cat) => {
            const places = grouped.get(cat);
            if (!places?.length) return null;
            return (
              <div key={cat}>
                <p className="text-[11px] font-medium text-slate-500">
                  {SURROUNDING_CATEGORY_LABEL[cat]}
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {places.map((p) => (
                    <li
                      key={`${p.category}-${p.name}`}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <span className="min-w-0 truncate text-sm text-slate-900">
                        {p.name}
                      </span>
                      <span className="shrink-0 text-sm tabular-nums text-slate-700">
                        {p.distanceLabel}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <p className="text-[11px] text-slate-400">
            거리는 직선 기준이며 도보·차량 시간이 아닙니다.
            {q.data.attribution ? ` · ${q.data.attribution}` : ""}
          </p>
        </div>
      ) : null}
    </LabCard>
  );
}
