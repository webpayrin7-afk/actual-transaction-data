import { MapPin, Phone, Globe } from "lucide-react";
import { BackLink } from "@/components/layout/BackLink";
import { PageHeader } from "@/components/layout/PageHeader";
import { LabTag } from "@/components/ui/LabTag";

function homepageLabel(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

const CONTACT_LINK =
  "inline-flex min-h-11 min-w-0 items-center gap-1.5 detail-label font-medium text-[color:var(--lab-brand-primary)] underline-offset-2 hover:underline";

/**
 * 학교 상세 헤더 — 단지 상세와 같은 PageHeader(뒤로가기 · 제목) + 속성 태그 행 + 소개 줄 (policy §12.2).
 */
export function SchoolHero({
  name,
  kind,
  foundation,
  coedu,
  address,
  tel,
  homepage,
  office,
  foundedOn,
  backHref,
}: {
  name: string;
  kind: string | null;
  foundation: string | null;
  coedu: string | null;
  address: string | null;
  tel: string | null;
  homepage: string | null;
  office: string | null;
  foundedOn: string | null;
  backHref: string;
}) {
  const homepageHref = homepage
    ? homepage.startsWith("http")
      ? homepage
      : `https://${homepage}`
    : null;
  const tags = [kind, foundation, coedu].filter((t): t is string => Boolean(t));
  const officeLine = [office, foundedOn ? `설립/개교 ${foundedOn}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <header className="-mt-1 sm:-mt-1.5">
      <PageHeader
        leading={<BackLink fallback={backHref} compact hideLabel preferFallback />}
        title={name}
        titleClassName="detail-page-title"
        showDivider={false}
        meta={
          <div className="flex flex-col gap-1">
            {tags.length > 0 ? (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {tags.map((t) => (
                  <LabTag key={t} size="md">
                    {t}
                  </LabTag>
                ))}
              </div>
            ) : null}
            {address ? (
              <p className="detail-meta flex gap-1.5">
                <MapPin
                  className="mt-0.5 size-3.5 shrink-0 text-[color:var(--lab-muted)]"
                  aria-hidden
                />
                <span className="min-w-0 break-words">{address}</span>
              </p>
            ) : null}
            {officeLine ? <p className="detail-meta">{officeLine}</p> : null}
            {tel || homepageHref ? (
              <div className="flex flex-wrap items-center gap-x-4">
                {tel ? (
                  <a href={`tel:${tel.replace(/\s+/g, "")}`} className={CONTACT_LINK}>
                    <Phone className="size-4 shrink-0" aria-hidden />
                    <span className="tabular-nums">{tel}</span>
                  </a>
                ) : null}
                {homepageHref ? (
                  <a
                    href={homepageHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={CONTACT_LINK}
                  >
                    <Globe className="size-4 shrink-0" aria-hidden />
                    <span className="break-all">{homepageLabel(homepage!)}</span>
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        }
      />
    </header>
  );
}
