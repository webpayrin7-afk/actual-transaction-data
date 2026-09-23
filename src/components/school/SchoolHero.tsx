import { MapPin, Phone, Globe } from "lucide-react";
import { BackLink } from "@/components/layout/BackLink";
import { LabTag } from "@/components/ui/LabTag";

function homepageLabel(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

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

  return (
    <header className="px-3 pt-2 sm:px-4 sm:pt-3">
      <div className="flex min-w-0 items-center gap-1">
        <BackLink
          fallback={backHref}
          compact
          hideLabel
          preferFallback
          className="-ml-2 shrink-0"
        />
        <h1 className="detail-page-title min-w-0 flex-1">
          {name}
        </h1>
      </div>

      {(kind || foundation || coedu) && (
        <div className="mt-2.5 flex flex-wrap gap-1 pl-3.5 sm:pl-4">
          {kind ? <LabTag size="md">{kind}</LabTag> : null}
          {foundation ? <LabTag size="md">{foundation}</LabTag> : null}
          {coedu ? <LabTag size="md">{coedu}</LabTag> : null}
        </div>
      )}

      {address ? (
        <p className="mt-2 flex gap-1.5 pl-3.5 detail-meta sm:pl-4">
          <MapPin
            className="mt-[3px] size-3.5 shrink-0 text-[color:var(--lab-muted)]"
            aria-hidden
          />
          <span className="min-w-0 break-words">{address}</span>
        </p>
      ) : null}

      {(office || foundedOn) && (
        <p className="mt-1 pl-3.5 detail-meta sm:pl-4">
          {[office, foundedOn ? `설립/개교 ${foundedOn}` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      {(tel || homepageHref) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-4 pl-3.5 text-sm leading-5 sm:pl-4">
          {tel ? (
            <a
              href={`tel:${tel.replace(/\s+/g, "")}`}
              className="inline-flex min-h-11 min-w-0 items-center gap-1.5 font-medium text-[color:var(--lab-teal-700)] underline-offset-2 hover:underline"
            >
              <Phone className="size-3.5 shrink-0" aria-hidden />
              <span className="tabular-nums">{tel}</span>
            </a>
          ) : null}
          {homepageHref ? (
            <a
              href={homepageHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 min-w-0 items-center gap-1.5 font-medium text-[color:var(--lab-teal-700)] underline-offset-2 hover:underline"
            >
              <Globe className="size-3.5 shrink-0" aria-hidden />
              <span className="break-all">{homepageLabel(homepage!)}</span>
            </a>
          ) : null}
        </div>
      )}
    </header>
  );
}
