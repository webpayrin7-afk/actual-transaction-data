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
  const backHref = from
    ? `${from}${from.includes("?") ? "&" : "?"}nearbyTab=${encodeURIComponent(nearbyTab)}`
    : "/complexes";

  return (
    <main className="flex-1 overflow-x-clip">
      <SchoolDetailView detail={detail} backHref={backHref} />
    </main>
  );
}
