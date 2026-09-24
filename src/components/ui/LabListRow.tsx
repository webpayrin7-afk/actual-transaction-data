import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

/**
 * 클릭 가능한 목록 행 (policy §12.5): 이름·보조 왼쪽, 값·보조 오른쪽, 화살표.
 * `<ul className={LAB_LIST}>` 안에서 사용한다.
 */
export const LAB_LIST = "divide-y divide-[color:var(--lab-border)]";

export function LabListRow({
  href,
  onClick,
  selected,
  title,
  meta,
  value,
  sub,
  valueTone,
  wrap = false,
  children,
}: {
  href?: string | null;
  /** In-page action row (button) — e.g. choose this 평형. Ignored when `href` is set. */
  onClick?: () => void;
  /** Current choice among clickable rows (aria-pressed + brand ink on title). */
  selected?: boolean;
  title: ReactNode;
  meta?: ReactNode;
  value?: ReactNode;
  sub?: ReactNode;
  valueTone?: "up" | "down";
  /** 긴 행: 제목 두 줄까지, 보조 문구는 자르지 않고 줄바꿈 (거래 목록 등) */
  wrap?: boolean;
  /** Extra full-width line under the row (e.g. a share bar). */
  children?: ReactNode;
}) {
  const toneStyle =
    valueTone === "down"
      ? { color: "var(--lab-change-down)" }
      : valueTone === "up"
        ? { color: "var(--lab-change-up)" }
        : undefined;
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <p
          className={`detail-data-value-emphasis ${wrap ? "line-clamp-2 break-keep" : "truncate"}`}
          style={selected ? { color: "var(--lab-brand-primary)" } : undefined}
        >
          {title}
        </p>
        {meta ? <div className={`detail-meta ${wrap ? "break-keep" : "truncate"}`}>{meta}</div> : null}
        {children}
      </div>
      {value != null ? (
        <div className="shrink-0 text-right">
          <p
            className="detail-data-value-emphasis whitespace-nowrap tabular-nums"
            style={toneStyle}
          >
            {value}
          </p>
          {sub ? <p className="detail-meta whitespace-nowrap tabular-nums">{sub}</p> : null}
        </div>
      ) : null}
      {href ? <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden /> : null}
    </>
  );
  const cls = "flex min-h-11 items-center gap-3 py-2.5";
  return (
    <li>
      {href ? (
        <Link href={href} className={`${cls} hover:bg-slate-50`}>
          {body}
        </Link>
      ) : onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-pressed={selected ?? false}
          className={`${cls} w-full text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)]`}
        >
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

/** 청록 텍스트 링크 (보조 이동: 계산기·공고 보기 등). */
export function LabTextLink({
  href,
  children,
  external = false,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  const cls =
    "inline-flex min-h-[44px] items-center gap-0.5 self-start text-[14px] font-semibold leading-5 hover:underline";
  const style = { color: "var(--lab-brand-primary)" };
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls} style={style}>
        {children}
        <ChevronRight className="h-4 w-4" aria-hidden />
      </a>
    );
  }
  return (
    <Link href={href} className={cls} style={style}>
      {children}
      <ChevronRight className="h-4 w-4" aria-hidden />
    </Link>
  );
}
