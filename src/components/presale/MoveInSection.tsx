"use client";

import { useState } from "react";
import { METRO_LABELS } from "@/lib/constants/regions";
import type { MoveInRegion } from "@/lib/applyhome/read";
import { useApplyhome, type PresaleMetro } from "@/components/presale/ApplyhomeSections";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";

const ym = (v: string) => `${v.slice(2, 4)}.${v.slice(4)}`;

type Row = MoveInRegion & { href: string | null; onPick?: () => void };

/**
 * 분양 — 앞으로 24개월 입주 예정 세대 (청약홈 분양 공고의 입주 예정월 · 공급 세대).
 * 전국이면 시·도별 합계(누르면 그 시·도로 좁힘), 시·도면 시·군·구별(누르면 지역 페이지).
 */
export function MoveInSection({ metro, onPickMetro }: { metro: PresaleMetro; onPickMetro: (m: string) => void }) {
  const query = useApplyhome();
  const [state, setState] = useState<{ metro: PresaleMetro; expanded: boolean }>({ metro, expanded: false });
  const expanded = state.metro === metro && state.expanded;
  const data = query.data;
  if (query.isError || !data) return null;

  const byMetro = data.moveIn.byMetro;
  const items: Row[] =
    metro === "all"
      ? Object.entries(byMetro)
          .filter(([m]) => m in METRO_LABELS && m !== "other")
          .map(([m, list]) => ({
            slug: m,
            name: METRO_LABELS[m as keyof typeof METRO_LABELS],
            households: list.reduce((s, x) => s + x.households, 0),
            projects: list.reduce((s, x) => s + x.projects, 0),
            firstYm: list.reduce((a, x) => (x.firstYm < a ? x.firstYm : a), list[0]!.firstYm),
            lastYm: list.reduce((a, x) => (x.lastYm > a ? x.lastYm : a), list[0]!.lastYm),
            href: null,
            onPick: () => onPickMetro(m),
          }))
          .sort((a, b) => b.households - a.households)
      : (byMetro[metro] ?? []).map((r) => ({ ...r, href: `/region/${r.slug}` }));
  const total = items.reduce((s, x) => s + x.households, 0);
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);
  const max = items[0]?.households ?? 1;

  return (
    <LabSection
      title="입주 예정"
      meta={items.length ? `${ym(data.moveIn.fromYm)}~${ym(data.moveIn.toYm)} · ${total.toLocaleString("ko-KR")}세대` : undefined}
      tip={
        <p>
          청약홈 분양 공고의 입주 예정월과 공급 세대(특별+일반공급)로 앞으로 24개월을 모았습니다. 재건축·재개발
          조합원 몫과 임대주택은 빠져 있어 실제 입주 물량보다 적습니다. 주소로 시·군·구를 정확히 찾지 못한 공고도
          빠집니다.
        </p>
      }
    >
      {items.length === 0 ? (
        <p className="detail-body">앞으로 24개월 안에 입주 예정인 분양 공고가 없습니다.</p>
      ) : (
        <>
          <ul className={LAB_LIST}>
            {visible.map((r) => (
              <LabListRow
                key={r.slug}
                href={r.href}
                onClick={r.onPick}
                title={r.name}
                meta={`${r.projects}곳 · ${r.firstYm === r.lastYm ? ym(r.firstYm) : `${ym(r.firstYm)}~${ym(r.lastYm)}`}`}
                value={`${r.households.toLocaleString("ko-KR")}세대`}
              >
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden>
                  <div
                    className="h-full rounded-full bg-[color:var(--lab-brand-primary)]"
                    style={{ width: `${Math.max(3, (r.households / max) * 100)}%`, opacity: 0.55 }}
                  />
                </div>
              </LabListRow>
            ))}
          </ul>
          {items.length > LAB_LIST_PREVIEW ? (
            <LabMoreButton
              expanded={expanded}
              onToggle={() => setState({ metro, expanded: !expanded })}
              label={`${items.length - LAB_LIST_PREVIEW}곳 더보기`}
            />
          ) : null}
        </>
      )}
    </LabSection>
  );
}
