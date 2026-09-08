"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown } from "lucide-react";
import type { AptAreaOption } from "@/lib/molit/apt";
import { toPyeong } from "@/lib/utils/format";

type AptAreaSelectorProps = {
  areas: AptAreaOption[];
  value: string;
  onChange: (key: string) => void;
};

type AreaNavItem = {
  key: string;
  label: string;
  exclusiveArea: number | null;
};

function buildAreaNavItems(areas: AptAreaOption[]): AreaNavItem[] {
  const sorted = [...areas].sort(
    (a, b) => a.exclusiveArea - b.exclusiveArea,
  );
  const pyeongCount = new Map<number, number>();
  for (const area of sorted) {
    const p = Math.round(toPyeong(area.exclusiveArea));
    pyeongCount.set(p, (pyeongCount.get(p) ?? 0) + 1);
  }

  return sorted.map((area) => {
    const pyeong = Math.round(toPyeong(area.exclusiveArea));
    const collision = (pyeongCount.get(pyeong) ?? 0) > 1;
    return {
      key: area.key,
      // 동일 평 환산·서로 다른 areaKey → ㎡로 구분 (합치지 않음)
      label: collision
        ? `${area.exclusiveArea.toFixed(2)}㎡`
        : `${pyeong}평`,
      exclusiveArea: area.exclusiveArea,
    };
  });
}

function itemClass(active: boolean) {
  return `shrink-0 whitespace-nowrap px-1.5 py-1 text-sm transition ${
    active
      ? "border-b-2 border-teal-600 font-semibold text-slate-900"
      : "border-b-2 border-transparent font-medium text-slate-500 hover:text-slate-800"
  }`;
}

/**
 * Horizontal area selector.
 * areaKey / onChange 계약은 기존 AptAreaSelect와 동일. dropdown trigger 없음.
 */
