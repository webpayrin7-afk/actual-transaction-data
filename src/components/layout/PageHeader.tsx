import type { ReactNode } from "react";

/** 페이지 본문 공통 shell — max-width / padding 정렬 */
export const PAGE_SHELL =
  "mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pt-5 pb-8 sm:px-6 sm:pt-6 sm:pb-10 lg:px-8";

/**
 * 주요 페이지 상단 타이틀 영역.
 * hero/banner 없이 제목·설명·옵션 컨트롤만 통일.
 */
export function PageHeader({
  title,
  description,
  meta,
  children,
  className = "",
}: {
  title: string;
  description: string;
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`max-w-3xl ${className}`.trim()}>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-[1.875rem] sm:leading-tight">
        {title}
      </h1>
      <p className="mt-1.5 text-sm leading-6 text-slate-600 sm:text-[0.9375rem]">
        {description}
      </p>
      {meta ? (
        <div className="mt-2 space-y-0.5 text-xs leading-5 text-slate-500">
          {meta}
        </div>
      ) : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </header>
  );
}
