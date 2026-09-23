import { BackLink } from "@/components/layout/BackLink";
import { PageHeader } from "@/components/layout/PageHeader";
import { LabTag } from "@/components/ui/LabTag";

/** "서울특별시 송파구 백제고분로 11 , 신천중학교 (잠실동)" → "송파구 잠실동" */
export function schoolAreaLabel(address: string | null): string | null {
  if (!address) return null;
  const tokens = address.split(/[\s,]+/);
  const gu =
    tokens.find((t) => /[가-힣](구|군)$/.test(t)) ??
    tokens.find((t) => /[가-힣]시$/.test(t) && !/(특별|광역|특별자치)시$/.test(t)) ??
    null;
  const dong = address.match(/\(([^),]+?(?:동|읍|면|가))[,)]/)?.[1] ?? null;
  const label = [gu, dong].filter(Boolean).join(" ");
  return label || null;
}

function homepageLabel(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** 학교급·설립·성별 — 제목 위 색 라벨 (배지형 12px, policy §3). */
function KindChip({ children }: { children: string }) {
  return (
    <span className="inline-flex h-6 items-center rounded-md bg-[color:var(--lab-brand-subtle)] px-2 text-[12px] font-semibold leading-4 text-[color:var(--lab-teal-700)]">
      {children}
    </span>
  );
}

/** 전화·홈페이지 — LabTag와 같은 모양의 링크 라벨. 보이는 26px, 숨은 영역으로 44px 터치. */
function LinkTag({ href, external, children }: { href: string; external?: boolean; children: string }) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="relative inline-flex h-[26px] max-w-full items-center truncate rounded-md border border-[color:var(--lab-border)] bg-white px-1.5 text-[12px] font-medium leading-6 text-[color:var(--lab-brand-primary)] tabular-nums before:absolute before:inset-x-0 before:-inset-y-[9px] before:content-[''] hover:underline"
    >
      {children}
    </a>
  );
}

/**
 * 학교 상세 헤더 — 제목 위: 학교급·설립·성별 색 라벨 / 제목 아래: 기본정보 라벨 행
 * (지역·교육청·개교·전화·홈페이지). 단지 상세 헤더와 같은 LabTag md 문법 (policy §12.2).
 */
export function SchoolHero({
  name,
  kind,
  foundation,
  coedu,
  address,
  office,
  foundedOn,
  tel,
  homepage,
  backHref,
}: {
  name: string;
  kind: string | null;
  foundation: string | null;
  coedu: string | null;
  address: string | null;
  office: string | null;
  foundedOn: string | null;
  tel: string | null;
  homepage: string | null;
  backHref: string;
}) {
  const kinds = [kind, foundation, coedu].filter((t): t is string => Boolean(t));
  const area = schoolAreaLabel(address);
  const founded = foundedOn ? `${foundedOn.slice(0, 4)}년 개교` : null;
  const homepageHref = homepage
    ? homepage.startsWith("http")
      ? homepage
      : `https://${homepage}`
    : null;
  const hasInfo = Boolean(area || office || founded || tel || homepageHref);

  return (
    <header className="-mt-1 sm:-mt-1.5">
      <PageHeader
        leading={<BackLink fallback={backHref} compact hideLabel preferFallback />}
        eyebrow={
          kinds.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {kinds.map((k) => (
                <KindChip key={k}>{k}</KindChip>
              ))}
            </div>
          ) : undefined
        }
        title={name}
        titleClassName="detail-page-title"
        showDivider={false}
      >
        {hasInfo ? (
          <div className="flex flex-wrap gap-1" aria-label="학교 기본정보">
            {area ? (
              <span title={address ?? undefined}>
                <LabTag size="md">{area}</LabTag>
              </span>
            ) : null}
            {office ? <LabTag size="md">{office}</LabTag> : null}
            {founded ? <LabTag size="md">{founded}</LabTag> : null}
            {tel ? <LinkTag href={`tel:${tel.replace(/\s+/g, "")}`}>{tel}</LinkTag> : null}
            {homepageHref ? (
              <LinkTag href={homepageHref} external>
                {homepageLabel(homepage!)}
              </LinkTag>
            ) : null}
          </div>
        ) : null}
      </PageHeader>
    </header>
  );
}