export function AptAreaSelector({
  areas,
  value,
  onChange,
}: AptAreaSelectorProps) {
  const items = useMemo<AreaNavItem[]>(
    () => [
      { key: "all", label: "전체", exclusiveArea: null },
      ...buildAreaNavItems(areas),
    ],
    [areas],
  );

  const selected = items.find((item) => item.key === value) ?? items[0];
  const moreId = useId();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  const measureRef = useRef<HTMLDivElement>(null);
  const desktopRowRef = useRef<HTMLDivElement>(null);
  const mobileRowRef = useRef<HTMLDivElement>(null);
  const [desktopVisible, setDesktopVisible] = useState(items.length);

  useLayoutEffect(() => {
    const measureEl = measureRef.current;
    const rowEl = desktopRowRef.current;
    if (!measureEl || !rowEl) return;

    function measure() {
      if (!measureEl || !rowEl) return;
      const available = rowEl.clientWidth;
      const kids = [
        ...measureEl.querySelectorAll<HTMLElement>("[data-measure-item]"),
      ];
      if (kids.length === 0) {
        setDesktopVisible(items.length);
        return;
      }
      const moreBtn =
        measureEl.querySelector<HTMLElement>("[data-measure-more]");
      const moreW = moreBtn?.offsetWidth ?? 52;
      const gap = 4;
      const widths = kids.map((el) => el.offsetWidth);
      const total =
        widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, widths.length - 1);

      if (total <= available) {
        setDesktopVisible(items.length);
        return;
      }

      let used = 0;
      let fit = 0;
      for (let i = 0; i < widths.length; i++) {
        const w = widths[i]!;
        const next = used + (fit > 0 ? gap : 0) + w;
        if (next + gap + moreW > available && fit > 0) break;
        used = next;
        fit += 1;
      }
      setDesktopVisible(Math.max(1, Math.min(fit, items.length)));
    }

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(rowEl);
    return () => ro.disconnect();
  }, [items]);

  useEffect(() => {
    if (!moreOpen) return;
    function onPointer(e: MouseEvent) {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  useEffect(() => {
    const row = mobileRowRef.current;
    if (!row) return;
    const active = row.querySelector<HTMLElement>(
      `[data-area-key="${CSS.escape(value)}"]`,
    );
    if (!active) return;
    const rowRect = row.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    if (itemRect.left < rowRect.left) {
      row.scrollLeft -= rowRect.left - itemRect.left + 12;
    } else if (itemRect.right > rowRect.right) {
      row.scrollLeft += itemRect.right - rowRect.right + 12;
    }
  }, [value, items]);

  const fitCount = Math.max(1, Math.min(desktopVisible, items.length));
  const selectedIdx = items.findIndex((item) => item.key === value);
  let visibleDesktop = items.slice(0, fitCount);
  let hiddenDesktop = items.slice(fitCount);
  // 선택 item이 더보기에만 있으면 visible 마지막 슬롯으로 끌어와 바로 보이게
  if (
    selectedIdx >= fitCount &&
    selectedIdx < items.length &&
    fitCount < items.length
  ) {
    const selectedItem = items[selectedIdx]!;
    visibleDesktop = [...items.slice(0, fitCount - 1), selectedItem];
    const visibleKeys = new Set(visibleDesktop.map((i) => i.key));
    hiddenDesktop = items.filter((i) => !visibleKeys.has(i.key));
  }
  const selectedHidden = hiddenDesktop.some((item) => item.key === value);

  if (areas.length === 0) {
    return (
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-slate-500">면적</span>
        <span className="text-sm text-slate-800">전체</span>
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-1 overflow-x-clip">
      <div
        className="pointer-events-none fixed top-0 left-0 -z-10 h-0 w-0 overflow-hidden"
        aria-hidden
      >
        <div ref={measureRef} className="flex gap-1 whitespace-nowrap">
          {items.map((item) => (
            <span key={item.key} data-measure-item className={itemClass(false)}>
              {item.label}
            </span>
          ))}
          <span data-measure-more className={itemClass(false)}>
            더보기
          </span>
        </div>
      </div>

      <div className="flex min-w-0 items-end gap-2.5">
        <span className="mb-1 shrink-0 text-xs text-slate-500">면적</span>

        <div
          ref={mobileRowRef}
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label="면적 선택"
        >
          {items.map((item) => {
            const active = item.key === value;
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-area-key={item.key}
                onClick={() => onChange(item.key)}
                className={itemClass(active)}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        <div
          ref={desktopRowRef}
          className="relative hidden min-w-0 flex-1 items-end gap-1 md:flex"
          role="tablist"
          aria-label="면적 선택"
        >
          {visibleDesktop.map((item) => {
            const active = item.key === value;
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onChange(item.key)}
                className={itemClass(active)}
              >
                {item.label}
              </button>
            );
          })}

          {hiddenDesktop.length > 0 ? (
            <div ref={moreRef} className="relative shrink-0">
              <button
                type="button"
                aria-expanded={moreOpen}
                aria-controls={moreId}
                onClick={() => setMoreOpen((v) => !v)}
                className={`inline-flex items-center gap-0.5 ${itemClass(
                  selectedHidden || moreOpen,
                )}`}
              >
                더보기
                <ChevronDown
                  className={`h-3 w-3 text-slate-400 transition ${
                    moreOpen ? "rotate-180" : ""
                  }`}
                  aria-hidden
                />
              </button>
              {moreOpen ? (
                <ul
                  id={moreId}
                  role="listbox"
                  className="absolute top-full right-0 z-40 mt-1 max-h-64 min-w-[7.5rem] overflow-y-auto rounded-md border border-slate-200 bg-white py-0.5 shadow-sm"
                >
                  {hiddenDesktop.map((item) => {
                    const active = item.key === value;
                    return (
                      <li key={item.key} role="option" aria-selected={active}>
                        <button
                          type="button"
                          className={`w-full px-2.5 py-1.5 text-left text-sm tabular-nums ${
                            active
                              ? "bg-slate-100 font-medium text-slate-900"
                              : "text-slate-700 hover:bg-slate-50"
                          }`}
                          onClick={() => {
                            onChange(item.key);
                            setMoreOpen(false);
                          }}
                        >
                          {item.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        {selected?.exclusiveArea != null ? (
          <span className="mb-1 hidden shrink-0 text-xs tabular-nums text-slate-400 lg:inline">
            전용 {selected.exclusiveArea.toFixed(2)}㎡
          </span>
        ) : null}
      </div>

      {selected?.exclusiveArea != null ? (
        <p className="text-[11px] tabular-nums text-slate-400 lg:hidden">
          전용 {selected.exclusiveArea.toFixed(2)}㎡
        </p>
      ) : null}
    </div>
  );
}
