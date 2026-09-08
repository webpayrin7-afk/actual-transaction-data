import type { Metadata } from "next";
import Link from "next/link";
import { InfoList, InfoPage, InfoSection } from "@/components/info/InfoPage";
import { SITE_BRAND } from "@/lib/site";

export const metadata: Metadata = {
  title: `이용 가이드 | ${SITE_BRAND}`,
  description:
    "단지 조회부터 시장동향까지 주요 기능과 실거래 데이터를 확인하는 방법을 안내합니다.",
};

export default function GuidePage() {
  return (
    <InfoPage
      title="이용 가이드"
      description="단지 조회부터 시장동향까지 주요 기능과 실거래 데이터를 확인하는 방법을 안내합니다."
    >
      <InfoSection title="아파트 단지 조회">
        <p>
          <Link href="/complexes" className="font-medium text-teal-700 hover:underline">
            단지 조회
          </Link>
          에서는 아파트 단지명을 검색해 상세 페이지로 이동할 수 있습니다. 동명이
          있으면 지역·동 정보로 구분되며, 선택 시 해당 단지 상세로 이동합니다.
        </p>
        <InfoList
          items={[
            "검색창에 단지명을 입력하고 후보를 선택합니다.",
            "최근 본 단지가 있다면 다시 열어볼 수 있습니다(브라우저에만 저장).",
            "거래가 활발한 단지 목록으로 관심 단지를 발견할 수 있습니다.",
            "단지 상세에서 면적을 고르면 해당 면적 중심으로 이력을 볼 수 있습니다.",
          ]}
        />
      </InfoSection>

      <InfoSection title="실거래가 확인">
        <p>
          단지 상세에서는 실제 계약으로 신고된 거래 이력을 확인합니다. 화면에는
          보통 다음 정보가 함께 표시됩니다.
        </p>
        <InfoList
          items={[
            "거래금액(매매는 억/만 원 표기, 전월세는 보증금·월세)",
            "계약일",
            "전용면적(㎡)과 평 환산",
            "층",
            "거래 구분(매매·전월세 등) 및 이력 목록",
          ]}
        />
        <p>
          표의 날짜는 서비스에 저장된 계약일(deal date)을 기준으로 합니다. 시세
          “현재가”처럼 실시간으로 움직이는 값이 아니라는 점에 유의하세요.
        </p>
      </InfoSection>

      <InfoSection title="전용면적과 평형">
        <p>
          전용면적은 ㎡ 단위로 표시하고, 참고용으로 평 환산을 함께 보여 줍니다.
          환산은 1평 ≈ 3.3058㎡ 기준으로 계산하며, 목록·선택 UI에서는 반올림한
          평수를 보조 표기로 사용합니다. 실제 비교·필터는 전용면적(㎡)이
          기준입니다.
        </p>
      </InfoSection>

      <InfoSection title="지역 조회">
        <p>
          <Link href="/regions" className="font-medium text-teal-700 hover:underline">
            지역 조회
          </Link>
          에서 서울·경기 시·군·구를 선택하면 해당 지역 상세로 이동합니다. 지역명
          검색으로 원하는 구·시를 빠르게 찾을 수 있으며, 지역 상세에서는 단지
          목록과 지역 현황(신고가 등)을 확인할 수 있습니다.
        </p>
      </InfoSection>

      <InfoSection title="시장동향">
        <p>
          <Link href="/stats" className="font-medium text-teal-700 hover:underline">
            시장동향
          </Link>
          의 일·주·월 구간은 거래의 계약일을 기준으로 집계합니다.{" "}
          <Link href="/" className="font-medium text-teal-700 hover:underline">
            오늘의 시장
          </Link>
          은 서비스가 새롭게 확인한 거래를 중심으로 보여 주므로, 계약일 기준
          시장동향과 집계 시점이 다를 수 있습니다. ‘새롭게 확인한 시점’은 공식
          신고일을 의미하지 않습니다.
        </p>
        <InfoList
          items={[
            "일간·주간·월간 기간 선택(시장동향)",
            "전체·서울·경기 등 지역 범위 선택",
            "거래량 추이와 주요 실거래",
            "신고가·하락거래 관련 지표와 목록",
          ]}
        />
        <p>
          “신고가”는 이 서비스에서 정의한 기준(예: 동일 단지·면적 유형 대비
          높은 거래)으로 표시되는 참고 지표이며, 공인 시세 고시와는 다를 수
          있습니다. 자세한 기준은{" "}
          <Link href="/data-policy" className="font-medium text-teal-700 hover:underline">
            데이터 안내
          </Link>
          와 화면의 설명을 함께 보세요.
        </p>
      </InfoSection>

      <InfoSection title="데이터를 볼 때 주의할 점">
        <InfoList
          items={[
            "실거래는 이미 이뤄진 계약의 신고 결과입니다. 주식처럼 초 단위로 변하는 호가가 아닙니다.",
            "같은 단지라도 면적·층·시점·거래 조건에 따라 금액 차이가 큽니다.",
            "매물 호가와 실거래가는 서로 다른 개념입니다.",
            "중요 결정 전에는 국토교통부 공식 실거래가 공개시스템을 함께 확인하세요.",
          ]}
        />
        <p>
          더 자세한 사용 팁은{" "}
          <Link href="/faq" className="font-medium text-teal-700 hover:underline">
            FAQ
          </Link>
          에도 정리되어 있습니다.
        </p>
      </InfoSection>
    </InfoPage>
  );
}
