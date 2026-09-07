import { notFound } from "next/navigation";
import { RegionDongAptList } from "@/components/RegionDongAptList";
import { getRegion } from "@/lib/constants/regions";

type SearchParams = Promise<{
  gu?: string;
}>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; dong: string }>;
}) {
  const { slug, dong } = await params;
  const region = getRegion(slug);
  const dongName = decodeURIComponent(dong);
  if (!region) return { title: "아파트 데이터랩" };
  return {
    title: `${dongName} 단지 목록 | ${region.name} | 아파트 데이터랩`,
    description: `${region.fullName} ${dongName} 아파트 단지 목록`,
  };
}

export default async function RegionDongPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; dong: string }>;
  searchParams: SearchParams;
}) {
  const { slug, dong: dongParam } = await params;
  const region = getRegion(slug);
  if (!region) notFound();

  const sp = await searchParams;
  const dong = decodeURIComponent(dongParam);

  return (
    <main className="flex-1">
      <RegionDongAptList
        regionSlug={region.slug}
        regionName={region.name}
        dong={dong}
        gu={sp.gu}
      />
    </main>
  );
}
