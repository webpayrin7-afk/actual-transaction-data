import type { Metadata } from "next";
import Link from "next/link";
import { InfoList, InfoPage, InfoSection } from "@/components/info/InfoPage";
import {
  SITE_BRAND,
  SITE_CONTACT_EMAIL,
  SITE_CONTACT_MAILTO,
} from "@/lib/site";

export const metadata: Metadata = {
  title: `서비스 소개 | ${SITE_BRAND}`,
  description:
    "아파트 실거래 데이터를 더 쉽게 이해할 수 있도록 정리하는 부동산 데이터 서비스 소개입니다.",
};

export default function AboutPage() {
  return (
    <InfoPage
      title="서비스 소개"
      description="아파트 실거래 데이터를 더 쉽게 이해할 수 있도록 정리하는 부동산 데이터 서비스입니다."
    >
      <InfoSection title="서비스 소개">
        <p>
          {SITE_BRAND}은 아파트 실거래 데이터를 보다 쉽고 빠르게 확인할 수 있도록
          제공하는 부동산 데이터 서비스입니다.
        </p>
        <p>
          국토교통부 실거래가 공개자료를 기반으로 아파트의 실제 거래 내역과 가격
          흐름을 정리하고, 단지와 지역별 시장 데이터를 한눈에 살펴볼 수 있도록
          제공합니다.
        </p>
        <p>
          단순히 실거래 목록을 나열하는 데 그치지 않고, 여러 거래 데이터를
          이해하기 쉬운 형태로 정리해 사용자가 아파트 시장을 파악하는 데 도움을
          주는 것을 목표로 합니다.
        </p>
      </InfoSection>

      <InfoSection title="어떤 정보를 확인할 수 있나요?">
        <p>현재 서비스에서 제공하는 주요 기능은 다음과 같습니다.</p>
        <InfoList
          items={[
            <>
              <Link href="/complexes" className="font-medium text-teal-700 hover:underline">
                단지 조회
              </Link>
              {" — "}
              아파트 단지 검색, 최근 본 단지, 거래가 활발한 단지 확인
            </>,
            <>
              단지 상세 — 실거래 이력, 거래금액·계약일·전용면적·층 정보, 면적별
              확인
            </>,
            <>
              <Link href="/regions" className="font-medium text-teal-700 hover:underline">
                지역 조회
              </Link>
              {" — "}
              서울·경기 시·군·구 단위로 지역 시장 이동
            </>,
            <>
              <Link href="/" className="font-medium text-teal-700 hover:underline">
                오늘의 시장
              </Link>
              {" · "}
              <Link href="/stats" className="font-medium text-teal-700 hover:underline">
                시장동향
              </Link>
              {" — "}
              거래량·신고가·하락거래와 주요 실거래 흐름
            </>,
            <>
              도구 — 대출 한도 계산기, 서울시 시중은행협력자금 금리비교 등
              참고용 도구
            </>,
          ]}
        />
      </InfoSection>

      <InfoSection title="데이터는 어디에서 가져오나요?">
        <p>
          주요 실거래 정보는 국토교통부에서 제공하는 아파트 매매·전월세 실거래
          공개자료(OpenAPI)를 기반으로 합니다. 공공데이터의 신고·정정·해제와
          서비스의 수집·처리 시점에 따라, 화면의 정보와 공식 시스템 사이에
          일시적인 차이가 생길 수 있습니다.
        </p>
        <p>
          계약·대출·세금·투자 등 중요한 의사결정을 하기 전에는{" "}
          <a
            href="https://rt.molit.go.kr"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-teal-700 hover:underline"
          >
            국토교통부 실거래가 공개시스템
          </a>
          등 공식 자료를 함께 확인해 주세요. 데이터 기준의 자세한 설명은{" "}
          <Link href="/data-policy" className="font-medium text-teal-700 hover:underline">
            데이터 안내
          </Link>
          를 참고하세요.
        </p>
      </InfoSection>

      <InfoSection title="서비스 운영 원칙">
        <InfoList
          items={[
            "데이터 중심으로 시장을 살펴볼 수 있게 정리합니다.",
            "전문 용어보다 이해하기 쉬운 표기와 구성을 지향합니다.",
            "특정 부동산의 매수·매도를 권유하지 않습니다.",
            "투자 수익을 보장하거나 예측하지 않습니다.",
            "제공 정보는 참고 자료이며, 최종 판단은 이용자 본인에게 있습니다.",
          ]}
        />
      </InfoSection>

      <InfoSection title="문의">
        <p>
          서비스 이용이나 데이터 관련 문의는{" "}
          <a
            href={SITE_CONTACT_MAILTO}
            className="break-all font-medium text-teal-700 hover:underline"
          >
            {SITE_CONTACT_EMAIL}
          </a>
          로 보내 주세요. 문의 유형별 안내는{" "}
          <Link href="/contact" className="font-medium text-teal-700 hover:underline">
            문의하기
          </Link>
          페이지를 참고하세요.
        </p>
      </InfoSection>
    </InfoPage>
  );
}
