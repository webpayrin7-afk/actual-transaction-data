"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

export type SeoulRankGu = {
  lawdCd: string;
  name: string;
  pyeongPrice: number;
  change1y: number | null;
  priceRank: number;
  change1yRank: number | null;
};

export type SeoulRank = {
  status: "ok";
  yearMonth: string;
  total: number;
  lawdCd: string;
  priceRank: number | null;
  change1yRank: number | null;
  gus?: SeoulRankGu[];
};

type Kind = "price" | "change";

const WINDOW = 5;

function shortName(name: string): string {
  return name.replace(/^서울(특별시)?\s*/, "");
}

function changeText(v: number | null): string {
  if (v == null) return "—";
  return `${v > 0 ? "▲" : v < 0 ? "▼" : ""} ${Math.abs(v).toFixed(1)}%`.trim();
}

function RankList({ rank, kind }: { rank: SeoulRank; kind: Kind }) {
  const [showAll, setShowAll] = useState(false);
  const rankOf = (g: SeoulRankGu) => (kind === "price" ? g.priceRank : g.change1yRank);
  const list = (rank.gus ?? [])
    .filter((g) => rankOf(g) != null)
    .sort((a, b) => rankOf(a)! - rankOf(b)!);
  const at = list.findIndex((g) => g.lawdCd === rank.lawdCd);
  const start = Math.max(0, Math.min(at - Math.floor(WINDOW / 2), list.length - WINDOW));
  const shown = showAll ? list : list.slice(start, start + WINDOW);
  const title = kind === "price" ? "시세 평당가 순위" : "1년 상승률 순위";

  return (
    <div className="mt-2 rounded-xl border border-[color:var(--lab-border)] px-3 py-2">
      <p className="detail-meta">
        서울 {rank.total}개 구 {title} · {rank.yearMonth.slice(0, 4)}.{rank.yearMonth.slice(4, 6)}
      </p>
      <ol className={`mt-1 ${showAll ? "max-h-64 overflow-y-auto" : ""}`}>
        {shown.map((g) => {
          const mine = g.lawdCd === rank.lawdCd;
          const change = g.change1y;
          return (
            <li
              key={g.lawdCd}
              aria-current={mine ? "true" : undefined}
              className={`-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] leading-5 tabular-nums ${
                mine
                  ? "bg-[color:var(--lab-brand-subtle)] font-semibold text-[color:var(--lab-navy-950)]"
                  : "text-[color:var(--lab-body)]"
              }`}
            >
              <span className="w-7 shrink-0 text-right text-slate-500">{rankOf(g)}위</span>
              <span className="min-w-0 flex-1 truncate">{shortName(g.name)}</span>
              {kind === "price" ? (
                <span className="shrink-0 whitespace-nowrap">
                  {g.pyeongPrice.toLocaleString("ko-KR")}만원/평
                </span>
              ) : (
                <span
                  className="shrink-0 whitespace-nowrap"
                  style={{
                    color:
                      change == null || change === 0
                        ? undefined
                        : change > 0
                          ? "var(--lab-change-up)"
                          : "var(--lab-change-down)",
                  }}
                >
                  {changeText(change)}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {list.length > WINDOW ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-0.5 inline-flex min-h-[44px] items-center text-[13px] font-semibold leading-5 hover:underline"
          style={{ color: "var(--lab-brand-primary)" }}
        >
          {showAll ? "접기" : `${list.length}개 구 전체 보기`}
        </button>
      ) : null}
    </div>
  );
}

export function RegionSeoulRankBadges({ rank }: { rank: SeoulRank }) {
  const [open, setOpen] = useState<Kind | null>(null);
  const hasList = (rank.gus?.length ?? 0) > 1;
  const badges: { kind: Kind; text: string }[] = [];
  if (rank.priceRank != null) {
    badges.push({ kind: "price", text: `서울 ${rank.total}개 구 중 ${rank.priceRank}위` });
  }
  if (rank.change1yRank != null) {
    badges.push({ kind: "change", text: `1년 상승률 ${rank.change1yRank}위` });
  }
  if (!badges.length) return null;

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-1.5">
        {badges.map((b) => {
          const active = open === b.kind;
          const pill =
            "inline-flex h-7 items-center gap-0.5 rounded-full border px-2.5 text-[13px] font-semibold leading-5 tabular-nums";
          const style = {
            background: "var(--lab-brand-subtle)",
            borderColor: active ? "var(--lab-brand-primary)" : "var(--lab-brand-border)",
            color: "var(--lab-brand-primary)",
          };
          if (!hasList) {
            return (
              <span key={b.kind} className={pill} style={style}>
                {b.text}
              </span>
            );
          }
          return (
            <button
              key={b.kind}
              type="button"
              aria-expanded={active}
              onClick={() => setOpen(active ? null : b.kind)}
              className={`${pill} relative before:absolute before:-inset-y-2 before:inset-x-0 before:content-['']`}
              style={style}
            >
              {b.text}
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${active ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
          );
        })}
      </div>
      {open ? <RankList key={open} rank={rank} kind={open} /> : null}
    </div>
  );
}
