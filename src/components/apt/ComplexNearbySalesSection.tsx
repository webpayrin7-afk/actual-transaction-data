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

const FEED_STATUSES = new Set<NearbySaleStatus>([
  "upcoming",
  "open",
  "receipt_closed",
  "winner_announced",
  "contracting",
  "move_in_upcoming",
]);

async function loadNearbySales(sigungu: string): Promise<NearbySalesResult> {
  const qs = new URLSearchParams({ sigungu });
  const res = await fetch(`/api/complex-nearby-sales?${qs}`);
  if (!res.ok) {
    return {
      status: "ERROR",
      reason: "주변 공급 정보를 불러오지 못했습니다.",
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
  if (status === "move_in_upcoming") {
    return "bg-[var(--lab-teal-50)]/70 text-[var(--lab-teal-700)]/80";
  }
  return "bg-slate-100 text-slate-600";
}

function SaleRow({ item }: { item: NearbySaleCard }) {
  const [expanded, setExpanded] = useState(false);
  const isMoveIn = item.status === "move_in_upcoming";
  const isOfficetel = item.housingCategory === "officetel";
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
        {isOfficetel ? "오피스텔 · " : null}
        {item.regionLabel || "—"}
      </p>
      <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
        공급 {item.supplyCountLabel ?? "—"}
        {!isMoveIn && item.moveInLabel
          ? ` · 입주예정 ${item.moveInLabel}`
          : null}
      </p>

      {isMoveIn && item.moveInLabel ? (
        <p className="mt-1.5 text-[12px] font-medium tabular-nums text-slate-800">
          {item.moveInLabel} 입주예정
        </p>
      ) : null}

      {!isMoveIn && item.scheduleLabel ? (
        <p className="mt-1.5 text-[12px] font-medium tabular-nums text-slate-800">
          {item.scheduleLabel}
        </p>
      ) : null}

      {!isMoveIn && item.competition ? (
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
              {!isMoveIn && t.topAmountLabel ? (
                <span className="tabular-nums text-slate-600">
                  최고 {t.topAmountLabel}
                </span>
              ) : null}
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
            {isMoveIn ? "공고 상세 →" : "청약 상세 →"}
          </a>
        ) : null}
      </div>
    </li>
  );
}

/** Inline 주변 공급 — sigungu only; no map/coords. Compact list. */
export function ComplexNearbySalesSection({
  aptName,
  sigungu,
}: {
  aptName: string;
  sigungu: string | null | undefined;
}) {
  const key = sigungu?.trim() || "";
  const q = useQuery({
    queryKey: ["complex-nearby-supply", key, "apt+officetel"],
    queryFn: () => loadNearbySales(key),
    enabled: key.length > 0,
    staleTime: 60 * 60 * 1000,
    retry: 0,
  });

  const description = key
    ? `${aptName} 주변 · ${key} 기준`
    : `${aptName} 주변`;

  const items = (q.data?.items ?? []).filter((item) =>
    FEED_STATUSES.has(item.status),
  );
  const ready = q.data?.status === "READY" && items.length > 0;
  const emptyReason =
    q.data?.reason ||
    (key
      ? `현재 ${key}에 확인된 청약·입주예정 주택이 없습니다.`
      : "표시할 공급 정보가 없습니다.");

  return (
    <LabCard className="p-4 sm:p-5">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
          주변 공급
        </h2>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
          {description}
        </p>
        <p className="mt-0.5 text-[10px] leading-snug text-slate-400">
          청약 및 입주예정 주택
        </p>
      </div>

      {!key ? (
        <p className="mt-2 text-[12px] leading-snug text-slate-500">
          단지 시군구 정보가 없어 주변 공급을 조회할 수 없습니다.
        </p>
      ) : null}

      {key && q.isLoading ? (
        <p className="mt-2 text-[12px] text-slate-500">
          주변 공급 정보를 불러오는 중…
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
