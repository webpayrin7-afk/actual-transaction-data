"use client";

import { Component, createContext, useContext, type ReactNode } from "react";
import { LabSection } from "@/components/ui/LabSection";
import { LazyMountWhenNear } from "@/components/ui/LazyMountWhenNear";

type SectionBoundaryContextValue = {
  /** 섹션 제목 — 로딩 자리에 "○○ 불러오는 중"으로 쓴다 */
  title: string;
  /** 로딩 자리(섹션 틀) 최소 높이(px) — 불러온 뒤 높이와 비슷하게 */
  placeholderMinHeight?: number;
  /** 섹션이 실제로 그려졌음을 알린다(lazySection) — 다시 시도 횟수를 0으로 되돌린다 */
  onSectionReady: () => void;
};

const SectionBoundaryContext = createContext<SectionBoundaryContextValue | null>(null);

/** 가장 가까운 LabSectionBoundary의 제목·준비 알림 */
export function useSectionBoundary(): SectionBoundaryContextValue | null {
  return useContext(SectionBoundaryContext);
}

/**
 * 섹션 단위 오류 경계 (policy §8): 부가 섹션이 실패해도 상세 전체를 대체하지 않는다.
 * 실패한 섹션만 제목 + 오류 문구 + 다시 시도로 바꾸고, 나머지 섹션은 유지한다.
 *
 * `mountWhenNear`: 화면 가까이(약 1200px) 오거나 LazyMountProvider가 차례를 줄 때 섹션을 마운트한다 —
 * 첫 방문 첫 화면에서 아래 섹션 요청이 한꺼번에 나가지 않게(LazyMountWhenNear).
 *
 * 다시 시도: 섹션을 새로 마운트한다 — lazySection으로 나눈 섹션은 이때 import()를 새로 부른다.
 * 섹션 코드(청크) 받기가 다시 시도 뒤에도 또 실패하면(배포가 바뀌어 옛 청크가 없어진 경우 등) 페이지를 새로 고친다.
 * 다시 시도로 섹션이 제대로 뜨면 횟수를 0으로 되돌린다 — 나중에 또 실패해도 먼저 한 번은 새로 고침 없이 다시 받아 본다.
 */
function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || /Loading chunk|Failed to load chunk|dynamically imported module/i.test(error.message);
}

export class LabSectionBoundary extends Component<
  {
    id?: string;
    title: string;
    children: ReactNode;
    mountWhenNear?: boolean;
    /** 마운트 전 자리(섹션 로딩) 최소 높이(px) */
    placeholderMinHeight?: number;
  },
  { failed: boolean; chunkError: boolean; retries: number }
> {
  state = { failed: false, chunkError: false, retries: 0 };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, chunkError: isChunkLoadError(error) };
  }

  componentDidCatch(error: unknown) {
    console.error(`[LabSectionBoundary] ${this.props.title}`, error);
  }

  private onSectionReady = () => {
    if (this.state.retries !== 0) this.setState({ retries: 0 });
  };

  private contextValue: SectionBoundaryContextValue | null = null;

  private getContextValue(): SectionBoundaryContextValue {
    if (
      !this.contextValue ||
      this.contextValue.title !== this.props.title ||
      this.contextValue.placeholderMinHeight !== this.props.placeholderMinHeight
    ) {
      this.contextValue = {
        title: this.props.title,
        placeholderMinHeight: this.props.placeholderMinHeight,
        onSectionReady: this.onSectionReady,
      };
    }
    return this.contextValue;
  }

  private retry = () => {
    if (this.state.chunkError && this.state.retries >= 1 && typeof window !== "undefined") {
      window.location.reload();
      return;
    }
    this.setState((s) => ({ failed: false, chunkError: false, retries: s.retries + 1 }));
  };

  render() {
    if (!this.state.failed) {
      return (
        <SectionBoundaryContext.Provider value={this.getContextValue()}>
          {this.props.mountWhenNear ? (
            <LazyMountWhenNear
              id={this.props.id}
              title={this.props.title}
              placeholderMinHeight={this.props.placeholderMinHeight}
            >
              {this.props.children}
            </LazyMountWhenNear>
          ) : (
            this.props.children
          )}
        </SectionBoundaryContext.Provider>
      );
    }
    return (
      <LabSection id={this.props.id} title={this.props.title}>
        <p className="lab-state lab-state-error">
          이 영역을 불러오지 못했습니다. 다른 정보는 그대로 볼 수 있습니다.
        </p>
        <button
          type="button"
          className="lab-button lab-button-secondary w-full"
          onClick={this.retry}
        >
          다시 시도
        </button>
      </LabSection>
    );
  }
}
