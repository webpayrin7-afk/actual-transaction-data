"use client";

import { useEffect, useRef, useState } from "react";

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

/**
 * 섹션 로딩 — 회색 빈 상자 대신, 무엇을 불러오는지와 진행 막대를 보여 준다.
 * 페이지는 먼저 뜨고 아래 섹션만 늦게 채워질 때 쓴다.
 */
export function LabSectionLoading({
  title,
  label,
  minHeight = 160,
  className = "",
}: {
  /** 섹션 제목 (있으면 카드 머리에) */
  title?: string;
  /** "관리비 불러오는 중" 처럼 — 없으면 "{title} 불러오는 중" */
  label?: string;
  minHeight?: number;
  className?: string;
}) {
  // 아주 빨리 끝나는 로딩은 문구가 번쩍이지 않게 0.25초 뒤에만 보인다
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShown(true), 250);
    return () => window.clearTimeout(t);
  }, []);
  const text = label ?? (title ? `${title} 불러오는 중` : "불러오는 중");
  return (
    <section
      className={`section-card flex flex-col ${className}`}
      style={{ minHeight }}
      aria-busy="true"
      aria-live="polite"
    >
      {title ? <h2 className="detail-section-title">{title}</h2> : null}
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2.5 py-6 transition-opacity duration-200"
        style={{ opacity: shown ? 1 : 0 }}
      >
        <LabIndeterminateBar className="max-w-[180px]" />
        <p className="detail-meta">{text}…</p>
      </div>
    </section>
  );
}

/**
 * 화면 맨 위 진행 막대 — 페이지 이동·첫 데이터 로딩 동안.
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
