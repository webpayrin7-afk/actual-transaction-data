"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LabTag } from "@/components/ui/LabTag";
import { HOME_QUICK_NAV } from "@/lib/nav/home-quick-nav";

const EASE = "duration-200 ease-out";

/**
 * 홈 바로가기 카드 (모바일, 홈 본문 첫 카드) — 오늘의 시장 강조 타일 + 지도 가로 타일 + 3칸.
 * 고정 바가 아니다: 다른 페이지에서는 헤더 메뉴(드로어)로 이동한다.
 */
export function HomeNavigation() {
  const pathname = usePathname();

  return (
    <nav aria-label="바로가기" className="sm:hidden">
      <div className="mx-auto grid w-full max-w-[1440px] grid-cols-[minmax(0,0.28fr)_repeat(3,minmax(0,0.24fr))] grid-rows-[auto_auto] gap-1.5">
        {HOME_QUICK_NAV.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          const disabled = !item.href || Boolean(item.disabled);
          const featured = item.id === "market";
          const isMap = item.id === "map";

          const placement =
            item.id === "market"
              ? "col-start-1 row-span-2 row-start-1"
              : item.id === "map"
                ? "col-span-3 col-start-2 row-start-1"
                : item.id === "regions"
                  ? "col-start-2 row-start-2"
                  : item.id === "complexes"
                    ? "col-start-3 row-start-2"
                    : "col-start-4 row-start-2";

          // 정책 §4·§11: 선택 = brand-subtle 면 + teal 글자, 비선택 = surface-subtle + navy.
          const tone = disabled
            ? "cursor-not-allowed border-[color:var(--lab-border)] bg-[color:var(--lab-surface-subtle)] text-[color:var(--lab-muted)]"
            : active
              ? "border-[color:var(--lab-brand-border)] bg-[color:var(--lab-brand-subtle)] text-[color:var(--lab-teal-700)]"
              : "border-[color:var(--lab-border)] bg-[color:var(--lab-surface-subtle)] text-[color:var(--lab-navy-950)]";

          // 정책 §5: 카드·타일 radius 12. 터치 영역 44 이상.
          const shape = featured
              ? "min-h-[104px] h-full flex-col gap-1.5 px-1.5 py-2"
              : isMap
                ? "min-h-[48px] flex-row gap-2 px-3"
                : "min-h-[56px] flex-col gap-1 px-1 py-1.5";

          const className = [
            "flex min-w-0 items-center justify-center rounded-xl border",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)]",
            `transition-[background-color,color,border-color] ${EASE} motion-reduce:transition-none`,
            tone,
            shape,
            placement,
          ].join(" ");

          const label = item.label;
          const iconCls = "h-5 w-5 stroke-[1.75]";
          // 정책 §3·§11: 컨트롤 14/20. 선택 600 / 비선택 500.
          const labelCls = [
            "max-w-full truncate text-center",
            active ? "font-semibold" : "font-medium",
            "text-[14px] leading-5",
          ].join(" ");

          const body = (
            <>
              <span className="inline-flex shrink-0">
                <Icon className={iconCls} aria-hidden />
              </span>
              <span className={labelCls}>{label}</span>
              {isMap && disabled ? (
                <LabTag>{item.disabledHint ?? "준비중"}</LabTag>
              ) : null}
            </>
          );

          if (disabled) {
            return (
              <div
                key={item.id}
                className={className}
                aria-disabled="true"
                title={item.disabledHint ?? "준비중"}
              >
                {body}
              </div>
            );
          }

          return (
            <Link
              key={item.id}
              href={item.href!}
              aria-current={active ? "page" : undefined}
              className={className}
            >
              {body}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
