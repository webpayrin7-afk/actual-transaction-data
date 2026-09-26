"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { BackLink } from "@/components/layout/BackLink";
import { AptAreaSelector } from "@/components/apt/AptAreaSelector";
import { LabStickySectionNav } from "@/components/ui/LabStickySectionNav";
import type { AptAreaOption } from "@/lib/molit/apt-client";

export const APT_SECTIONS = [
  { id: "section-market", label: "시세" },
  // 지역 비교 → 단지 비교가 이어지는 한 흐름. 탭은 첫 섹션으로 점프 (policy §12.3 탭 수 ≤ 6).
  { id: "section-region-rank", label: "비교" },
  { id: "section-nearby-life", label: "생활" },
  { id: "section-nearby-sales", label: "공급" },
  // 계산기는 관리비 바로 위 (화면 순서와 같게)
  { id: "section-calculator", label: "계산기" },
  { id: "section-management", label: "관리비" },
] as const;

const noopSubscribe = () => () => {};

/**
 * 단지 상세의 단일 고정 바: 압축 헤더(뒤로가기 · 단지명 · 면적) + 섹션 탭.
 * 이름과 면적 선택이 한 줄에 들어가지 않으면 면적 선택이 다음 줄로 내려간다.
 */
export function AptStickyNav({
  anchor,
  aptName,
  areas,
  areaKey,
  onAreaChange,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  aptName: string;
  areas: AptAreaOption[];
  areaKey: string;
  onAreaChange: (key: string) => void;
}) {
  // Portaled: the page enter animation leaves a transform on an ancestor, which would pin
  // `position: fixed` to that ancestor instead of the viewport.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  if (!mounted) return null;
  return createPortal(
    <LabStickySectionNav
      anchor={anchor}
      sections={APT_SECTIONS}
      title={aptName}
      ariaLabel={`${aptName} 섹션`}
      titleRow={
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1.5">
          <div className="flex min-h-11 min-w-0 max-w-full flex-[1_1_auto] items-center gap-1">
            <BackLink fallback="/complexes" compact hideLabel />
            <p className="detail-subsection-title min-w-0 truncate" title={aptName}>
              {aptName}
            </p>
          </div>
          <div className="ml-auto min-w-0 max-w-full shrink-0">
            <AptAreaSelector
              areas={areas}
              value={areaKey}
              variant="compact"
              onChange={onAreaChange}
            />
          </div>
        </div>
      }
    />,
    document.body,
  );
}
