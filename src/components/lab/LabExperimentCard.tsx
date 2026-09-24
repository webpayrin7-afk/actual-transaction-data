"use client";

import { useState } from "react";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { LabSection, LabSubsectionHeader, LAB_SUBSECTION_RULE } from "@/components/ui/LabSection";
import { LabShareBars } from "@/components/ui/LabShareBars";
import { LabTag } from "@/components/ui/LabTag";
import { getLabDef } from "@/lib/lab/definitions";
import type { LabBucketRow, LabExperimentResult, LabRankRow } from "@/lib/lab/types";

function fmtN(n: number): string {
  return n.toLocaleString("ko-KR");
}

function signedPct(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;
}

/** 순위 목록 — 5개 + 더보기. 온도계는 증감률, 직거래는 비중, 84㎡는 건수. */
function RankList({ id, rows }: { id: LabExperimentResult["id"]; rows: LabRankRow[] }) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return <p className="lab-state">표시할 결과가 없습니다.</p>;
  const visible = expanded ? rows : rows.slice(0, LAB_LIST_PREVIEW);
  const hidden = rows.length - LAB_LIST_PREVIEW;
  return (
    <>
      <ul className={LAB_LIST}>
        {visible.map((r) => {
          const key = `${r.rank}-${r.label}`;
          const common = { href: r.href, title: `${r.rank}. ${r.label}` };
          if (id === "volume-thermometer") {
            return (
              <LabListRow
                key={key}
                {...common}
                meta={`직전 ${fmtN(r.priorCount ?? 0)}건 → 최근 ${fmtN(r.recentCount)}건`}
                value={r.growthPct != null ? `+${r.growthPct}%` : "—"}
                valueTone="up"
              />
            );
          }
          if (id === "direct-deal") {
            return (
              <LabListRow
                key={key}
                {...common}
                meta={`매매 ${fmtN(r.priorCount ?? 0)}건 중 직거래 ${fmtN(r.recentCount)}건`}
                value={`${r.sharePct ?? 0}%`}
              />
            );
          }
          return (
            <LabListRow
              key={key}
              {...common}
              meta={r.sharePct != null ? `전체의 ${r.sharePct}%` : undefined}
              value={`${fmtN(r.recentCount)}건`}
            />
          );
        })}
      </ul>
      {hidden > 0 ? (
        <LabMoreButton expanded={expanded} onToggle={() => setExpanded((v) => !v)} label={`${hidden}곳 더보기`} />
      ) : null}
    </>
  );
}

/**
 * 비교형 막대 — 0을 가운데 둔 양방향 막대. 위(+)는 상승색, 아래(−)는 하락색.
 * 표본이 부족한 칸은 막대 없이 '표본 부족'.
 */
function DeltaBars({ rows, basis }: { rows: LabBucketRow[]; basis?: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.deltaPct ?? 0)));
  return (
    <div className="flex flex-col gap-2.5">
      {basis ? <p className="detail-meta">{basis}</p> : null}
      <ul className="flex flex-col gap-3">
        {rows.map((r) => {
          const v = r.deltaPct;
          const width = v == null ? 0 : (Math.abs(v) / max) * 50;
          const color = v == null ? "transparent" : v >= 0 ? "var(--lab-change-up)" : "var(--lab-change-down)";
          return (
            <li key={r.key} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="detail-label truncate text-[color:var(--lab-navy-950)]">{r.label}</span>
                <span className="flex shrink-0 items-baseline gap-2">
                  <span className="detail-meta tabular-nums">{fmtN(r.count)}건</span>
                  <span
                    className="detail-label w-[4.5rem] text-right font-semibold tabular-nums"
                    style={{ color: v == null ? "var(--lab-muted)" : color }}
                  >
                    {v == null ? "표본 부족" : signedPct(v)}
                  </span>
                </span>
              </div>
              <div className="relative mt-1.5 h-2 w-full rounded-full bg-[color:var(--lab-surface-subtle)]">
                <span aria-hidden className="absolute inset-y-[-3px] left-1/2 w-px bg-slate-300" />
                {v != null ? (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 rounded-full"
                    style={{
                      backgroundColor: color,
                      width: `${Math.max(width, 1)}%`,
                      ...(v >= 0 ? { left: "50%" } : { right: "50%" }),
                    }}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ShareList({ rows }: { rows: LabBucketRow[] }) {
  return (
    <LabShareBars
      sort="none"
      moreLabel={(n) => `${n}개 구간 더보기`}
      items={rows.map((b) => ({
        key: b.key,
        label: b.label,
        value: b.count,
        percent: b.sharePct,
        sub: `${fmtN(b.count)}건`,
      }))}
    />
  );
}

/** 실험 한 개 — 질문 · 한 줄 답 · 그래프 · 해석 · 기준 한 줄. 계산 방법(def.method)은 내부 기록용이라 보이지 않는다. */
export function LabExperimentCard({ result }: { result: LabExperimentResult }) {
  const def = getLabDef(result.id);
  const isDelta = result.buckets?.some((b) => b.deltaPct !== undefined) ?? false;

  return (
    <LabSection id={def.slug} title={def.title} label={`${def.labNo} ${def.title}`} meta={<LabTag>{def.labNo}</LabTag>}>
      <div className="flex flex-col gap-1.5">
        <p className="detail-body text-[color:var(--lab-muted)]">{def.question}</p>
        <p className="text-[22px] font-bold leading-8 tracking-tight text-[color:var(--lab-teal-700)] tabular-nums">
          {result.headline}
        </p>
        <p className="detail-body">{result.insight}</p>
      </div>

      {result.buckets && result.id !== "direct-deal" ? (
        isDelta ? (
          <DeltaBars rows={result.buckets} basis={result.deltaBasis} />
        ) : (
          <ShareList rows={result.buckets} />
        )
      ) : null}

      {result.id === "direct-deal" && result.buckets ? <ShareList rows={result.buckets} /> : null}

      {result.ranks ? (
        <div className={result.id === "direct-deal" ? `${LAB_SUBSECTION_RULE} flex flex-col gap-2` : "flex flex-col gap-2"}>
          {result.id === "direct-deal" ? (
            <LabSubsectionHeader title="직거래 비중이 높은 지역" meta="매매 50건 이상" />
          ) : null}
          <RankList id={result.id} rows={result.ranks} />
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <p className="detail-meta">
          {result.period.label}
          {result.period.priorLabel ? ` · 비교 ${result.period.priorLabel}` : ""} · 표본 {fmtN(result.totalCount)}건
        </p>
        {result.excludedNote ? <p className="detail-meta">{result.excludedNote}</p> : null}
      </div>

    </LabSection>
  );
}
