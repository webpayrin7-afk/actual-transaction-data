"use client";

import { useQuery } from "@tanstack/react-query";
import {
  LabCard,
  LabSectionHeading,
  LAB_BUTTON_SECONDARY,
} from "@/components/ui/lab";
import type {
  NearbySaleCard,
  NearbySalesResult,
} from "@/lib/complex-detail/applyhome-nearby-sales";

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

function SaleCard({ item }: { item: NearbySaleCard }) {
  return (
    <li className="rounded-xl border border-slate-100 bg-white px-3 py-3 sm:px-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">
            {item.houseName}
          </p>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {item.regionLabel || "—"}
          </p>
        </div>
        <span className="shrink-0 rounded-md bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
          {item.statusLabel}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-slate-600">
        <div>
          <dt className="text-slate-400">공급</dt>
          <dd className="tabular-nums text-slate-800">
            {item.supplyHouseholds != null
              ? `${item.supplyHouseholds.toLocaleString("ko-KR")}세대`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">입주예정</dt>
          <dd className="tabular-nums text-slate-800">
            {item.moveInLabel ?? "—"}
          </dd>
        </div>
      </dl>

      {item.types.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-slate-50 pt-2">
          {item.types.map((t) => (
            <li
              key={`${item.id}-${t.modelNo}`}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="font-medium tabular-nums text-slate-800">
                {t.label}
              </span>
              <span className="tabular-nums text-slate-700">
                최고 {t.topAmountLabel}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {item.competition ? (
        <p className="mt-2 text-[12px] leading-relaxed text-slate-600">
          {item.competition.label}
        </p>
      ) : null}

      {item.pblancUrl ? (
        <a
          href={item.pblancUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`${LAB_BUTTON_SECONDARY} mt-3 inline-flex h-9 w-full items-center justify-center text-sm`}
        >
          청약 상세 보기
        </a>
      ) : null}
    </li>
  );
}

/** Inline 주변 분양 — sigungu only; no map/coords. */
export function ComplexNearbySalesSection({
  aptName,
  sigungu,
}: {
  aptName: string;
  sigungu: string | null | undefined;
}) {
  const key = sigungu?.trim() || "";
  const q = useQuery({
    queryKey: ["complex-nearby-sales", key],
    queryFn: () => loadNearbySales(key),
    enabled: key.length > 0,
    staleTime: 60 * 60 * 1000,
    retry: 0,
  });

  const description = key
    ? `${aptName} 주변 · ${key} 기준`
    : `${aptName} 주변`;

  const data = q.data;
  const ready = data?.status === "READY" && (data.items?.length ?? 0) > 0;

  return (
    <LabCard className="p-4 sm:p-5">
      <LabSectionHeading title="주변 분양" description={description} />

      {!key ? (
        <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-3">
          <p className="text-sm text-slate-600">
            단지 시군구 정보가 없어 주변 분양을 조회할 수 없습니다.
          </p>
        </div>
      ) : null}

      {key && q.isLoading ? (
        <p className="mt-3 text-sm text-slate-500">
          주변 분양 정보를 불러오는 중…
        </p>
      ) : null}

      {key && !q.isLoading && !ready ? (
        <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-3">
          <p className="text-sm text-slate-600">
            {data?.reason || "표시할 분양 공고가 없습니다."}
          </p>
        </div>
      ) : null}

      {ready ? (
        <ul className="mt-3 space-y-3">
          {data!.items.map((item) => (
            <SaleCard key={item.id} item={item} />
          ))}
        </ul>
      ) : null}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
        {data?.notice ??
          "청약 일정과 공급조건은 실제 입주자모집공고를 확인하세요."}
        {data?.attribution
          ? ` · ${data.attribution}`
          : " · 출처: 청약홈 · 한국부동산원"}
      </p>
    </LabCard>
  );
}
