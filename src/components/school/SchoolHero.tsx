import { Globe, Phone } from "lucide-react";
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

/**
 * 학교급·설립·성별 색 — 값마다 다른 연한 배경 + 진한 글자 (글자 대비 4.5:1 이상).
 * 초·중·고 / 공립·사립·국립 / 남·여·남녀공학. 토큰은 globals.css `--lab-school-*`.
 */
function kindTone(label: string): string {
  if (/초등/.test(label)) return "elementary";
  if (/중학/.test(label)) return "middle";
  if (/고등|고교/.test(label)) return "high";
  if (/공립/.test(label)) return "public";
  if (/사립/.test(label)) return "private";
  if (/국립/.test(label)) return "national";
  if (/공학/.test(label)) return "coed";
  if (/^여/.test(label) || /여자/.test(label)) return "girls";
  if (/^남/.test(label) || /남자/.test(label)) return "boys";
  return "neutral";
}

/** 제목 위 색 라벨 (배지형 12px, policy §3). */
function KindChip({ children }: { children: string }) {
  const tone = kindTone(children);
  return (
    <span
      className="inline-flex h-6 items-center rounded-md px-2 text-[12px] font-semibold leading-4"
      style={{
        background: `var(--lab-school-${tone}-bg)`,
        color: `var(--lab-school-${tone}-ink)`,
      }}
    >
      {children}
    </span>
  );
}

/** 전화·홈페이지 — 아이콘 + 청록 텍스트 링크. 누르면 전화 걸기 / 새 창으로 홈페이지. 44px 터치. */
function ContactLink({
  href,
  external,
  icon: Icon,
  label,
  children,
}: {
  href: string;
  external?: boolean;
  icon: typeof Phone;
  label: string;
  children: string;
}) {
  return (
    <a
      href={href}
      aria-label={label}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="inline-flex min-h-11 min-w-0 items-center gap-1.5 text-[14px] font-medium leading-5 text-[color:var(--lab-brand-primary)] tabular-nums underline-offset-2 hover:underline"
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <span className="truncate">{children}</span>
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
          <div className="flex flex-col gap-1" aria-label="학교 기본정보">
            {area || office || founded ? (
              <div className="flex flex-wrap gap-1">
                {area ? (
                  <span title={address ?? undefined}>
                    <LabTag size="md">{area}</LabTag>
                  </span>
                ) : null}
                {office ? <LabTag size="md">{office}</LabTag> : null}
                {founded ? <LabTag size="md">{founded}</LabTag> : null}
              </div>
            ) : null}
            {/* 전화 · 홈페이지는 한 줄 */}
            {tel || homepageHref ? (
              <div className="flex min-w-0 flex-nowrap items-center gap-x-4">
                {tel ? (
                  <ContactLink
                    href={`tel:${tel.replace(/\s+/g, "")}`}
                    icon={Phone}
                    label={`전화 걸기 ${tel}`}
                  >
                    {tel}
                  </ContactLink>
                ) : null}
                {homepageHref ? (
                  <ContactLink
                    href={homepageHref}
                    external
                    icon={Globe}
                    label={`홈페이지 열기 ${homepageLabel(homepage!)}`}
                  >
                    {homepageLabel(homepage!)}
                  </ContactLink>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </PageHeader>
    </header>
  );
}
