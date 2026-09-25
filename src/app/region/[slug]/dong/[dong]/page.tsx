import { notFound } from "next/navigation";
import { RegionDongDetail } from "@/components/region/RegionDongDetail";
import { districtNameFromCode, getRegion, type RegionDef } from "@/lib/constants/regions";
import { getDb } from "@/lib/db/client";
import { resolveDongLawdCd } from "@/lib/region/region-dong-overview";
import { normalizeDongName } from "@/lib/region/region-scope";

type SearchParams = Promise<{
  gu?: string;
}>;

function dongFromParam(raw: string): string | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* already decoded */
  }
  return normalizeDongName(decoded);
}

/** 여러 구로 나뉜 시: ?gu=(예: "수원시 장안구", "장안구")로 구 코드를 고른다. */
function lawdCdFromGuParam(region: RegionDef, gu: string | undefined): string | null {
  if (region.lawdCodes.length === 1) return region.lawdCodes[0] ?? null;
  const needle = gu?.trim();
  if (!needle || needle === "all") return null;
  return region.districts.find((d) => needle.includes(d.name))?.code ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; dong: string }>;
}) {
  const { slug, dong: dongParam } = await params;
  const region = getRegion(slug);
  const dong = dongFromParam(dongParam);
  if (!region || !dong) return { title: "집랩" };
  return {
    title: `${dong} 아파트 시장 | ${region.name} | 집랩`,
    description: `${region.fullName} ${dong} 아파트 시세, 전세가율, 거래 동향, 단지 목록과 최근 실거래를 확인하세요.`,
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
  const dong = dongFromParam(dongParam);
  if (!region || !dong) notFound();

  const sp = await searchParams;
  let lawdCd = lawdCdFromGuParam(region, sp.gu);
  if (!lawdCd) {
    // 구 정보 없는 링크(예: 동네별 시세 목록): 단지 마스터에서 동이 속한 구를 찾는다.
    const db = getDb();
    lawdCd = db ? await resolveDongLawdCd(db, region.lawdCodes, dong).catch(() => null) : null;
  }
  lawdCd ??= region.lawdCodes[0] ?? null;
  if (!lawdCd) notFound();

  const district = region.districts.find((d) => d.code === lawdCd);
  const guLabel =
    region.districts.length > 1 && district ? `${region.name} ${district.name}` : region.name;
  const metroLabel = region.fullName.replace(region.name, "").trim();

  return (
    <main className="flex-1">
      <RegionDongDetail
        regionSlug={region.slug}
        lawdCd={lawdCd}
        dong={dong}
        guLabel={guLabel}
        guName={districtNameFromCode(lawdCd) || region.name}
        locationLabel={[metroLabel, guLabel].filter(Boolean).join(" ")}
      />
    </main>
  );
}
