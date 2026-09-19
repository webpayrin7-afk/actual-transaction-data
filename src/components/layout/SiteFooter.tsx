import Link from "next/link";
import {
  INFO_NAV,
  LEGAL_NAV,
  SITE_BRAND,
  SITE_CONTACT_EMAIL,
  SITE_CONTACT_MAILTO,
} from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-slate-200 bg-slate-50/80">
      <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:justify-between sm:gap-10">
          <div className="min-w-0 max-w-sm">
            <p className="apt-type-body-semibold text-slate-800">{SITE_BRAND}</p>
            <p className="apt-type-caption mt-1.5">
              국토교통부 아파트 실거래 공개자료를 바탕으로 단지·지역별 시장
              정보를 정리해 제공합니다.
            </p>
            <p className="apt-type-caption mt-3">
              문의{" "}
              <a
                href={SITE_CONTACT_MAILTO}
                className="break-all font-medium text-teal-700 hover:underline"
              >
                {SITE_CONTACT_EMAIL}
              </a>
            </p>
          </div>

          <div className="grid grid-cols-2 gap-6 sm:gap-10">
            <div>
              <p className="apt-type-caption-strong tracking-wide">
                서비스
              </p>
              <ul className="mt-2 space-y-1.5">
                {INFO_NAV.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="apt-type-caption text-slate-600 hover:text-teal-800 hover:underline"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="apt-type-caption-strong tracking-wide">
                운영
              </p>
              <ul className="mt-2 space-y-1.5">
                {LEGAL_NAV.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="apt-type-caption text-slate-600 hover:text-teal-800 hover:underline"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <p className="apt-type-caption-strong mt-8 border-t border-slate-200 pt-4 text-slate-400">
          © {new Date().getFullYear()} {SITE_BRAND}. 국토교통부 실거래 OpenAPI
          기반.
        </p>
      </div>
    </footer>
  );
}
