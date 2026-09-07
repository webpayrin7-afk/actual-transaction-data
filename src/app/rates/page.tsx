import type { Metadata } from "next";
import { ComingSoonPage } from "@/components/ComingSoonPage";

export const metadata: Metadata = {
  title: "금리비교 - 아파트 데이터랩",
  description: "주택담보·전세자금 대출 금리 비교",
};

export default function Page() {
  return (
    <main className="flex-1">
      <ComingSoonPage
        title="금리비교"
        description="주담대·전세자금 등 주요 대출 금리를 비교해 의사결정에 참고할 수 있도록 준비 중입니다."
      />
    </main>
  );
}
