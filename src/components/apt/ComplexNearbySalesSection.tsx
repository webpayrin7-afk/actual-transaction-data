"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LabCard } from "@/components/ui/lab";
import type {
  NearbySaleCard,
  NearbySaleStatus,
  NearbySalesResult,
} from "@/lib/complex-detail/applyhome-nearby-sales";

const COLLAPSED_TYPES = 2;

const ACTIVE_STATUSES = new Set<NearbySaleStatus>([
  "upcoming",
  "open",
  "receipt_closed",
  "winner_announced",
  "contracting",
]);

async function loadNearbySales(sigungu: string): Promise<NearbySalesResult> {
  const qs = new URLSearchParams({ sigungu });
  const res = await fetch(`/api/complex-nearby-sales?${qs}`);
  if (!res.ok) {
    return {
      status: "ERROR",
      reason: "주변 분양 정보를 불러오지 못했습니다.",
      sigungu,
      items: [],
      attribution: "출처: 청약홈 · 한국부동산원",
      notice: "청약 일정과 공급조건은 실제 입주자모집공고를 확인하세요.",
    };
  }
  return res.json();
}

function statusPillClass(status: NearbySaleStatus): string {
  if (status === "upcoming" || status === "open") {
    return "bg-[var(--lab-teal-50)] text-[var(--lab-teal-700)]";
  }
  return "bg-slate-100 text-slate-600";
}

function SaleRow({ item }: { item: NearbySaleCard }) {
  const [expanded, setExpanded] = useState(false);
  const visibleTypes = expanded
    ? item.types
    : item.types.slice(0, COLLAPSED_TYPES);
  const hiddenCount = Math.max(0, item.types.length - COLLAPSED_TYPES);

  return (
    <li className="py-3 first:pt-1">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-[13px] font-semibold leading-snug text-slate-900">
          {item.houseName}
        </p>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${statusPillClass(item.status)}`}
        >
          {item.statusLabel}
        </span>
      </div>

      <p className="mt-1 text-[11px] leading-snug text-slate-500">
        {item.regionLabel || "—"}
      </p>
      <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
        공급{" "}
        {item.supplyHouseholds != null
          ? `${item.supplyHouseholds.toLocaleString("ko-KR")}세대`
          : "—"}
        {item.moveInLabel ? ` · 입주예정 ${item.moveInLabel}` : null}
      </p>

      {item.scheduleLabel ? (
        <p className="mt-1.5 text-[12px] font-medium tabular-nums text-slate-800">
          {item.scheduleLabel}
        </p>
      ) : null}

      {item.competition ? (
        <p className="mt-1 text-[11px] leading-snug text-slate-600">
          {item.competition.label}
        </p>
      ) : null}

      {visibleTypes.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {visibleTypes.map((t) => (
            <li
              key={`${item.id}-${t.modelNo}`}
              className="flex items-baseline justify-between gap-3 text-[12px] leading-snug"
            >
              <span className="font-medium tabular-nums text-slate-800">
                {t.label}
              </span>
              <span className="tabular-nums text-slate-600">
                최고 {t.topAmountLabel}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-1.5 flex items-center justify-between gap-2">
        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] text-slate-500 underline-offset-2 hover:underline"
          >
            {expanded ? "접기" : `주택형 ${hiddenCount}개 더보기`}
          </button>
        ) : (
          <span />
        )}
        {item.pblancUrl ? (
          <a
            href={item.pblancUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-[11px] font-medium text-[var(--lab-teal-700)]"
          >
            청약 상세 →
          </a>
        ) : null}
      </div>
    </li>
  );
}

/** Inline 주변 분양 — sigungu only; no map/coords. Compact list. */
export function ComplexNearbySalesSection({
  aptName,
  sigungu,
}: {
  aptName: string;
  sigungu: string | null | undefined;
}) {
  const key = sigungu?.trim() || "";
  const q = useQuery({
    queryKey: ["complex-nearby-sales", key, "active-only"],
    queryFn: () => loadNearbySales(key),
    enabled: key.length > 0,
    staleTime: 60 * 60 * 1000,
    retry: 0,
  });

  const description = key
    ? `${aptName} 주변 · ${key} 기준`
    : `${aptName} 주변`;

  const items = (q.data?.items ?? []).filter((item) =>
    ACTIVE_STATUSES.has(item.status),
  );
  const ready = q.data?.status === "READY" && items.length > 0;
  const emptyReason =
    q.data?.reason ||
    (key
      ? `현재 ${key}에 진행 중이거나 예정된 APT 분양·청약 정보가 없습니다.`
      : "표시할 분양 공고가 없습니다.");

  return (
    <LabCard className="p-4 sm:p-5">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
          주변 분양
        </h2>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
          {description}
        </p>
      </div>

      {!key ? (
        <p className="mt-2 text-[12px] leading-snug text-slate-500">
          단지 시군구 정보가 없어 주변 분양을 조회할 수 없습니다.
        </p>
      ) : null}

      {key && q.isLoading ? (
        <p className="mt-2 text-[12px] text-slate-500">
          주변 분양 정보를 불러오는 중…
        </p>
      ) : null}

      {key && !q.isLoading && !ready ? (
        <p className="mt-2 text-[12px] leading-snug text-slate-500">
          {emptyReason}
        </p>
      ) : null}

      {ready ? (
        <ul className="mt-1 divide-y divide-slate-100">
          {items.map((item) => (
            <SaleRow key={item.id} item={item} />
          ))}
        </ul>
      ) : null}

      <p className="mt-2 text-[10px] leading-snug text-slate-400">
        출처 · 청약홈 · 한국부동산원
        <br />
        청약 조건은 실제 입주자모집공고를 확인하세요.
      </p>
    </LabCard>
  );
}
