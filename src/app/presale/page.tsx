import type { Metadata } from "next";
import { PresalePage } from "@/components/presale/PresalePage";

export const metadata: Metadata = {
  title: "분양 - 집랩",
  description: "아파트 청약 일정과 최근 청약 경쟁률을 확인하세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <PresalePage />
    </main>
  );
}
