"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  SUPPLY_EMPTY_MESSAGE,
  SUPPLY_LOADING_MESSAGE,
  SUPPLY_NO_REGION_MESSAGE,
  SUPPLY_SCOPE_TIP,
  SUPPLY_UNAVAILABLE_MESSAGE,
  type NearbySaleCard,
  type NearbySalesResult,
} from "@/lib/complex-detail/nearby-supply";

async function loadNearbySales(sigungu: string): Promise<NearbySalesResult> {
  const qs = new URLSearchParams({ sigungu });
  const res = await fetch(`/api/complex-nearby-sales?${qs}`);
  if (!res.ok) {
    return {
      status: "UNAVAILABLE",
      message: SUPPLY_UNAVAILABLE_MESSAGE,
      sigungu,
      scope: "SIGUNGU",
      items: [],
    };
  }
  return res.json();
}

function ScopeTip() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label="주변 공급 기준"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[13px] leading-none text-slate-400 hover:text-slate-600"
      >
        ⓘ
      </button>
      {open ? (
        <span
          id={panelId}
          role="note"
          className="absolute left-0 top-full z-20 mt-1 w-64 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-left text-[12px] font-normal leading-5 text-slate-600 shadow-sm"
        >
          {SUPPLY_SCOPE_TIP}
        </span>
      ) : null}
    </span>
  );
}

function factLine(item: NearbySaleCard): string | null {
  const parts: string[] = [];
  if (item.supplyUnitsLabel) parts.push(item.supplyUnitsLabel);
  if (item.currentStatus === "move_in_upcoming" && item.moveInLabel) {
    parts.push(`${item.moveInLabel} 입주 예정`);
  } else if (item.scheduleLabel && item.currentStatus !== "closed") {
    parts.push(item.scheduleLabel);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function SaleCard({ item }: { item: NearbySaleCard }) {
  const typeLabel = item.sourceType === "OFFICETEL" ? "오피스텔" : "아파트";
  const facts = factLine(item);

  return (
    <li className="px-3.5 py-3">
      <p className="text-sm font-semibold leading-snug text-slate-900">
        {item.projectName}
      </p>
      <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
        {typeLabel}
        <span className="text-slate-300" aria-hidden>
          {" "}
          ·{" "}
        </span>
        {item.statusLabel}
      </p>
      {item.regionLabel ? (
        <p className="mt-1 text-xs leading-snug text-slate-500">{item.regionLabel}</p>
      ) : null}
      {facts ? (
        <p className="mt-1 text-[13px] font-medium tabular-nums text-slate-800">
          {facts}
        </p>
      ) : null}
      {item.competition ? (
        <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
          {item.competition.label}
        </p>
      ) : null}
      {item.pblancUrl ? (
        <a
          href={item.pblancUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block text-[11px] font-medium text-teal-700"
        >
          공고
        </a>
      ) : null}
    </li>
  );
}

/** 시군구 기준 주변 공급. Does not call the public-data API from the browser. */
export function ComplexNearbySalesSection({
  sigungu,
}: {
  sigungu: string | null | undefined;
}) {
  const key = sigungu?.trim() || "";
  const query = useQuery({
    queryKey: ["complex-nearby-supply", key],
    queryFn: () => loadNearbySales(key),
    enabled: key.length > 0,
    staleTime: 60 * 60 * 1000,
    retry: 0,
  });

  const items = query.data?.status === "AVAILABLE" ? query.data.items : [];
  let body: string | null = null;
  if (!key) body = SUPPLY_NO_REGION_MESSAGE;
  else if (query.isLoading) body = SUPPLY_LOADING_MESSAGE;
  else if (query.isError || query.data?.status === "UNAVAILABLE") {
    body = SUPPLY_UNAVAILABLE_MESSAGE;
  } else if (!query.data || query.data.status === "EMPTY" || items.length === 0) {
    body = SUPPLY_EMPTY_MESSAGE;
  }

  return (
    <section className="lab-card p-4 sm:p-5" aria-label="주변 공급">
      <div className="mb-3 flex items-center gap-0.5">
        <h2 className="text-sm font-semibold text-slate-900 sm:text-base">
          주변 공급
        </h2>
        <ScopeTip />
      </div>

      {body ? (
        <p className="text-sm text-slate-500">{body}</p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/80">
          {items.map((item) => (
            <SaleCard key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}
