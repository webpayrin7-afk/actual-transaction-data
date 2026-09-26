"use client";

/**
 * 2D | 3D 지도 전환 — 지도로 찾기 맨 위 줄(거래유형 줄) 왼쪽 끝에 고정. 그 줄은 2D·3D 화면 위에 한 번만 그려
 * 두 화면에서 자리·크기가 똑같다 (MapSearchPage). 뒤의 칩들만 옆으로 밀린다.
 */
export type MapViewMode = "2d" | "3d";

export function MapViewSwitch({ mode, onChange }: { mode: MapViewMode; onChange: (mode: MapViewMode) => void }) {
  return (
    <div
      className="inline-flex h-9 shrink-0 rounded-full border border-[color:var(--lab-navy-950)] bg-[color:var(--lab-surface)] p-0.5 shadow-sm"
      role="group"
      aria-label="지도 보기 방식"
    >
      {(
        [
          ["2d", "2D", "2D 지도로 보기"],
          ["3d", "3D", "3D 지도로 보기 (서울)"],
        ] as const
      ).map(([id, label, aria]) => (
        <button
          key={id}
          type="button"
          aria-pressed={mode === id}
          aria-label={aria}
          onClick={() => {
            if (mode !== id) onChange(id);
          }}
          className={`relative rounded-full px-3.5 text-[14px] leading-5 transition-colors before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] ${
            mode === id
              ? "bg-[color:var(--lab-navy-950)] font-semibold text-white"
              : "font-medium text-[color:var(--lab-navy-950)]"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
