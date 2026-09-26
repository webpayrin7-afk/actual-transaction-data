import type { Metadata } from "next";
import { LabPage } from "@/components/lab/LabPage";

export const metadata: Metadata = {
  title: "오늘의 실험실 - 집랩",
  description:
    "로열층 프리미엄, 새 아파트 프리미엄, 직거래 가격 차이, 계약 요일 등 전국 아파트 실거래로 해 보는 집랩의 실험적인 통계.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <LabPage />
    </main>
  );
}
