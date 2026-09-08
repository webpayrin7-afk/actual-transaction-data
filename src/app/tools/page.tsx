import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Calculator, Percent, School } from "lucide-react";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";

export const metadata: Metadata = {
  title: "부동산 계산 도구 - 아파트 데이터랩",
  description:
    "아파트 매수와 자금 계획에 필요한 계산 기능을 이용하세요.",
};

const READY_TOOLS = [
  {
    href: "/loan",
    title: "대출계산기",
    description: "LTV·DSR·DTI를 반영한 주택담보대출 한도 계산",
    icon: Calculator,
    ready: true,
  },
  {
    href: "/rates",
    title: "금리비교",
    description: "서울시 시중은행협력자금 취급 은행별 대출·보전 금리",
    icon: Percent,
    ready: true,
  },
  {
    href: "/school",
    title: "학군 정보",
    description: "단지·지역 주변 학군 정보 (준비 중)",
    icon: School,
    ready: false,
  },
] as const;

const PLANNED = [
  "평당가 계산기",
  "취득세 계산기",
  "전세가율 계산기",
  "매수 총비용 계산기",
  "갭 계산기",
  "갈아타기 계산기",
] as const;

export default function Page() {
  return (
    <main className="flex-1">
      <div className={PAGE_SHELL}>
        <PageHeader
          title="부동산 계산 도구"
          description="아파트 매수와 자금 계획에 필요한 계산 기능을 이용하세요."
        />

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {READY_TOOLS.map((tool) => {
            const Icon = tool.icon;
            const className = `flex flex-col rounded-2xl border border-slate-200 bg-white p-5 transition ${
              tool.ready
                ? "hover:border-teal-300 hover:bg-teal-50/40"
                : "opacity-75"
            }`;

            const body = (
              <>
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                  <Icon className="h-4 w-4" />
                </span>
                <h2 className="mt-3 text-base font-semibold text-slate-900">
                  {tool.title}
                </h2>
                <p className="mt-1 flex-1 text-sm leading-6 text-slate-500">
                  {tool.description}
                </p>
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-teal-700">
                  {tool.ready ? "이용하기" : "준비 중"}
                  {tool.ready ? <ArrowRight className="h-3.5 w-3.5" /> : null}
                </span>
              </>
            );

            return tool.ready ? (
              <Link key={tool.href} href={tool.href} className={className}>
                {body}
              </Link>
            ) : (
              <div key={tool.href} className={className}>
                {body}
              </div>
            );
          })}
        </section>

        <section className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-5 py-6">
          <h2 className="text-sm font-semibold text-slate-800">준비 중인 도구</h2>
          <p className="mt-1 text-sm text-slate-500">
            아래 도구는 아직 제공되지 않습니다. 목록만 미리 안내합니다.
          </p>
          <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {PLANNED.map((name) => (
              <li
                key={name}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600"
              >
                {name}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
