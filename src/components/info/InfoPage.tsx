import { BackLink } from "@/components/layout/BackLink";
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
        <PageHeader leading={<BackLink fallback="/" compact hideLabel />} title={title} titleClassName="detail-page-title" description={description} />
        <article className="detail-body max-w-3xl space-y-8 text-[color:var(--lab-body)]">
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
      <h2 className="detail-section-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function InfoList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 marker:text-[color:var(--lab-muted)]">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
