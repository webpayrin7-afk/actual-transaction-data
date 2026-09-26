"use client";

import { useEffect, useRef, useState } from "react";
import { LAB_SECTION_SURFACE } from "@/components/ui/LabSection";

/**
 * 가로 진행 막대 — 끝을 모르는 로딩(서버 응답 대기)용. 청록 막대가 왼→오로 흐른다.
 * 동작 줄이기(prefers-reduced-motion)에서는 흐름 대신 은은하게 깜빡인다.
 */
export function LabIndeterminateBar({ className = "" }: { className?: string }) {
  return (
    <div
      className={`lab-progress-track relative h-1 w-full overflow-hidden rounded-full ${className}`}
      role="progressbar"
      aria-busy="true"
      aria-valuetext="불러오는 중"
    >
      <div className="lab-progress-runner absolute inset-y-0 left-0 w-2/5 rounded-full" />
    </div>
  );
}

/** 점 세 개가 차례로 튀는 로딩 표시 (●●●) */
export function LabLoadingDots({ className = "" }: { className?: string }) {
  return (
    <span className={`lab-dots inline-flex items-center gap-1.5 ${className}`} role="progressbar" aria-busy="true" aria-valuetext="불러오는 중">
      <span className="lab-dot" />
      <span className="lab-dot" />
      <span className="lab-dot" />
    </span>
  );
}

/** 아주 빨리 끝나는 로딩은 번쩍이지 않게 0.25초 뒤에만 보인다 */
function useDelayedShow(ms = 250): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShown(true), ms);
    return () => window.clearTimeout(t);
  }, [ms]);
  return shown;
}

/** 로딩 자리 가운데 — 진행 막대 + 점 세 개 + "○○ 불러오는 중…" */
function LabLoadingBody({ text, shown }: { text: string; shown: boolean }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 transition-opacity duration-200"
      style={{ opacity: shown ? 1 : 0 }}
    >
      <LabIndeterminateBar className="max-w-32" />
      <LabLoadingDots className="mt-1" />
      <p className="detail-meta">{text}…</p>
    </div>
  );
}

/**
 * 데이터 자리 로딩 — 섹션 틀(제목·탭·표 머리 등)은 그대로 그려 두고, 데이터가 들어갈 자리에만 넣는다.
 * 회색 빈 상자 대신 진행 막대 · 점 세 개 · "○○ 불러오는 중…".
 */
export function LabDataLoading({
  label = "불러오는 중",
  minHeight = 96,
  className = "",
}: {
  label?: string;
  minHeight?: number;
  className?: string;
}) {
  const shown = useDelayedShow();
  return (
    <div
      className={`flex flex-col items-center justify-center ${className}`}
      style={{ minHeight }}
      aria-busy="true"
      aria-live="polite"
    >
      <LabLoadingBody text={label} shown={shown} />
    </div>
  );
}

/**
 * 섹션 로딩 — 섹션 카드 틀(제목 포함)을 바로 그리고, 안에서 진행 막대가 돈다.
 * 페이지 전체를 막지 않고 섹션마다 따로 채워질 때 쓴다(데이터·코드를 아직 받는 중인 섹션 자리).
 */
export function LabSectionLoading({
  id,
  title,
  label,
  minHeight = 160,
  className = "",
}: {
  /** 섹션 탭·앵커용 id (진짜 섹션과 같은 id) */
  id?: string;
  /** 섹션 제목 (있으면 카드 머리에) */
  title?: string;
  /** "관리비 불러오는 중" 처럼 — 없으면 "{title} 불러오는 중" */
  label?: string;
  minHeight?: number;
  className?: string;
}) {
  const shown = useDelayedShow();
  const text = label ?? (title ? `${title} 불러오는 중` : "불러오는 중");
  return (
    <section
      id={id}
      aria-label={title}
      className={`${LAB_SECTION_SURFACE} flex scroll-mt-28 flex-col gap-3 ${className}`.trim()}
      style={{ minHeight }}
      aria-busy="true"
      aria-live="polite"
    >
      {title ? <h2 className="detail-section-title">{title}</h2> : null}
      {/* 위쪽에 둔다 — 높은 틀(시세 등)에서도 로딩이 첫 화면 안에 보이게 */}
      <div className="flex flex-col items-center pt-10 pb-6">
        <LabLoadingBody text={text} shown={shown} />
      </div>
    </section>
  );
}

/**
 * 화면 맨 위 진행 막대 — 페이지 이동 동안만(섹션 데이터 로딩은 섹션 안에서 보인다).
 * 시작하면 빠르게 30%까지, 이후 90%를 향해 천천히 차오르고, 끝나면 100%로 채운 뒤 사라진다.
 */
export function LabTopProgress({ active, label }: { active: boolean; label?: string | null }) {
  const [pct, setPct] = useState(0);
  const [visible, setVisible] = useState(false);
  const [showLabel, setShowLabel] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current) window.clearInterval(timer.current);
    if (active) {
      const raf = window.requestAnimationFrame(() => {
        setVisible(true);
        setPct((p) => (p > 0 && p < 100 ? Math.max(p, 30) : 30));
      });
      timer.current = window.setInterval(() => {
        // 90%를 향해 남은 거리의 일부씩 — 오래 걸려도 멈춘 듯 보이지 않게
        setPct((p) => (p >= 90 ? p : p + (90 - p) * 0.08));
      }, 300);
      const lt = window.setTimeout(() => setShowLabel(true), 700);
      return () => {
        window.cancelAnimationFrame(raf);
        window.clearTimeout(lt);
        if (timer.current) window.clearInterval(timer.current);
      };
    }
    const fill = window.requestAnimationFrame(() => {
      setShowLabel(false);
      setPct((p) => (p > 0 ? 100 : 0));
    });
    const hide = window.setTimeout(() => {
      setVisible(false);
      setPct(0);
    }, 380);
    return () => {
      window.cancelAnimationFrame(fill);
      window.clearTimeout(hide);
    };
  }, [active]);

  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[200]" role="status" aria-live="polite">
      <div
        className="lab-top-progress h-[3px]"
        style={{
          width: `${pct}%`,
          opacity: pct >= 100 ? 0 : 1,
          transition: "width 280ms ease-out, opacity 300ms ease 80ms",
        }}
      />
      {label && showLabel && active ? (
        <div className="mt-2 flex justify-center">
          <span className="rounded-full bg-[color:var(--lab-navy-950)]/85 px-3 py-1 text-[12px] font-medium leading-4 text-white shadow-md">
            {label}
          </span>
        </div>
      ) : null}
    </div>
  );
}
