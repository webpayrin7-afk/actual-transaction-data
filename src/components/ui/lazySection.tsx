"use client";

import { Suspense, lazy, useEffect, type ComponentType, type LazyExoticComponent } from "react";
import { LabSectionLoading } from "@/components/ui/LabLoading";
import { useSectionBoundary } from "@/components/ui/LabSectionBoundary";

/**
 * 아래 섹션 코드 분리용 — next/dynamic 대신 쓰는 이유: 청크 받기가 한 번 실패하면 next/dynamic(React.lazy)은
 * 그 실패를 계속 기억해 LabSectionBoundary의 "다시 시도"가 아무것도 다시 받지 않는다.
 * 여기서는 실패하면 캐시를 비우고 새 lazy를 만들어 두므로, 다시 시도(섹션 재마운트) 때 import()를 새로 부른다.
 * 한 번은 잠깐 기다렸다 스스로 다시 받아 본다(일시적인 네트워크 끊김).
 *
 * 반드시 LabSectionBoundary 안에 두어야 한다 — 실패는 섹션 경계가 잡는다(상세 전체가 깨지지 않게).
 */

const AUTO_RETRY_DELAY_MS = 800;

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export type LazySection<P> = ComponentType<P> & {
  /** 섹션 코드만 미리 받는다(실패해도 조용히 — 마운트 때 다시 받는다). */
  preload: () => Promise<unknown>;
};

/** 섹션 코드를 받는 동안 — 섹션 제목과 "○○ 불러오는 중" */
function SectionChunkLoading() {
  const boundary = useSectionBoundary();
  return <LabSectionLoading title={boundary?.title} minHeight={200} />;
}

/**
 * 섹션 코드가 받아져 실제로 그려지면(Suspense가 풀려 커밋되면) 경계에 알린다 — 다시 시도 횟수를 되돌리게.
 * Suspense 안 형제로 두므로 섹션이 아직 기다리는 중에는 커밋되지 않는다.
 */
function SectionReadySignal() {
  const boundary = useSectionBoundary();
  const onReady = boundary?.onSectionReady;
  useEffect(() => {
    onReady?.();
  }, [onReady]);
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 섹션마다 props 모양이 달라 제네릭으로만 받는다
export function lazySection<P extends Record<string, any>>(
  load: () => Promise<ComponentType<P>>,
): LazySection<P> {
  let pending: Promise<ComponentType<P>> | null = null;

  const loadOnce = (): Promise<ComponentType<P>> => {
    if (!pending) {
      pending = load()
        .catch(async () => {
          await wait(AUTO_RETRY_DELAY_MS);
          return load();
        })
        .catch((err: unknown) => {
          // 실패는 기억하지 않는다 — 다음 시도에서 import()를 새로 부른다.
          pending = null;
          throw err;
        });
    }
    return pending;
  };

  const makeLazy = (): LazyExoticComponent<ComponentType<P>> =>
    lazy(() =>
      loadOnce().then(
        (Component) => ({ default: Component }),
        (err: unknown) => {
          // React.lazy는 거부를 영구히 기억하므로, 다음 마운트는 새 lazy로 받게 바꿔 둔다.
          current = makeLazy();
          throw err;
        },
      ),
    );

  let current = makeLazy();

  function Section(props: P) {
    const Current = current;
    return (
      <Suspense fallback={<SectionChunkLoading />}>
        <Current {...props} />
        <SectionReadySignal />
      </Suspense>
    );
  }

  return Object.assign(Section, {
    preload: () => loadOnce().catch(() => undefined),
  });
}
