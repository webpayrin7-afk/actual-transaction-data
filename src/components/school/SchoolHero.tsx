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

/**
 * 학교 상세 헤더 — PageHeader(뒤로가기 · 제목) + 요약 라벨 한 줄 (policy §12.2).
 * 주소·교육청·연락처처럼 긴 값은 헤더에 두지 않고 기본정보 섹션의 라벨·값 행으로 보낸다.
 */
export function SchoolHero({
  name,
  kind,
  foundation,
  coedu,
  address,
  backHref,
}: {
  name: string;
  kind: string | null;
  foundation: string | null;
  coedu: string | null;
  address: string | null;
  backHref: string;
}) {
  const tags = [kind, foundation, coedu, schoolAreaLabel(address)].filter(
    (t): t is string => Boolean(t),
  );

  return (
    <header className="-mt-1 sm:-mt-1.5">
      <PageHeader
        leading={<BackLink fallback={backHref} compact hideLabel preferFallback />}
        title={name}
        titleClassName="detail-page-title"
        showDivider={false}
        meta={
          tags.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1">
              {tags.map((t) => (
                <LabTag key={t} size="md">
                  {t}
                </LabTag>
              ))}
            </div>
          ) : undefined
        }
      />
    </header>
  );
}
