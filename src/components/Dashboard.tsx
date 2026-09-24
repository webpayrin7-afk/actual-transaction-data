"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RegionDailyStatus } from "@/components/RegionDailyStatus";
import { RegionDongBrowse } from "@/components/RegionDongBrowse";
import { RegionHeroMeta } from "@/components/region/RegionHeroMeta";
import { BackLink } from "@/components/layout/BackLink";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LabTabs, labTabId, labTabPanelId } from "@/components/ui/LabTabs";
import type { RegionDef } from "@/lib/constants/regions";
import { regionRankingCode } from "@/lib/region-ranking/public";

export type RegionTab = "dong" | "stats";

const TABS: { id: RegionTab; label: string }[] = [
  { id: "stats", label: "시장 현황" },
  { id: "dong", label: "단지 탐색" },
];

function parseTab(value: string | null | undefined): RegionTab | null {
  if (value === "dong" || value === "stats") return value;
  return null;
}

export function Dashboard({
  region,
  initialTab,
}: {
  region: RegionDef;
  initialTab?: RegionTab;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseTab(searchParams.get("tab")) ?? initialTab ?? "stats";
  const lawdCd = regionRankingCode(region.lawdCodes);

  const selectTab = (next: RegionTab) => {
    if (next === tab) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className={PAGE_SHELL}>
      <header className="-mt-1 sm:-mt-1.5">
        <PageHeader
          leading={<BackLink fallback="/regions" compact hideLabel />}
          title={region.name}
          titleSuffix={region.fullName.replace(region.name, "").trim() || null}
          titleClassName="detail-page-title"
          showDivider={false}
        >
          <RegionHeroMeta scope={lawdCd ? { lawdCd } : null} />
        </PageHeader>
      </header>

      <LabTabs
        variant="primary"
        ariaLabel="지역 상세 탭"
        idPrefix="region"
        items={TABS}
        value={tab}
        onChange={selectTab}
      />

      <div id={labTabPanelId("region", tab)} role="tabpanel" aria-labelledby={labTabId("region", tab)} className="contents">
        {tab === "dong" && <RegionDongBrowse regionSlug={region.slug} />}

        {tab === "stats" && (
          <RegionDailyStatus
            regionSlug={region.slug}
            regionName={region.name}
            lawdCodes={region.lawdCodes}
          />
        )}
      </div>
    </div>
  );
}
