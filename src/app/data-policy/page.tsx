import type { Metadata } from "next";
import Link from "next/link";
import { InfoList, InfoPage, InfoSection } from "@/components/info/InfoPage";
import { SITE_BRAND, SITE_CONTACT_EMAIL, SITE_CONTACT_MAILTO } from "@/lib/site";

export const metadata: Metadata = {
  title: `데이터 안내 | ${SITE_BRAND}`,
  description:
    "서비스에서 사용하는 실거래 데이터의 출처와 표시 기준을 안내합니다.",
};

export default function DataPolicyPage() {
  return (
    <InfoPage
      title="데이터 안내"
      description="서비스에서 사용하는 실거래 데이터의 출처와 표시 기준을 안내합니다."
    >
      <InfoSection title="데이터 출처">
        <p>
          {SITE_BRAND}의 아파트 실거래 정보는 국토교통부에서 공개하는 아파트
          매매·전월세 실거래 자료(OpenAPI)를 기반으로 수집·정리합니다. 화면의
          단지·지역·시장동향 지표도 이 자료를 가공한 결과입니다.
        </p>
        <p>
          일부 참고 도구(예: 서울시 시중은행협력자금 금리비교)는 서울 열린데이터
          광장 등 다른 공공 API를 사용할 수 있으며, 해당 화면에서 출처를 따로
          표기합니다.
        </p>
      </InfoSection>

      <InfoSection title="계약일 기준">
        <p>
          거래 날짜는 기본적으로 실제 거래의 계약일(deal date)을 사용합니다.
          시장동향의 일·주·월 구간과 “오늘의 시장” 요약도 이 계약일 축을
          중심으로 집계합니다. 데이터가 서비스에 처음 들어온 시각과는 별개의
          기준입니다.
        </p>
      </InfoSection>

      <InfoSection title="데이터 업데이트">
        <p>
          공공데이터는 제공 기관의 공개 주기에 따라 반영되며, 서비스 측
          수집·처리 과정이 더해지면 화면에 나타나기까지 시간이 걸릴 수
          있습니다. “실시간” 시세나 당일 모든 계약의 즉시 반영을 의미하지
          않습니다.
        </p>
      </InfoSection>

      <InfoSection title="신고·정정·해제">
        <p>
          실거래 신고 내용은 이후 정정되거나 해제될 수 있습니다. 공식 시스템과
          서비스 데이터 사이에 일시적인 차이가 생길 수 있으며, 현재 서비스가
          모든 취소·해제 사례를 완벽하게 반영한다고 보장하지 않습니다.
        </p>
        <p>
          금액·면적·단지 정보가 공식 자료와 다르다면 공식 자료를 우선하고,{" "}
          <Link href="/contact" className="font-medium text-teal-700 hover:underline">
            문의하기
          </Link>
          로 알려 주시면 확인에 도움이 됩니다.
        </p>
      </InfoSection>

      <InfoSection title="가격 표시">
        <p>
          매매 금액은 원본 자료의 만원 단위를 기준으로, 1억 원 이상은 ‘억’
          단위(예: 8.5억), 그 미만은 ‘만’ 단위로 읽기 쉽게 표시합니다. 전월세는
          보증금과 월세를 구분해 표기합니다.
        </p>
      </InfoSection>

      <InfoSection title="면적 표시">
        <p>
          전용면적은 ㎡로 표시하고, 참고용 평 환산(1평 ≈ 3.3058㎡)을 함께 둡니다.
          선택·필터의 기준은 전용면적(㎡)이며, 평수는 이해를 돕는 보조
          정보입니다.
        </p>
      </InfoSection>

      <InfoSection title="데이터 이용 시 유의사항">
        <InfoList
          items={[
            "서비스 데이터는 정보 제공 목적의 참고 자료입니다.",
            "부동산 계약, 대출, 세금, 투자 등 중요한 의사결정의 유일한 근거로 사용하지 마세요.",
            "최종 확인은 국토교통부 실거래가 공개시스템 등 공식 자료를 이용하세요.",
            "데이터 오류 제보는 문의 메일로 아파트명·지역·거래일·전용면적과 함께 보내 주세요.",
          ]}
        />
        <p>
          문의:{" "}
          <a
            href={SITE_CONTACT_MAILTO}
            className="break-all font-medium text-teal-700 hover:underline"
          >
            {SITE_CONTACT_EMAIL}
          </a>
        </p>
      </InfoSection>
    </InfoPage>
  );
}
