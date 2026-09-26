"use client";

/**
 * 한 줄 선택 칩 — 가로 스크롤, 바로 눌러 고른다 (지역 선택 등, 시트를 열지 않음).
 * 선택 = 청록 테두리·옅은 청록 면·청록 글자. 시각 32px + 숨은 영역으로 44px 터치.
 */
export function LabChoiceChips<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = "",
}: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      className={`lab-bleed flex gap-1.5 overflow-x-auto overflow-y-hidden py-0.5 ${className}`.trim()}
      role="radiogroup"
      style={{ scrollbarWidth: "none" }}
      aria-label={ariaLabel}
    >
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={`relative inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-[14px] leading-5 before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] ${
              on
                ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] font-semibold text-[color:var(--lab-teal-700)]"
                : "border-[color:var(--lab-border)] bg-white font-medium text-[color:var(--lab-navy-950)]"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
