import type { ReactNode } from "react";

/** 페이지 본문 공통 shell — max-width / padding 정렬 */
export const PAGE_SHELL =
  "mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pt-5 pb-8 sm:px-6 sm:pt-6 sm:pb-10 lg:px-8";

/**
 * BackLink + PageHeader 묶음.
 * shell의 gap-6과 분리해 돌아가기가 별도 section처럼 벌어지지 않게 함.
 * -mt: SiteHeader에 조금 더 붙이고, gap으로 title과 여유를 둠.
 */
export const PAGE_HEADER_WITH_BACK =
  "-mt-2 flex flex-col gap-4 sm:-mt-2.5 sm:gap-5";

/**
 * 주요 페이지 상단 타이틀 영역.
 * hero/banner 없이 제목·설명·옵션 컨트롤만 통일.
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
  description?: string;
  meta?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <header className={`max-w-3xl ${className}`.trim()}>
      <div className="flex items-start justify-between gap-3">
        <h1
          className={`min-w-0 flex-1 font-semibold tracking-tight text-slate-900 ${
            compact
              ? "text-xl leading-7 sm:text-2xl sm:leading-8"
              : "text-2xl sm:text-[1.875rem] sm:leading-tight"
          }`}
        >
          {title}
        </h1>
        {action ? (
          <div className="shrink-0 pt-0.5 sm:pt-1">{action}</div>
        ) : null}
      </div>
      {description ? (
        <p className="mt-1.5 text-pretty text-sm leading-6 text-slate-600 sm:text-[0.9375rem]">
          {description}
        </p>
      ) : null}
      {meta ? (
        <div className="mt-2 space-y-0.5 text-xs leading-5 text-slate-500">
          {meta}
        </div>
      ) : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </header>
  );
}
