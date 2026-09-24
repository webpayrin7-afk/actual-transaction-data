"use client";

import { useState } from "react";
import type { Metro } from "@/lib/constants/regions";
import { useApplyhome } from "@/components/complexes/ApplyhomeSections";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";

const ym = (v: string) => `${v.slice(2, 4)}.${v.slice(4)}`;

/** 지역 조회 — 고른 시·도의 앞으로 2년 입주 예정 세대 (청약홈 분양 공고의 입주 예정월 · 공급 세대). */
export function MoveInSection({ metro, metroLabel }: { metro: Metro; metroLabel: string }) {
  const query = useApplyhome();
  const [state, setState] = useState<{ metro: Metro; expanded: boolean }>({ metro, expanded: false });
  const expanded = state.metro === metro && state.expanded;
  const data = query.data;
  if (query.isError || !data) return null;
  const items = data.moveIn.byMetro[metro] ?? [];
  const total = items.reduce((s, x) => s + x.households, 0);
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);
  const max = items[0]?.households ?? 1;
  const from = data.moveIn.fromYm;
  const to = data.moveIn.toYm;

  return (
    <LabSection
      title={`${metroLabel} 입주 예정`}
      meta={items.length ? `${ym(from)}~${ym(to)} · ${total.toLocaleString("ko-KR")}세대` : undefined}
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
                href={`/region/${r.slug}`}
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
