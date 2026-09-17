import { MapPin, Phone, Globe } from "lucide-react";
import { BackLink } from "@/components/layout/BackLink";

function homepageLabel(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function HeroChip({
  children,
  tone,
}: {
  children: string;
  tone: "kind" | "foundation" | "coedu";
}) {
  const toneClass =
    tone === "kind"
      ? "border-sky-200/80 bg-sky-50 text-sky-800"
      : tone === "foundation"
        ? "border-[color-mix(in_srgb,var(--lab-teal-600)_28%,transparent)] bg-[var(--lab-teal-50)] text-[var(--lab-teal-700)]"
        : "border-violet-200/80 bg-violet-50 text-violet-800";

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-none ${toneClass}`}
    >
      {children}
    </span>
  );
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

  const secondary = [foundedOn ? `설립/개교 ${foundedOn}` : null, office]
    .filter(Boolean)
    .join(" · ");

  return (
    <header className="px-3 pt-2 sm:px-4 sm:pt-3">
      <div className="flex items-center">
        <BackLink
          fallback={backHref}
          compact
          hideLabel
          preferFallback
          className="-ml-1"
        />
      </div>

      {(kind || foundation || coedu) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {kind ? <HeroChip tone="kind">{kind}</HeroChip> : null}
          {foundation ? (
            <HeroChip tone="foundation">{foundation}</HeroChip>
          ) : null}
          {coedu ? <HeroChip tone="coedu">{coedu}</HeroChip> : null}
        </div>
      )}

      <h1 className="mt-2 text-[1.375rem] font-semibold leading-7 tracking-tight text-slate-900 sm:text-[1.5rem] sm:leading-8">
        {name}
      </h1>

      {address ? (
        <p className="mt-2 flex gap-1.5 text-[12px] leading-5 text-slate-600 sm:text-[13px]">
          <MapPin
            className="mt-0.5 size-3.5 shrink-0 text-slate-400"
            aria-hidden
          />
          <span className="min-w-0 break-words">{address}</span>
        </p>
      ) : null}

      {(tel || homepageHref) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] leading-5 sm:text-[13px]">
          {tel ? (
            <a
              href={`tel:${tel.replace(/\s+/g, "")}`}
              className="inline-flex min-w-0 items-center gap-1.5 font-medium text-[color:var(--lab-teal-700)] underline-offset-2 hover:underline"
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
              className="inline-flex min-w-0 items-center gap-1.5 font-medium text-[color:var(--lab-teal-700)] underline-offset-2 hover:underline"
            >
              <Globe className="size-3.5 shrink-0" aria-hidden />
              <span className="break-all">{homepageLabel(homepage!)}</span>
            </a>
          ) : null}
        </div>
      )}

      {secondary ? (
        <p className="mt-2 text-[11px] leading-4 text-slate-500 sm:text-[12px] sm:leading-5">
          {secondary}
        </p>
      ) : null}
    </header>
  );
}
