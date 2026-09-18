"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { LabBottomSheet } from "@/components/ui/LabBottomSheet";
import { formatDistrictDistance } from "@/lib/complex-detail/school-district";
import type { ProductAttendanceZone } from "@/lib/complex-detail/attendance-zone";

/**
 * Compact elementary attendance-zone info (not a nearby-school list).
 */
export function AttendanceZoneBlock({
  zone,
  onOpenSchool,
}: {
  zone: ProductAttendanceZone;
  onOpenSchool: (s: {
    schoolCode: string | null;
    name: string;
    level: string;
    address: string | null;
  }) => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  if (!zone.designatedSchools.length) return null;

  return (
    <div
      className="mt-0"
      data-testid="attendance-zone-block"
      data-zone-id={zone.id}
      data-zone-kind={zone.zoneKind}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[14px] font-semibold tracking-tight text-slate-800">
          {zone.officialName}
        </p>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="shrink-0 text-[13px] font-medium text-[var(--lab-teal-700)] hover:underline"
        >
          {zone.ctaLabel}
        </button>
      </div>
      <p className="mt-0.5 text-[11px] leading-4 text-slate-500">
        {zone.description}
      </p>
      <div
        className="mx-2.5 mt-2.5 h-px bg-slate-200"
        role="separator"
        aria-hidden
      />

      <LabBottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={zone.officialName}
        doneLabel="닫기"
        hideHeaderDivider
        compactBodyTop
      >
        {zone.zoneKind === "joint" ? (
          <p className="text-[12px] text-slate-500">
            {`공동통학구역 · ${zone.designatedSchools.length}개교`}
          </p>
        ) : null}
        <p
          className={`text-[11px] leading-4 text-slate-500 ${
            zone.zoneKind === "joint" ? "mt-1" : ""
          }`}
        >
          {zone.infoText}
        </p>
        <ul className="mt-4 space-y-0" data-testid="attendance-zone-sheet-list">
          {zone.designatedSchools.map((m) => {
            const dist = formatDistrictDistance(m.distanceM);
            const meta = [m.establishment, dist].filter(Boolean).join(" · ");
            return (
              <li key={`az-${m.schoolCode ?? m.name}`}>
                {m.detailLinkable ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSheetOpen(false);
                      onOpenSchool({
                        schoolCode: m.schoolCode,
                        name: m.name,
                        level: "elementary",
                        address: m.roadAddress,
                      });
                    }}
                    aria-label={`${m.name} 상세 보기`}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-[5px] text-left transition active:scale-[0.99] active:bg-slate-100 hover:bg-slate-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-slate-800">
                        {m.name}
                      </span>
                      {meta ? (
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          {meta}
                        </span>
                      ) : null}
                    </span>
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-slate-400"
                      aria-hidden
                    />
                  </button>
                ) : (
                  <div className="rounded-lg px-2.5 py-[5px]">
                    <p className="truncate text-[13px] font-medium text-slate-800">
                      {m.name}
                    </p>
                    {meta ? (
                      <p className="mt-0.5 text-[10px] text-slate-500">{meta}</p>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </LabBottomSheet>
    </div>
  );
}
