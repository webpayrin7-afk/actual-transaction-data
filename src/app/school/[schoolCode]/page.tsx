import type { Metadata } from "next";
import { SchoolDetailView } from "@/components/school/SchoolDetailView";
import { getSchoolDetail } from "@/lib/school-info/get-school-detail";

type PageProps = {
  params: Promise<{ schoolCode: string }>;
  searchParams: Promise<{
    name?: string;
    from?: string;
    nearbyTab?: string;
  }>;
};

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const { schoolCode } = await params;
  const sp = await searchParams;
  const name = sp.name?.trim();
  return {
    title: name ? `${name} - 학교 상세` : `학교 상세 (${schoolCode})`,
    description: "학교알리미 공시 기반 학교 상세",
    robots: { index: false, follow: false },
  };
}

export default async function SchoolDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { schoolCode: rawCode } = await params;
  const sp = await searchParams;
  const schoolCode = decodeURIComponent(rawCode).trim();
  const nameHint = sp.name?.trim() || null;

  const detail = await getSchoolDetail({
    schoolCode,
    nameHint,
    kind: "middle",
  });

  const from = sp.from?.trim();
  const nearbyTab = sp.nearbyTab?.trim() || "school";
  const backHref = buildSchoolBackHref(from, nearbyTab);

  return (
    <main className="flex-1 overflow-x-clip">
      <SchoolDetailView detail={detail} backHref={backHref} />
    </main>
  );
}

/**
 * Back from school detail only: restore 학교 탭 + scroll to 주변 생활.
 * Normal apt entry never includes these markers → initial tab stays 교통.
 */
function buildSchoolBackHref(
  from: string | undefined,
  nearbyTab: string,
): string {
  if (!from || !from.startsWith("/") || from.startsWith("//")) {
    return "/complexes";
  }
  const hashIdx = from.indexOf("#");
  const withoutHash = hashIdx >= 0 ? from.slice(0, hashIdx) : from;
  const qIdx = withoutHash.indexOf("?");
  const path = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash;
  const qs = qIdx >= 0 ? withoutHash.slice(qIdx + 1) : "";
  const params = new URLSearchParams(qs);
  params.delete("nearbyTab");
  params.set("nearbyTab", nearbyTab);
  const q = params.toString();
  return `${path}${q ? `?${q}` : ""}#section-nearby-life`;
}
