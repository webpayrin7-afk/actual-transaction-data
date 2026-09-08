import type { Metadata } from "next";
import { InfoList, InfoPage, InfoSection } from "@/components/info/InfoPage";
import { SITE_BRAND, SITE_CONTACT_EMAIL, SITE_CONTACT_MAILTO } from "@/lib/site";

export const metadata: Metadata = {
  title: `문의하기 | ${SITE_BRAND}`,
  description: "서비스 이용 및 데이터 관련 문의를 보내주세요.",
};

export default function ContactPage() {
  return (
    <InfoPage
      title="문의하기"
      description="서비스 이용 및 데이터 관련 문의를 보내주세요."
    >
      <InfoSection title="운영 이메일">
        <p>
          <a
            href={SITE_CONTACT_MAILTO}
            className="break-all text-base font-semibold text-teal-700 hover:underline"
          >
            {SITE_CONTACT_EMAIL}
          </a>
        </p>
        <p className="text-slate-600">
          별도의 문의 저장 서버는 운영하지 않으며, 위 주소로 메일을 보내 주시면
          확인 후 답변드립니다.
        </p>
      </InfoSection>

      <InfoSection title="이런 문의를 받고 있습니다">
        <InfoList
          items={[
            "서비스 이용 방법·화면 관련 문의",
            "데이터 오류·누락 제보",
            "출처·표시 기준 관련 질문",
            "기타 운영 관련 문의",
          ]}
        />
      </InfoSection>

      <InfoSection title="데이터 오류 제보 시 함께 적어 주세요">
        <p>확인 속도를 높이기 위해 가능하면 아래 정보를 포함해 주세요.</p>
        <InfoList
          items={[
            "아파트(단지)명",
            "지역(시·도 / 시·군·구 / 동)",
            "거래일(계약일)",
            "전용면적",
            "화면에서 확인한 내용과, 비교한 공식 자료(있다면)의 내용",
          ]}
        />
      </InfoSection>

      <InfoSection title="답변에 대하여">
        <p>
          문의량에 따라 답변까지 시간이 걸릴 수 있습니다. 긴급한 계약·대출
          판단은 국토교통부 실거래가 공개시스템 등 공식 경로를 이용해 주세요.
        </p>
      </InfoSection>
    </InfoPage>
  );
}
