import type { Metadata } from "next";
import { PresaleDetail } from "@/components/presale/PresaleDetail";

export const metadata: Metadata = {
  title: "분양 공고 - 집랩",
  description: "주택형별 분양가, 1순위 경쟁률, 주변 시세 비교.",
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="flex-1">
      <PresaleDetail id={id} />
    </main>
  );
}
