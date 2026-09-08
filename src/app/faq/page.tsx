import type { Metadata } from "next";
import Link from "next/link";
import { FaqAccordion, type FaqItem } from "@/components/info/FaqAccordion";
import { InfoPage, InfoSection } from "@/components/info/InfoPage";
import { SITE_BRAND, SITE_CONTACT_EMAIL, SITE_CONTACT_MAILTO } from "@/lib/site";

export const metadata: Metadata = {
  title: `자주 묻는 질문 | ${SITE_BRAND}`,
  description:
    "실거래가·데이터 출처·업데이트·면적 표기 등 자주 묻는 질문을 모았습니다.",
};

const FAQ_ITEMS: FaqItem[] = [
  {
    question: "실거래가는 무엇인가요?",
    answer: (
      <p>
        아파트 매매·전월세 계약이 이뤄진 뒤 신고된 실제 거래 가격입니다. 매물
        호가나 감정가와는 다른 개념이며, 이미 성사된 계약의 기록입니다.
      </p>
    ),
  },
  {
    question: "데이터는 어디에서 가져오나요?",
    answer: (
      <p>
        국토교통부 아파트 실거래 공개자료(OpenAPI)를 기반으로 합니다. 출처와
        표시 기준은{" "}
        <Link href="/data-policy" className="font-medium text-teal-700 hover:underline">
          데이터 안내
        </Link>
        에서 자세히 볼 수 있습니다.
      </p>
    ),
  },
  {
    question: "실거래 데이터는 언제 업데이트되나요?",
    answer: (
      <p>
        공공데이터 공개 시점과 서비스의 수집·처리 과정에 따라 반영까지 시간이
        걸릴 수 있습니다. 실시간 시세처럼 초 단위로 갱신되지 않습니다.
      </p>
    ),
  },
  {
    question: "오늘 계약한 거래가 바로 표시되나요?",
    answer: (
      <p>
        반드시 그렇지 않습니다. 신고·공개·수집 절차를 거쳐야 화면에 나타날 수
        있어, 당일 계약이 바로 보이지 않을 수 있습니다.
      </p>
    ),
  },
  {
    question: "실거래가와 매물 가격은 왜 다른가요?",
    answer: (
      <p>
        매물 가격은 팔겠다고 내놓은 희망 가격(호가)인 경우가 많고, 실거래가는
        실제로 계약·신고된 금액입니다. 시점과 조건이 다르면 차이가 나는 것이
        일반적입니다.
      </p>
    ),
  },
  {
    question: "전용면적과 평형은 어떻게 다른가요?",
    answer: (
      <p>
        전용면적은 ㎡로 표시되는 실제 전용 면적이고, 평형은 이해를 돕기 위한
        환산 표기입니다. 이 서비스는 1평 ≈ 3.3058㎡로 환산하며, 비교·선택의
        기준은 전용면적(㎡)입니다.
      </p>
    ),
  },
  {
    question: "신고가는 어떤 의미인가요?",
    answer: (
      <p>
        시장동향·오늘의 시장 등에서 쓰는 ‘신고가’는 서비스가 정한 기준(동일
        단지·면적 유형 대비 높은 거래 등)으로 표시하는 참고 지표입니다. 공인
        시세 고시나 투자 권유를 의미하지 않습니다.
      </p>
    ),
  },
  {
    question: "같은 아파트인데 가격 차이가 나는 이유는 무엇인가요?",
    answer: (
      <p>
        전용면적, 층, 계약 시점, 거래 조건 등이 다르면 금액이 달라집니다. 단지명
        하나만으로 가격을 단정하기보다 면적·일자별 이력을 함께 보는 것이
        좋습니다.
      </p>
    ),
  },
  {
    question: "거래가 나중에 정정되거나 해제될 수도 있나요?",
    answer: (
      <p>
        가능합니다. 신고 내용이 정정·해제되면 공식 자료와 서비스 표시 사이에
        일시적 차이가 생길 수 있습니다. 현재 모든 취소·해제를 완벽히 반영한다고
        보장하지 않습니다.
      </p>
    ),
  },
  {
    question: "서비스의 데이터와 공식 자료가 다르면 어떻게 해야 하나요?",
    answer: (
      <p>
        중요한 판단에는{" "}
        <a
          href="https://rt.molit.go.kr"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-teal-700 hover:underline"
        >
          국토교통부 실거래가 공개시스템
        </a>
        등 공식 자료를 우선하세요. 차이에 대한 제보는{" "}
        <Link href="/contact" className="font-medium text-teal-700 hover:underline">
          문의하기
        </Link>
        로 보내 주시면 확인에 도움이 됩니다.
      </p>
    ),
  },
  {
    question: "특정 단지의 데이터 오류는 어디로 신고하나요?",
    answer: (
      <p>
        <a
          href={SITE_CONTACT_MAILTO}
          className="break-all font-medium text-teal-700 hover:underline"
        >
          {SITE_CONTACT_EMAIL}
        </a>
        로 아파트명, 지역, 거래일, 전용면적, 확인하신 내용을 함께 보내 주세요.
        자세한 안내는{" "}
        <Link href="/contact" className="font-medium text-teal-700 hover:underline">
          문의하기
        </Link>
        에 있습니다.
      </p>
    ),
  },
  {
    question: "이 서비스의 정보는 투자 추천인가요?",
    answer: (
      <p>
        아닙니다. {SITE_BRAND}은 실거래 데이터를 정리해 보여주는 참고용
        서비스이며, 특정 매수·매도나 투자 수익을 권유·보장하지 않습니다.
      </p>
    ),
  },
];

export default function FaqPage() {
  return (
    <InfoPage
      title="자주 묻는 질문"
      description="실거래 데이터와 서비스 이용에 대해 자주 묻는 내용을 모았습니다."
    >
      <InfoSection title="FAQ">
        <FaqAccordion items={FAQ_ITEMS} />
      </InfoSection>
      <p className="text-sm text-slate-600">
        원하는 답이 없다면{" "}
        <Link href="/contact" className="font-medium text-teal-700 hover:underline">
          문의하기
        </Link>
        로 연락해 주세요.
      </p>
    </InfoPage>
  );
}
