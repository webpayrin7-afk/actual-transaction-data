import type { ReactNode } from "react";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";

/** Compact reading column for guide/legal/info pages */
export function InfoPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="flex-1">
      <div className={PAGE_SHELL}>
        <PageHeader title={title} description={description} />
        <article className="max-w-3xl space-y-8 text-sm leading-7 text-slate-700 sm:text-[0.9375rem] sm:leading-7">
          {children}
        </article>
      </div>
    </main>
  );
}

export function InfoSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold tracking-tight text-slate-900 sm:text-lg">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function InfoList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 marker:text-slate-400">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
