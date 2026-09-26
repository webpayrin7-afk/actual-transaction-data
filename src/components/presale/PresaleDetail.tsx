"use client";

import { useQuery } from "@tanstack/react-query";
import type { ApplyhomeDetail } from "@/lib/applyhome/read";
import { BackLink } from "@/components/layout/BackLink";
import { PAGE_HEADER_WITH_BACK, PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow, LabTextLink } from "@/components/ui/LabListRow";
import { LabStatTiles } from "@/components/ui/LabStatTiles";
import { LabTag } from "@/components/ui/LabTag";
import { kindLabel, md, priceRange, shortMan, ymDot } from "@/components/presale/ApplyhomeSections";
import { LabSectionLoading } from "@/components/ui/LabLoading";

async function fetchDetail(id: string): Promise<ApplyhomeDetail> {
  const res = await fetch(`/api/applyhome/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(res.status === 404 ? "공고를 찾지 못했습니다." : "공고를 불러오지 못했습니다.");
  return res.json();
}

const range = (a: string | null, b: string | null) => (a ? (b && b !== a ? `${md(a)}~${md(b)}` : md(a)) : null);
const pyeong = (sqm: number) => Math.round(sqm / 3.3058);

/** 분양 공고 상세 — 일정 · 주택형별 분양가 · 1순위 경쟁률 · 주변 시세 비교 */
export function PresaleDetail({ id }: { id: string }) {
  const query = useQuery({ queryKey: ["applyhome-detail", id], queryFn: () => fetchDetail(id), staleTime: 30 * 60_000 });
  const d = query.data;
  const n = d?.notice;

  if (query.isError) {
    return (
      <div className={PAGE_SHELL}>
        <BackLink fallback="/presale" compact />
        <p className="detail-body">{(query.error as Error).message}</p>
      </div>
    );
  }

  const schedule = n
    ? [
        { label: "모집공고", value: n.noticeDate ? md(n.noticeDate) : null },
        { label: "특별공급", value: n.specialBegin ? md(n.specialBegin) : null },
        { label: "1순위", value: range(n.rceptBegin, n.rceptEnd) },
        { label: "당첨 발표", value: n.winnerDate ? md(n.winnerDate) : null },
        { label: "계약", value: range(n.contractBegin, n.contractEnd) },
        { label: "입주 예정", value: n.moveInYm ? ymDot(n.moveInYm) : null },
      ].filter((x) => x.value)
    : [];

  return (
    <div className={PAGE_SHELL}>
      <div className={PAGE_HEADER_WITH_BACK}>
        <PageHeader
          leading={<BackLink fallback="/presale" compact hideLabel />}
          title={n?.name ?? "분양 공고"}
          titleClassName="detail-page-title"
          showDivider={false}
        >
          {n ? (
            <div className="flex flex-wrap gap-1">
              {[n.place, n.totalSupply ? `${n.totalSupply.toLocaleString("ko-KR")}세대` : null, kindLabel(n.kind), n.builder]
                .filter(Boolean)
                .map((t) => (
                  <LabTag key={t!} size="md">
                    {t}
                  </LabTag>
                ))}
            </div>
          ) : null}
        </PageHeader>
      </div>

      {query.isLoading || !d || !n ? (
        <>
          <LabSectionLoading title="청약 요약" minHeight={320} />
          <LabSectionLoading title="주택형별 분양가 · 경쟁률" label="주택형 불러오는 중" minHeight={360} />
        </>
      ) : (
        <>
          <LabSection title="청약 요약">
            <LabStatTiles
              columns={3}
              items={[
                { key: "price", label: "분양가", value: priceRange(n.priceMin, n.priceMax) ?? "—", sub: "주택형별 최고가" },
                {
                  key: "supply",
                  label: "공급",
                  value: `${(d.totals.generalSupply + d.totals.specialSupply).toLocaleString("ko-KR")}세대`,
                  sub: `일반 ${d.totals.generalSupply} · 특별 ${d.totals.specialSupply}`,
                },
                {
                  key: "rate",
                  label: "1순위 경쟁률",
                  value: d.totals.rate != null ? `${d.totals.rate}:1` : "—",
                  sub: d.totals.firstRankRequests ? `${d.totals.firstRankRequests.toLocaleString("ko-KR")}명 접수` : "접수 전",
                },
              ]}
            />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
              {schedule.map((s) => (
                <div key={s.label} className="flex items-baseline justify-between gap-2 border-b border-[color:var(--lab-border)] py-1.5">
                  <dt className="detail-label">{s.label}</dt>
                  <dd className="detail-data-value tabular-nums">{s.value}</dd>
                </div>
              ))}
            </dl>
            {n.address ? <p className="detail-meta">{n.address}</p> : null}
            <div className="flex flex-wrap gap-x-4">
              {n.url ? (
                <LabTextLink href={n.url} external>
                  청약홈 공고 보기
                </LabTextLink>
              ) : null}
              {n.regionHref ? <LabTextLink href={n.regionHref}>{n.place.split(" ").slice(1).join(" ") || "지역"} 시세 보기</LabTextLink> : null}
            </div>
          </LabSection>

          <LabSection
            title="주택형별 분양가 · 경쟁률"
            tip={
              <p>
                분양가는 주택형별 최고 분양가입니다. 경쟁률은 1순위 접수(해당지역+기타지역) ÷ 일반공급 세대입니다. 주변
                시세는 같은 법정동(부족하면 같은 시·군·구)에서 전용면적 ±3㎡ 아파트의 최근 12개월 매매 중위가이고,
                10년 이내 준공 단지 거래가 5건 이상이면 그것만 씁니다. 분양가와 주변 시세는 층·향·옵션이 달라 그대로
                비교할 수는 없습니다.
              </p>
            }
          >
            <ul className={LAB_LIST}>
              {d.models.map((m) => (
                <LabListRow
                  key={m.modelNo}
                  wrap
                  title={
                    <>
                      {m.typeLabel}
                      <span className="detail-meta ml-1.5 font-normal">
                        {m.supplyArea ? `공급 ${pyeong(m.supplyArea)}평` : ""}
                      </span>
                    </>
                  }
                  meta={
                    <>
                      <span className="block tabular-nums">
                        일반 {m.generalSupply} · 특별 {m.specialSupply}세대
                        {m.firstRank.rate != null
                          ? ` · 1순위 ${m.firstRank.rate}:1${m.firstRank.other ? ` (기타지역 ${m.firstRank.other.toLocaleString("ko-KR")}명)` : ""}`
                          : ""}
                      </span>
                      {m.nearby ? (
                        <span className="block tabular-nums">
                          {m.nearby.scopeName} {m.nearby.newOnly ? "신축 " : ""}
                          {m.nearby.areaFrom}~{m.nearby.areaTo}㎡ 중위 {shortMan(m.nearby.median)} ({m.nearby.count}건)
                        </span>
                      ) : (
                        <span className="block">주변 비교 거래 부족</span>
                      )}
                    </>
                  }
                  value={m.topAmount ? shortMan(m.topAmount) : "—"}
                  valueTone={m.nearby?.diffPct != null ? (m.nearby.diffPct > 0 ? "up" : "down") : undefined}
                  sub={
                    m.nearby?.diffPct != null
                      ? `주변 대비 ${m.nearby.diffPct > 0 ? "+" : "−"}${Math.abs(m.nearby.diffPct)}%`
                      : null
                  }
                />
              ))}
            </ul>
          </LabSection>
        </>
      )}
    </div>
  );
}
