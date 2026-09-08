import type { Metadata } from "next";
import Link from "next/link";
import { InfoList, InfoPage, InfoSection } from "@/components/info/InfoPage";
import { SITE_BRAND, SITE_CONTACT_EMAIL, SITE_CONTACT_MAILTO } from "@/lib/site";

export const metadata: Metadata = {
  title: `개인정보처리방침 | ${SITE_BRAND}`,
  description: `${SITE_BRAND}의 개인정보 처리 방침을 안내합니다.`,
};

export default function PrivacyPage() {
  return (
    <InfoPage
      title="개인정보처리방침"
      description={`${SITE_BRAND}이 어떤 정보를 다루는지, 현재 서비스 기준으로 안내합니다.`}
    >
      <InfoSection title="개요">
        <p>
          {SITE_BRAND}(이하 “서비스”)는 아파트 실거래 정보를 제공하는 웹
          서비스입니다. 이 방침은 현재 배포된 기능 기준으로 작성되었으며, 기능이
          바뀌면 내용을 업데이트합니다.
        </p>
        <p className="text-xs text-slate-500">최종 업데이트: 2026-09-08</p>
      </InfoSection>

      <InfoSection title="회원·로그인">
        <p>
          현재 서비스는 회원가입·로그인·계정 기능을 제공하지 않으며, 이름·이메일
          등 회원 정보를 수집하기 위한 가입 양식도 두지 않습니다.
        </p>
      </InfoSection>

      <InfoSection title="브라우저에 저장되는 정보">
        <p>서비스 이용 편의를 위해 아래 정보가 이용자 기기(브라우저)에 저장될 수 있습니다.</p>
        <InfoList
          items={[
            <>
              <strong className="font-medium text-slate-800">최근 본 단지</strong>
              {" — "}
              단지 상세를 열면 최근 조회 목록을 브라우저 localStorage에 저장합니다.
              서버로 전송하거나 계정에 묶지 않습니다.
            </>,
            <>
              <strong className="font-medium text-slate-800">내부 이동 기록</strong>
              {" — "}
              같은 탭에서 ‘돌아가기’ 동작을 돕기 위해 직전 경로를 sessionStorage에
              잠시 저장할 수 있습니다.
            </>,
          ]}
        />
        <p>
          브라우저 설정에서 사이트 데이터를 삭제하면 위 정보도 함께 삭제됩니다.
        </p>
      </InfoSection>

      <InfoSection title="쿠키·광고·분석">
        <p>
          현재 서비스 코드 기준으로 별도의 광고 스크립트(Google AdSense 등)나
          제3자 웹 분석(Google Analytics 등)을 삽입하지 않습니다. 호스팅
          제공자(Vercel 등)가 운영·보안 목적으로 접속 로그를 처리할 수는 있으며,
          이는 해당 사업자의 정책에 따릅니다.
        </p>
      </InfoSection>

      <InfoSection title="문의 시 제공되는 정보">
        <p>
          이용자가 이메일(
          <a
            href={SITE_CONTACT_MAILTO}
            className="break-all font-medium text-teal-700 hover:underline"
          >
            {SITE_CONTACT_EMAIL}
          </a>
          )로 문의할 때 메일 내용·회신 주소 등이 운영자에게 전달됩니다. 서비스
          서버 DB에 문의 양식을 저장하는 기능은 없습니다. 문의 내용은 답변과
          서비스 개선 목적 범위에서만 사용합니다.
        </p>
      </InfoSection>

      <InfoSection title="개인정보의 제3자 제공">
        <p>
          법령에 따른 요청이 있는 경우를 제외하고, 이용자가 문의를 통해 보낸
          내용을 마케팅 목적으로 제3자에게 판매·제공하지 않습니다.
        </p>
      </InfoSection>

      <InfoSection title="이용자의 선택">
        <InfoList
          items={[
            "최근 본 단지·사이트 데이터는 브라우저에서 삭제할 수 있습니다.",
            "문의 메일 삭제·정정 요청은 운영 이메일로 요청할 수 있습니다.",
          ]}
        />
      </InfoSection>

      <InfoSection title="방침 변경">
        <p>
          서비스 기능(예: 광고·분석 도구 도입)이 추가되면 이 방침을 개정하고
          페이지에 반영합니다. 중요한 변경이 있으면 서비스 내 공지 또는 본
          페이지 업데이트로 알립니다.
        </p>
      </InfoSection>

      <InfoSection title="문의">
        <p>
          개인정보 관련 문의:{" "}
          <a
            href={SITE_CONTACT_MAILTO}
            className="break-all font-medium text-teal-700 hover:underline"
          >
            {SITE_CONTACT_EMAIL}
          </a>
        </p>
        <p>
          서비스 일반 문의는{" "}
          <Link href="/contact" className="font-medium text-teal-700 hover:underline">
            문의하기
          </Link>
          를 이용해 주세요.
        </p>
      </InfoSection>
    </InfoPage>
  );
}
