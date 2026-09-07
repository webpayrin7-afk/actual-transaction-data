import { redirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AnyangRedirect({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string") qs.set(key, value);
  }
  const suffix = qs.toString();
  redirect(
    suffix
      ? `/region/gyeonggi-anyang?${suffix}`
      : "/region/gyeonggi-anyang",
  );
}
