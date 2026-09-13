import { redirect } from "next/navigation";

type PageProps = {
  params: Promise<{ name: string }>;
  searchParams: Promise<{
    region?: string;
    gu?: string;
    area?: string;
    price?: string;
    tab?: string;
  }>;
};

/**
 * Legacy calculator route — keep for old links, but send users to the
 * inline calculator section on Complex Detail (single source of truth).
 */
export default async function AptCalculatorRedirectPage({
  params,
  searchParams,
}: PageProps) {
  const { name } = await params;
  const sp = await searchParams;
  const qs = new URLSearchParams();
  if (sp.region?.trim()) qs.set("region", sp.region.trim());
  if (sp.gu?.trim()) qs.set("gu", sp.gu.trim());
  if (sp.area?.trim()) qs.set("area", sp.area.trim());
  // price/tab intentionally dropped from URL (no sensitive inputs in query).
  const q = qs.toString();
  redirect(
    `/apt/${encodeURIComponent(decodeURIComponent(name))}${q ? `?${q}` : ""}#calculator`,
  );
}
