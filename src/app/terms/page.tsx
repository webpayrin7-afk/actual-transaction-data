import type { Metadata } from "next";
import Link from "next/link";
import { InfoList, InfoPage, InfoSection } from "@/components/info/InfoPage";
import { SITE_BRAND, SITE_CONTACT_EMAIL, SITE_CONTACT_MAILTO } from "@/lib/site";

export const metadata: Metadata = {
  title: `이용약관 | ${SITE_BRAND}`,
  description: `${SITE_BRAND} 이용에 관한 기본 약관입니다.`,
};

export default function TermsPage() {
  return (
    <InfoPage
      title="이용약관"
      description={`${SITE_BRAND} 이용에 관한 기본 사항을 안내합니다.`}
    >
      <InfoSection title="목적">
        <p>
          이 약관은 {SITE_BRAND}(이하 “서비스”)가 제공하는 웹 정보 서비스의
          이용 조건과 운영자와 이용자 간의 기본 권리를 정합니다.
        </p>
        <p className="text-xs text-slate-500">최종 업데이트: 2026-09-08</p>
      </InfoSection>

      <InfoSection title="서비스 내용">
        <p>
          서비스는 국토교통부 등 공공데이터에 기반한 아파트 실거래·지역·시장
          관련 정보를 웹에서 열람할 수 있게 합니다. 현재 회원 가입이나 유료
          결제 기능은 포함하지 않습니다.
        </p>
      </InfoSection>

      <InfoSection title="정보의 성격">
        <InfoList
          items={[
            "제공 정보는 참고용이며, 공식 신고·등기·감정 결과를 대체하지 않습니다.",
            "특정 부동산의 매수·매도 권유나 투자 자문이 아닙니다.",
            "데이터 누락·지연·오류 가능성이 있으며, 중요 결정은 공식 자료를 확인해야 합니다.",
          ]}
        />
      </InfoSection>

      <InfoSection title="이용자의 책임">
        <InfoList
          items={[
            "서비스를 법령과 사회상규에 맞게 이용해야 합니다.",
            "열람한 정보를 바탕으로 한 계약·투자·대출 등의 결과는 이용자 본인의 책임입니다.",
            "자동화 대량 요청 등으로 서비스 운영을 방해하지 않아야 합니다.",
          ]}
        />
      </InfoSection>

      <InfoSection title="금지행위">
        <InfoList
          items={[
            "서비스의 정상적인 운영을 방해하는 행위",
            "허위 정보 유포, 타인 권리 침해, 불법 정보 게시·전송",
            "무단 스크래핑·복제 후 상업적 재배포(법령이 허용하는 범위를 넘는 경우)",
          ]}
        />
      </InfoSection>

      <InfoSection title="지식재산·콘텐츠">
        <p>
          서비스의 상표·화면 구성·편집된 콘텐츠 등에 대한 권리는 운영자 또는
          정당한 권리자에게 있습니다. 공공데이터 원천 자료의 권리는 해당
          제공기관의 정책을 따릅니다. 개인적·비상업적 열람을 넘는 이용은 관련
          법령과 출처 표시 의무를 준수해야 합니다.
        </p>
      </InfoSection>

      <InfoSection title="서비스 변경 및 중단">
        <p>
          운영상 필요에 따라 기능·메뉴·데이터 범위를 변경하거나, 점검·장애
          등으로 일시 중단할 수 있습니다. 가능한 범위에서 안정적 제공을
          노력하지만 무중단을 보장하지는 않습니다.
        </p>
      </InfoSection>

      <InfoSection title="책임의 제한">
        <p>
          서비스는 무료 정보 제공을 원칙으로 하며, 데이터 오류·지연·중단으로
          발생한 손해에 대해 고의 또는 중대한 과실이 없는 한 책임을 지지
          않습니다. 이용자가 서비스 정보만을 근거로 내린 결정의 결과 역시
          운영자가 보장하지 않습니다.
        </p>
      </InfoSection>

      <InfoSection title="약관 변경">
        <p>
          약관을 변경할 경우 이 페이지에 게시합니다. 변경 후에도 서비스를
          계속 이용하면 변경된 약관에 동의한 것으로 봅니다. 유료·회원 기능이
          도입되면 관련 조항을 별도로 개정합니다.
        </p>
      </InfoSection>

      <InfoSection title="문의">
        <p>
          약관 관련 문의:{" "}
          <a
            href={SITE_CONTACT_MAILTO}
            className="break-all font-medium text-teal-700 hover:underline"
          >
            {SITE_CONTACT_EMAIL}
          </a>
        </p>
        <p>
          <Link href="/contact" className="font-medium text-teal-700 hover:underline">
            문의하기
          </Link>
          {" · "}
          <Link href="/privacy" className="font-medium text-teal-700 hover:underline">
            개인정보처리방침
          </Link>
        </p>
      </InfoSection>
    </InfoPage>
  );
}
