"use client";

import { BackLink } from "@/components/layout/BackLink";
import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LAB_SECTION_SURFACE, LabSectionHeader } from "@/components/ui/LabSection";
import { RegionTransactionSearch } from "@/components/transactions/RegionTransactionSearch";
import { ALL_REGIONS, METRO_LABELS, getRegion, type Metro } from "@/lib/constants/regions";
import type { DealType } from "@/types/transaction";

const METRO_ORDER: Metro[] = [
  "seoul",
  "gyeonggi",
  "incheon",
  "busan",
  "daegu",
  "gwangju",
  "daejeon",
  "ulsan",
  "sejong",
  "gangwon",
  "chungbuk",
  "chungnam",
  "jeonbuk",
  "jeonnam",
  "gyeongbuk",
  "gyeongnam",
  "jeju",
];

const SELECT =
  "min-h-12 w-full rounded-lg border border-[color:var(--lab-border)] bg-white px-3 text-[16px] leading-6 text-[color:var(--lab-navy-950)] outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20";

export function TransactionSearchPage({
  initialAptName,
  initialGu,
  initialDealType,
}: {
  initialAptName: string;
  initialGu: string;
  initialDealType: DealType | "all";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const region = getRegion(searchParams.get("region") ?? "") ?? null;
  const metro: Metro =
    (searchParams.get("metro") as Metro | null) ?? region?.metro ?? "seoul";
  const metros = METRO_ORDER.filter((m) => m in METRO_LABELS);
  const regionsInMetro = useMemo(
    () => ALL_REGIONS.filter((r) => r.metro === metro),
    [metro],
  );

  const replaceParams = (next: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v == null) params.delete(k);
      else params.set(k, v);
    }
    params.delete("aptName");
    params.delete("gu");
    params.delete("dealType");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className={PAGE_SHELL}>
      <header className="-mt-1 sm:-mt-1.5">
        <PageHeader
          leading={<BackLink fallback="/" compact hideLabel />}
          title="실거래 검색"
          titleClassName="detail-page-title"
          description="지역과 조건을 골라 아파트 매매·전월세 실거래를 찾아보세요."
          showDivider={false}
        />
      </header>

      <section aria-label="지역 선택" className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}>
        <LabSectionHeader title="지역" />
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="detail-label">시·도</span>
            <select
              className={SELECT}
              value={metro}
              onChange={(e) => replaceParams({ metro: e.target.value, region: null })}
            >
              {metros.map((m) => (
                <option key={m} value={m}>
                  {METRO_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="detail-label">시·군·구</span>
            <select
              className={SELECT}
              value={region && region.metro === metro ? region.slug : ""}
              onChange={(e) =>
                replaceParams({ metro, region: e.target.value || null })
              }
            >
              <option value="">선택</option>
              {regionsInMetro.map((r) => (
                <option key={r.slug} value={r.slug}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {region && region.metro === metro ? (
        <RegionTransactionSearch
          key={region.slug}
          region={region}
          initialAptName={initialAptName}
          initialGu={initialGu}
          initialDealType={initialDealType}
        />
      ) : (
        <div className="lab-state">시·군·구를 고르면 실거래를 검색할 수 있어요.</div>
      )}
    </div>
  );
}
