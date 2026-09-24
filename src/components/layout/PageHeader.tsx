import type { ReactNode } from "react";
import { InfoTip } from "@/components/ui/InfoTip";

/** 페이지 본문 공통 shell — max-width / padding 정렬 */
export const PAGE_SHELL =
  "mx-auto flex w-full max-w-[1440px] flex-col gap-3 px-3 pt-4 pb-8 sm:gap-6 sm:px-6 sm:pt-5 sm:pb-10 lg:px-8 xl:px-10";

/**
 * 하단 메뉴 첫 페이지(제목이 상단바에 있는 페이지) — 모바일 위 여백을 줄인다 (16 → 8).
 * 1차 페이지 탭으로 시작하는 페이지는 PAGE_SHELL_FLUSH (0, 탭이 상단바에 붙는다).
 */
export const PAGE_SHELL_MENU = PAGE_SHELL.replace("pt-4", "pt-2");
export const PAGE_SHELL_FLUSH = PAGE_SHELL.replace("pt-4", "pt-0");

/** 단지상세 — ZIPLAB UI Policy v2 (padding/max-width from .detail-page) */
export const DETAIL_PAGE_SHELL =
  "mx-auto flex w-full detail-page flex-col pt-4 pb-[max(2rem,env(safe-area-inset-bottom))] lg:pt-5 lg:pb-10";

/**
 * BackLink + PageHeader 묶음.
 * shell의 gap과 분리해 돌아가기가 별도 section처럼 벌어지지 않게 함.
 * -mt: SiteHeader에 조금 더 붙이고, gap으로 title과 여유를 둠.
 */
export const PAGE_HEADER_WITH_BACK =
  "-mt-1 flex flex-col gap-2.5 sm:-mt-1.5 sm:gap-3";

/**
 * 주요 페이지 상단 타이틀 영역 (LAB).
 * 별도 배경/카드 없이 페이지 기본 배경 위에 H1·설명·보조정보만 둔다.
 * - action: 제목 오른쪽 (면적 선택 등 compact control)
 * - children: 제목 아래 (검색 폼 등)
 */
/** eyebrow 행 높이(24) + 제목까지 간격(6) — leading(뒤로가기)을 제목 줄에 맞추는 오프셋. */
const EYEBROW_OFFSET = "mt-[30px]";

export function PageHeader({
  title,
  titleSuffix,
  titleTip,
  eyebrow,
  description,
  meta,
  action,
  leading,
  children,
  compact = false,
  showDivider = true,
  titleClassName = "",
  className = "",
  titleInHeader = false,
}: {
  title: string;
  /** Small context text right after the title (e.g. parent region). */
  titleSuffix?: ReactNode;
  /** 제목 바로 뒤 (i)팁 — 섹션 제목(LabSectionHeader)과 같은 규칙: 제목 줄 가운데 정렬, 간격 없이 붙임 */
  titleTip?: ReactNode;
  /** 제목 위 한 줄 (e.g. 학교급 · 설립 · 성별 색 라벨). 24px 높이 행으로 넘긴다. */
  eyebrow?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  /** 제목 왼쪽 (뒤로가기 등). 단지명과 같은 줄에 배치 */
  leading?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
  /** 첫 콘텐츠와 구분하는 얇은 선. 탭이 바로 이어지는 페이지는 false */
  showDivider?: boolean;
  /** Replaces the default title scale. Apt detail passes detail-page-title. */
  titleClassName?: string;
  className?: string;
  /**
   * 하단 메뉴 페이지(시장·지역·단지·분양): 모바일에서는 제목을 사이트 상단바 가운데에 보이고
   * 본문 제목 줄은 숨긴다 (h1은 화면낭독기용으로 남김). sm 이상은 그대로.
   */
  titleInHeader?: boolean;
}) {
  const isDetailTitle = titleClassName.includes("detail-page-title");
  const titleNode = (
    <h1
      className={`min-w-0 tracking-tight text-[color:var(--lab-navy-950)] ${
        titleClassName
          ? titleClassName
          : compact
            ? "text-lg font-semibold leading-6 sm:text-xl sm:leading-7"
            : "text-xl font-semibold leading-7 sm:text-[1.375rem] sm:leading-8"
      }`}
    >
      {title}
      {titleSuffix ? (
        <span className="detail-meta ml-2 inline-block whitespace-nowrap align-baseline font-normal tracking-normal">
          {titleSuffix}
        </span>
      ) : null}
    </h1>
  );
  const heading = titleTip ? (
    <div className="flex min-w-0 items-center">
      {titleNode}
      <InfoTip aria-label={`${title} 안내`}>{titleTip}</InfoTip>
    </div>
  ) : (
    titleNode
  );
  const descriptionNode = description ? (
    <p className="mt-1 text-pretty text-[13px] leading-5 text-[color:var(--lab-muted)] sm:text-sm sm:leading-5">
      {description}
    </p>
  ) : null;
  const metaNode = (spacing: string) =>
    meta ? (
      <div className={`${spacing} space-y-0.5 text-xs leading-5 text-[color:var(--lab-muted)]`}>
        {meta}
      </div>
    ) : null;
  // Leading control box matches the title line height so a 44px back button
  // centers on the first title line instead of the whole block.
  const leadingLine = isDetailTitle
    ? "h-8 lg:h-9"
    : compact
      ? "h-6 sm:h-7"
      : "h-7 sm:h-8";

  // 모바일에서 보이는 것이 없으면 상자를 숨겨(display:none) 페이지 간격(gap)을 먹지 않게.
  // h1은 화면낭독기용으로 absolute(sr-only) 형제로 둔다 — flex 간격에 끼지 않는다.
  const hideOnMobile = titleInHeader && !children;
  return (
    <>
      {titleInHeader ? <h1 className="sr-only sm:hidden">{title}</h1> : null}
    <header
      className={`${isDetailTitle ? "max-w-none" : "max-w-4xl"} ${hideOnMobile ? "hidden sm:block" : ""} ${className}`.trim()}
    >
      <div className={`${titleInHeader ? "hidden sm:flex" : "flex"} items-start justify-between gap-3`}>
        {leading ? (
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <div
              className={`flex shrink-0 items-center ${leadingLine} ${eyebrow ? EYEBROW_OFFSET : ""}`.trim()}
            >
              {leading}
            </div>
            <div className="min-w-0 flex-1">
              {eyebrow ? <div className="mb-1.5 flex h-6 items-center">{eyebrow}</div> : null}
              {heading}
              {descriptionNode}
              {metaNode("mt-1")}
            </div>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            {eyebrow ? <div className="mb-1.5 flex h-6 items-center">{eyebrow}</div> : null}
            {heading}
          </div>
        )}
        {action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
      </div>
      {leading ? null : descriptionNode}
      {leading ? null : metaNode("mt-1.5")}
      {showDivider ? (
        <div
          aria-hidden
          className="mt-2.5 h-px w-full bg-[color:var(--lab-border)]"
        />
      ) : null}
      {children ? <div className={titleInHeader ? "sm:mt-2.5" : "mt-2.5"}>{children}</div> : null}
    </header>
    </>
  );
}
