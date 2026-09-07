import { Dashboard } from "@/components/Dashboard";
import type { DealType } from "@/types/transaction";

type SearchParams = Promise<{
  aptName?: string;
  gu?: string;
  dealType?: string;
}>;

export default async function AnyangPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const dealType =
    params.dealType === "trade" || params.dealType === "rent"
      ? (params.dealType as DealType)
      : "all";

  return (
    <main className="flex-1">
      <Dashboard
        initialAptName={params.aptName ?? ""}
        initialGu={params.gu ?? "all"}
        initialDealType={dealType}
      />
    </main>
  );
}
