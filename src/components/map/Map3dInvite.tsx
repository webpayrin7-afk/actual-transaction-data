"use client";

import { X } from "lucide-react";

/** 한 번 닫거나 3D를 한 번 쓰면 다시 보이지 않는다 (브라우저마다) */
export const MAP_3D_INVITE_KEY = "apt-datalab:map-3d-invite:v1";

export function read3dInviteDone(): boolean {
  try {
    return window.localStorage.getItem(MAP_3D_INVITE_KEY) === "done";
  } catch {
    // 저장소를 못 쓰면(사생활 보호 등) 매번 보이지 않게 — 안내는 없어도 된다
    return true;
  }
}

export function mark3dInviteDone() {
  try {
    window.localStorage.setItem(MAP_3D_INVITE_KEY, "done");
  } catch {
    /* ignore */
  }
}

/**
 * 처음 온 사람에게 한 번 — 2D 서울 화면에서 맨 위 2D | 3D 전환을 가리키는 작은 말풍선.
 * 전환은 조작 줄 맨 앞(모바일은 로고·검색 36px 두 개 뒤, PC는 왼쪽 끝 · 폭 82px)이라, 꼬리는 그 3D 쪽을 가리킨다.
 */
export function Map3dInvite({ onTry, onDismiss }: { onTry: () => void; onDismiss: () => void }) {
  return (
    <div
      className="pointer-events-auto absolute left-3 top-[calc(env(safe-area-inset-top)+52px)] z-30 max-w-[calc(100%-24px)] sm:left-4 sm:top-[56px]"
      role="dialog"
      aria-label="3D 지도 안내"
      data-map-3d-invite
    >
      {/* 꼬리 — 3D 버튼(전환 오른쪽 절반) 아래 */}
      <span
        className="absolute -top-1.5 left-[139px] h-3 sm:left-[52px] w-3 rotate-45 rounded-[2px] bg-[color:var(--lab-navy-950)]"
        aria-hidden
      />
      <div className="relative flex items-center gap-1 rounded-xl bg-[color:var(--lab-navy-950)] py-1.5 pl-3 pr-1 text-white shadow-lg">
        <button
          type="button"
          onClick={onTry}
          className="text-left text-[14px] font-semibold leading-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          서울 전체를 <span className="text-[#5eead4]">3D</span>로 볼 수 있어요
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="안내 닫기"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/80 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
