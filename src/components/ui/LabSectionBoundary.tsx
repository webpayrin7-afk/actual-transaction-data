"use client";

import { Component, type ReactNode } from "react";
import { LabSection } from "@/components/ui/LabSection";

/**
 * 섹션 단위 오류 경계 (policy §8): 부가 섹션이 실패해도 상세 전체를 대체하지 않는다.
 * 실패한 섹션만 제목 + 오류 문구 + 다시 시도로 바꾸고, 나머지 섹션은 유지한다.
 */
export class LabSectionBoundary extends Component<
  { id?: string; title: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[LabSectionBoundary] ${this.props.title}`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <LabSection id={this.props.id} title={this.props.title}>
        <p className="lab-state lab-state-error">
          이 영역을 불러오지 못했습니다. 다른 정보는 그대로 볼 수 있습니다.
        </p>
        <button
          type="button"
          className="lab-button lab-button-secondary w-full"
          onClick={() => this.setState({ failed: false })}
        >
          다시 시도
        </button>
      </LabSection>
    );
  }
}
