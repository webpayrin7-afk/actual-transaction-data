"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { InfoTip } from "@/components/ui/InfoTip";
import { LabBottomSheet } from "@/components/ui/LabBottomSheet";
import {
  SCHOOL_DISTRICT_DEFAULT_VISIBLE,
  formatDistrictDistance,
  type ProductSchoolDistrict,
} from "@/lib/complex-detail/school-district";

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
  const withDistance = district.members.filter((m) => m.distanceM != null);
  const preview = withDistance.slice(0, SCHOOL_DISTRICT_DEFAULT_VISIBLE);
  const showAllCta = district.memberCount > SCHOOL_DISTRICT_DEFAULT_VISIBLE;

  if (!district.memberCount) return null;

  return (
    <div
      className="mt-1"
      data-testid="school-district-block"
      data-district-id={district.id}
    >
      <div className="flex items-center gap-1">
        <p className="text-[14px] font-semibold tracking-tight text-slate-800">
          {district.officialName}
        </p>
        <InfoTip aria-label={`${district.officialName} 안내`}>
          <p className="text-[12px] leading-5 text-slate-700">
            {district.infoText}
          </p>
        </InfoTip>
      </div>
      <p className="mt-0.5 text-[11px] leading-4 text-slate-500">
        {district.description}
      </p>

      {preview.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {preview.map((m) => (
            <li key={`${m.schoolCode ?? m.name}`}>
              <DistrictSchoolRow
                name={m.name}
                establishment={m.establishment}
                distanceM={m.distanceM}
                linkable={m.detailLinkable}
                onClick={() =>
                  onOpenSchool({
                    schoolCode: m.schoolCode,
                    name: m.name,
                    level: district.level,
                    address: null,
                  })
                }
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-slate-500">
          학교군 소속 {district.memberCount}개교 · 단지와 가까운 순으로 거리를
          계산합니다.
        </p>
      )}

      {showAllCta ? (
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="mt-2 inline-flex items-center gap-0.5 text-[12px] font-medium text-[color:var(--lab-teal-700)] hover:underline"
        >
          학교군 전체 보기
          <ChevronRight className="size-3.5" aria-hidden />
        </button>
      ) : null}

      <LabBottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={district.officialName}
        doneLabel="닫기"
      >
        <p className="text-[12px] text-slate-500">
          학교군 소속 {district.memberCount}개교
        </p>
        <p className="mt-1 text-[11px] leading-4 text-slate-500">
          {district.infoText}
        </p>
        <ul className="mt-3 space-y-1">
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
      <div className="rounded-lg px-2.5 py-2">
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
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition active:scale-[0.99] active:bg-slate-100 hover:bg-slate-50"
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
