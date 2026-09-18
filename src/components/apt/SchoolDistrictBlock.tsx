"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { LabBottomSheet } from "@/components/ui/LabBottomSheet";
import {
  formatDistrictDistance,
  type ProductSchoolDistrict,
} from "@/lib/complex-detail/school-district";

/**
 * Compact school-district info layer (not a nearby-school list).
 * Membership list opens only via bottom sheet.
 */
export function SchoolDistrictBlock({
  district,
  onOpenSchool,
}: {
  district: ProductSchoolDistrict;
  onOpenSchool: (s: {
    schoolCode: string | null;
    name: string;
    level: string;
    address: string | null;
  }) => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!district.memberCount) return null;

  return (
    <div
      className="mt-0"
      data-testid="school-district-block"
      data-district-id={district.id}
      data-district-preview-count="0"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[14px] font-semibold tracking-tight text-slate-800">
          {district.officialName}
        </p>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="shrink-0 text-[13px] font-medium text-[var(--lab-teal-700)] hover:underline"
        >
          학교군 전체 보기
        </button>
      </div>
      <p className="mt-0.5 text-[11px] leading-4 text-slate-500">
        {district.description}
      </p>

      <LabBottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={`${district.officialName} (${district.memberCount}개교)`}
        doneLabel="닫기"
        hideHeaderDivider
        compactBodyTop
      >
        <p className="text-[11px] leading-4 text-slate-500">
          학교군 소속 학교는 실제 배정학교를 의미하지 않습니다.
        </p>
        <ul className="mt-2 space-y-0" data-testid="school-district-sheet-list">
          {district.members.map((m) => (
            <li key={`all-${m.schoolCode ?? m.name}`}>
              <DistrictSchoolRow
                name={m.name}
                establishment={m.establishment}
                distanceM={m.distanceM}
                linkable={m.detailLinkable}
                onClick={() => {
                  setSheetOpen(false);
                  onOpenSchool({
                    schoolCode: m.schoolCode,
                    name: m.name,
                    level: district.level,
                    address: null,
                  });
                }}
              />
            </li>
          ))}
        </ul>
      </LabBottomSheet>
    </div>
  );
}

function DistrictSchoolRow({
  name,
  establishment,
  distanceM,
  linkable,
  onClick,
}: {
  name: string;
  establishment: string;
  distanceM: number | null;
  linkable: boolean;
  onClick: () => void;
}) {
  const dist = formatDistrictDistance(distanceM);
  const meta = [establishment, dist].filter(Boolean).join(" · ");

  if (!linkable) {
    return (
      <div className="rounded-lg px-2.5 py-[5px]">
        <p className="truncate text-[13px] font-medium text-slate-800">{name}</p>
        {meta ? (
          <p className="mt-0.5 text-[10px] text-slate-500">{meta}</p>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${name} 상세 보기`}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-[5px] text-left transition active:scale-[0.99] active:bg-slate-100 hover:bg-slate-50"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-slate-800">
          {name}
        </span>
        {meta ? (
          <span className="mt-0.5 block text-[10px] text-slate-500">{meta}</span>
        ) : null}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
    </button>
  );
}
