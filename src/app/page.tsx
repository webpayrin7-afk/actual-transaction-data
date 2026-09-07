import type { Metadata } from "next";
import { HomePage } from "@/components/home/HomePage";

export const metadata: Metadata = {
  title: "단지별 조회 - 아파트 실거래",
  description:
    "단지명으로 서울·경기 아파트 매매·전월세 실거래 이력과 시세를 조회합니다.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <HomePage />
    </main>
  );
}
