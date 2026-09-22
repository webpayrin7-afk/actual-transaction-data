"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type LabTabItem<T extends string = string> = {
  id: T;
  label: string;
};

/**
 * ZIPLAB UI Policy v2 §11 — 랩시리즈 공통 segmented family
 * Soft teal selection inside a white bordered shell.
 * - primary: 48px (주요 모드)
 * - secondary: 40px (내부 분류·보기)
 * - compact: 30px visual / 44px touch (보조 조건)
 */
export type LabTabsVariant = "primary" | "secondary" | "compact";

type LabTabsProps<T extends string> = {
  items: readonly LabTabItem<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** Accessible name for the control. */
  ariaLabel: string;
  className?: string;
  /** Optional trailing content (rare). */
  trailing?: ReactNode;
  variant?: LabTabsVariant;
  /**
   * @deprecated Use variant="primary". Kept so older call sites keep compiling.
   */
  density?: "default" | "compact";
  /** Equal-width items (default true for primary/secondary full-width tracks). */
  equalWidth?: boolean;
  /**
   * compact만: null value = 어떤 preset도 활성 아님 (슬라이더 임의 구간).
   * primary/secondary는 항상 선택 필요.
   */
  allowEmpty?: boolean;
  /**
   * When set, tabs get stable ids + aria-controls for paired tabpanels:
   * `${idPrefix}-tab-${id}` / `${idPrefix}-panel-${id}`.
   */
  idPrefix?: string;
};

export function labTabId(idPrefix: string, id: string): string {
  return `${idPrefix}-tab-${id}`;
}

export function labTabPanelId(idPrefix: string, id: string): string {
  return `${idPrefix}-panel-${id}`;
}

function variantClass(variant: LabTabsVariant): string {
  if (variant === "primary") return "lab-tabs lab-tabs--primary";
  if (variant === "compact") return "lab-tabs lab-tabs--compact";
  return "lab-tabs lab-tabs--secondary";
}

function itemClass(
  variant: LabTabsVariant,
  active: boolean,
  equalWidth: boolean,
): string {
  const base =
    variant === "primary"
      ? "lab-tabs__btn lab-tabs__btn--primary"
      : variant === "compact"
        ? "lab-tabs__btn lab-tabs__btn--compact"
        : "lab-tabs__btn lab-tabs__btn--secondary";
  const width = equalWidth ? "lab-tabs__btn--equal" : "";
  const state = active ? "is-active" : "";
  return `${base} ${width} ${state}`.trim();
}

/**
 * Shared LAB Series segmented control (1·2·3차).
 * Track + sliding thumb styles live in `.lab-tabs*` tokens (globals.css).
 */
export function LabTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className = "",
  trailing,
  variant: variantProp,
  density,
  equalWidth: equalWidthProp,
  allowEmpty = false,
  idPrefix,
}: LabTabsProps<T>) {
  // Legacy density=compact on calculator meant denser primary tabs — map to primary.
  const variant: LabTabsVariant =
    variantProp ?? (density === "compact" ? "primary" : "primary");
  const equalWidth =
    equalWidthProp ?? (variant === "compact" ? false : true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const thumbReadyRef = useRef(false);

  const isRadio = variant === "compact";
  const listRole = isRadio ? "radiogroup" : "tablist";

  const syncThumb = useCallback(() => {
    const root = listRef.current;
    const thumb = thumbRef.current;
    if (!root || !thumb) return;

    const active =
      value == null
        ? null
        : Array.from(
            root.querySelectorAll<HTMLElement>("[data-lab-tab]"),
          ).find((el) => el.getAttribute("data-lab-tab-id") === value) ?? null;

    if (!active) {
      thumb.hidden = true;
      thumb.style.width = "0px";
      thumb.style.height = "0px";
      thumb.style.top = "0px";
      thumb.style.transform = "translate3d(0,0,0)";
      return;
    }

    // Pin thumb to the active button box (inherits equal track padding on all sides).
    // Avoid CSS top+bottom on a min-height-only parent — WebKit can resolve bottom unevenly.
    const top = active.offsetTop;
    const left = active.offsetLeft;
    const width = active.offsetWidth;
    const height = active.offsetHeight;
    thumb.hidden = false;
    thumb.style.top = `${top}px`;
    thumb.style.height = `${height}px`;
    thumb.style.width = `${width}px`;
    thumb.style.transform = `translate3d(${left}px,0,0)`;

    // Enable motion only after the first measured paint (avoids SSR/hydration jump).
    if (!thumbReadyRef.current) {
      thumbReadyRef.current = true;
      requestAnimationFrame(() => {
        thumb.classList.add("is-ready");
      });
    }
  }, [value]);

  useLayoutEffect(() => {
    syncThumb();
    const root = listRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncThumb());
    ro.observe(root);
    for (const btn of root.querySelectorAll("[data-lab-tab]")) {
      ro.observe(btn);
    }
    window.addEventListener("resize", syncThumb);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", syncThumb);
    };
  }, [syncThumb, items, equalWidth, variant]);

  const focusAt = useCallback((index: number) => {
    const root = listRef.current;
    if (!root) return;
    const buttons = root.querySelectorAll<HTMLButtonElement>("[data-lab-tab]");
    const btn = buttons[index];
    btn?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
      if (!keys.includes(event.key)) return;
      if (items.length === 0) return;

      const currentIndex = Math.max(
        0,
        items.findIndex((item) => item.id === value),
      );
      let next = currentIndex;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        next = (currentIndex + 1) % items.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        next = (currentIndex - 1 + items.length) % items.length;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = items.length - 1;
      }
      event.preventDefault();
      const nextId = items[next]?.id;
      if (nextId != null) {
        onChange(nextId);
        focusAt(next);
      }
    },
    [focusAt, items, onChange, value],
  );

  return (
    <div
      ref={listRef}
      className={`${variantClass(variant)} ${className}`.trim()}
      role={listRole}
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      <span
        ref={thumbRef}
        className="lab-tabs__thumb"
        aria-hidden
        hidden
      />
      {items.map((item) => {
        const active = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            data-lab-tab=""
            data-lab-tab-id={item.id}
            id={idPrefix ? labTabId(idPrefix, item.id) : undefined}
            role={isRadio ? "radio" : "tab"}
            aria-checked={isRadio ? active : undefined}
            aria-selected={!isRadio ? active : undefined}
            aria-controls={
              idPrefix && !isRadio ? labTabPanelId(idPrefix, item.id) : undefined
            }
            tabIndex={
              active || (allowEmpty && value == null && item === items[0])
                ? 0
                : -1
            }
            className={itemClass(variant, active, equalWidth)}
            onClick={() => onChange(item.id)}
          >
            <span className="lab-tabs__label">{item.label}</span>
          </button>
        );
      })}
      {trailing}
    </div>
  );
}
