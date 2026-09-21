"use client";

import { useQuery } from "@tanstack/react-query";
import { LabCard } from "@/components/ui/lab";
import { InfoTip } from "@/components/ui/InfoTip";
import type {
  NearbySaleCard,
  NearbySaleStatus,
  NearbySalesResult,
} from "@/lib/complex-detail/applyhome-nearby-sales";

const VISIBLE_TYPES = 2;

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

/** Prefer 동/가 from regionLabel; fall back to last token. */
function shortPlace(regionLabel: string): string {
  const trimmed = regionLabel.trim();
  if (!trimmed) return "";
  const dong = trimmed.match(/([가-힣0-9]+(?:동|가))$/)?.[1];
  if (dong) return dong;
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] ?? trimmed;
}

/** Display supply as 세대 (UI label); API 실/세대 semantics unchanged. */
function supply세대Label(item: NearbySaleCard): string | null {
  if (item.supplyCount != null) {
    return `${item.supplyCount.toLocaleString("ko-KR")}세대`;
  }
  if (!item.supplyCountLabel) return null;
  return item.supplyCountLabel.replace(/실$/, "세대");
}

function metaLeft(item: NearbySaleCard): string {
  const isOfficetel = item.housingCategory === "officetel";
  const kind = isOfficetel ? "오피스텔" : "아파트";
  const place = shortPlace(item.regionLabel);
  const supply = supply세대Label(item);
  return [kind, place || null, supply].filter(Boolean).join(" · ");
}

function TypeChips({ item }: { item: NearbySaleCard }) {
  if (item.types.length === 0) return null;
  const visible = item.types.slice(0, VISIBLE_TYPES);
  const extra = Math.max(0, item.types.length - VISIBLE_TYPES);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      {visible.map((t) => (
        <span
          key={`${item.id}-${t.modelNo}`}
          className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums text-slate-600"
        >
          {t.label}
        </span>
      ))}
      {extra > 0 ? (
        <span className="inline-flex items-center rounded-full border border-slate-200/80 bg-white px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums text-slate-400">
          외 {extra}개
        </span>
      ) : null}
    </span>
  );
}

function DetailCta({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 text-[11px] font-medium !text-teal-700 transition hover:!text-teal-800"
    >
      {label}
    </a>
  );
}

function SaleRow({ item }: { item: NearbySaleCard }) {
  const isMoveIn = item.status === "move_in_upcoming";
  const detailHref = item.pblancUrl;
  const detailLabel = isMoveIn ? "공고상세 가기 →" : "청약상세 가기 →";
  const priced = !isMoveIn
    ? item.types.filter((t) => t.topAmountLabel).slice(0, VISIBLE_TYPES)
    : [];
  const pricedExtra = !isMoveIn
    ? Math.max(0, item.types.filter((t) => t.topAmountLabel).length - VISIBLE_TYPES)
    : 0;

  return (
    <li className="px-3 py-2.5">
      {/* ROW 1 — name; status pill only when not move-in */}
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 line-clamp-2 text-[13px] font-semibold leading-snug text-slate-900">
          {item.houseName}
        </p>
        {!isMoveIn ? (
          <span
            className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${statusPillClass(item.status)}`}
          >
            {item.statusLabel}
          </span>
        ) : null}
      </div>

      {/* ROW 2 — meta + type badges to the right of 세대 */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-[11px] leading-snug text-slate-500">
          {metaLeft(item)}
        </p>
        <TypeChips item={item} />
      </div>

      {/* Active: schedule + competition + price rows */}
      {!isMoveIn && item.scheduleLabel ? (
        <p className="mt-1 text-[12px] font-medium tabular-nums text-slate-800">
          {item.scheduleLabel}
        </p>
      ) : null}
      {!isMoveIn && item.competition ? (
        <p className="mt-0.5 text-[11px] leading-snug text-slate-600">
          {item.competition.label}
        </p>
      ) : null}
      {priced.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {priced.map((t) => (
            <li
              key={`${item.id}-price-${t.modelNo}`}
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
          {pricedExtra > 0 ? (
            <li className="text-[10px] font-medium tabular-nums text-slate-400">
              외 {pricedExtra}개
            </li>
          ) : null}
        </ul>
      ) : null}

      {/* ROW 3 — move-in date + 입주예정 (same type size) + teal text CTA */}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        {isMoveIn && item.moveInLabel ? (
          <span className="text-[12px] font-semibold leading-snug tabular-nums text-slate-800">
            {item.moveInLabel} 입주예정
          </span>
        ) : null}
        {detailHref ? (
          <span className="ml-auto">
            <DetailCta href={detailHref} label={detailLabel} />
          </span>
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
      ? `현재 ${key}에 확인된 청약·입주예정 아파트가 없습니다.`
      : "표시할 공급 정보가 없습니다.");

  return (
    <LabCard className="p-4 sm:p-5">
      <div className="lab-section-heading">
        <div className="min-w-0">
          <h2 className="flex items-center">
            주변 공급
            <InfoTip aria-label="주변 공급 출처 안내" className="text-[13px]">
              <p>출처: 청약홈 · 한국부동산원</p>
              <p>지역 기준: 현재 단지가 속한 시군구</p>
              <p>입주예정월 및 청약 일정은 공식 공고 기준입니다.</p>
              <p>실제 일정과 공급조건은 공식 공고를 확인하세요.</p>
            </InfoTip>
          </h2>
          <p>{description}</p>
        </div>
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
        <ul className="mt-2 overflow-hidden rounded-lg border border-slate-200 divide-y divide-slate-100">
          {items.map((item) => (
            <SaleRow key={item.id} item={item} />
          ))}
        </ul>
      ) : null}
    </LabCard>
  );
}
