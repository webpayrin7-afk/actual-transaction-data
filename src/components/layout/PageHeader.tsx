import type { ReactNode } from "react";

/** 페이지 본문 공통 shell — max-width / padding 정렬 */
export const PAGE_SHELL =
  "mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-4 pt-4 pb-8 sm:gap-6 sm:px-6 sm:pt-5 sm:pb-10 lg:px-8 xl:px-10";

/**
 * BackLink + PageHeader 묶음.
 * shell의 gap과 분리해 돌아가기가 별도 section처럼 벌어지지 않게 함.
 * -mt: SiteHeader에 조금 더 붙이고, gap으로 title과 여유를 둠.
 */
export const PAGE_HEADER_WITH_BACK =
  "-mt-1 flex flex-col gap-2.5 sm:-mt-1.5 sm:gap-3";

/**
 * 주요 페이지 상단 타이틀 영역 (LAB).
 * hero/banner 없이 제목·설명·옵션 컨트롤만 컴팩트하게 통일.
 * - action: 제목 오른쪽 (면적 선택 등 compact control)
 * - children: 제목 아래 (검색 폼 등)
 */
export function PageHeader({
  title,
  description,
  meta,
  action,
  children,
  compact = false,
  className = "",
}: {
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <header
      className={`max-w-4xl border-b border-slate-200/70 pb-3.5 sm:pb-4 ${className}`.trim()}
    >
      <div className="flex items-start justify-between gap-3">
        <h1
          className={`min-w-0 flex-1 font-semibold tracking-tight text-slate-900 ${
            compact
              ? "text-lg leading-6 sm:text-xl sm:leading-7"
              : "text-xl leading-7 sm:text-[1.375rem] sm:leading-8"
          }`}
        >
          {title}
        </h1>
        {action ? (
          <div className="shrink-0 pt-0.5">{action}</div>
        ) : null}
      </div>
      {description ? (
        <p className="mt-1 text-pretty text-[13px] leading-5 text-slate-500 sm:text-sm sm:leading-5">
          {description}
        </p>
      ) : null}
      {meta ? (
        <div className="mt-1.5 space-y-0.5 text-xs leading-5 text-slate-500">
          {meta}
        </div>
      ) : null}
      {children ? <div className="mt-3">{children}</div> : null}
    </header>
  );
}
