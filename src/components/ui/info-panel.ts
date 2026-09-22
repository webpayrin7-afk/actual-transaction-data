/** Shared ⓘ / info-chip panel placement (viewport-clamped, centered on trigger). */

export const INFO_PANEL_WIDTH = 320;
export const INFO_VIEWPORT_PAD = 8;

export function placeInfoPanel(
  trigger: HTMLElement,
  panel: HTMLElement,
): void {
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(
    INFO_PANEL_WIDTH,
    window.innerWidth - INFO_VIEWPORT_PAD * 2,
  );
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(
    INFO_VIEWPORT_PAD,
    Math.min(left, window.innerWidth - INFO_VIEWPORT_PAD - width),
  );
  panel.style.width = `${width}px`;
  panel.style.left = `${left}px`;
  panel.style.top = `${rect.bottom + 6}px`;
}

export const INFO_PANEL_CLASS =
  "fixed z-[80] max-w-[calc(100vw-1rem)] space-y-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-pretty text-left text-[12px] font-normal leading-5 text-slate-600 shadow-sm";
