import Link from "next/link";

export function ComingSoonPage({
  title,
  description,
  group = "도구",
}: {
  title: string;
  description: string;
  group?: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <div className="max-w-2xl">
        <p className="text-xs font-medium tracking-wide text-teal-700">
          {group}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          {title}
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
          {description}
        </p>
      </div>

      <section className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-5 py-10 sm:px-8">
        <p className="text-sm font-medium text-slate-800">준비 중인 메뉴입니다</p>
        <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">
          곧 이 화면에서 바로 확인할 수 있도록 구성할 예정입니다. 지금은 단지·지역
          실거래 조회를 먼저 이용해 주세요.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            href="/complexes"
            className="inline-flex items-center rounded-lg bg-teal-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-teal-700"
          >
            단지별 조회
          </Link>
          <Link
            href="/regions"
            className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            지역별 조회
          </Link>
        </div>
      </section>
    </div>
  );
}
