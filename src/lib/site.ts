/** Site-wide brand & ops contact — keep consistent across info pages / footer */
export const SITE_BRAND = "아파트 데이터랩";

export const SITE_CONTACT_EMAIL = "financialfreedomlabs@gmail.com";

export const SITE_CONTACT_MAILTO = `mailto:${SITE_CONTACT_EMAIL}`;

export const INFO_NAV = [
  { href: "/about", label: "서비스 소개" },
  { href: "/guide", label: "이용 가이드" },
  { href: "/data-policy", label: "데이터 안내" },
  { href: "/faq", label: "FAQ" },
] as const;

export const LEGAL_NAV = [
  { href: "/privacy", label: "개인정보처리방침" },
  { href: "/terms", label: "이용약관" },
  { href: "/contact", label: "문의하기" },
] as const;
