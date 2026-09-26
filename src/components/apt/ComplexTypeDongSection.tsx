"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchComplexTypes } from "@/lib/apt/area-supply";
import { mergeNearSupply, sameSqm, supplyLabels } from "@/lib/apt/type-labels";
import { Crown } from "lucide-react";
import { LabSection } from "@/components/ui/LabSection";
import { LabMoreButton } from "@/components/ui/LabMoreButton";
import { ComplexTypeDongMap } from "@/components/apt/ComplexTypeDongMap";
import { pickLatestDeal } from "@/lib/deals/latest";
import { formatDealDate, formatEok } from "@/lib/utils/format";
import type { UnitTypeInfo } from "@/lib/apt/unit-types-dongs";
import type { AptAreaOption, AptHistoryItem } from "@/lib/molit/apt-client";


const PICK = {
  date: (i: AptHistoryItem) => i.dealDate,
  floor: (i: AptHistoryItem) => (Number.isFinite(i.floor) ? i.floor : null),
  amount: (i: AptHistoryItem) => i.dealAmount,
  gbn: (i: AptHistoryItem) => i.dealingGbn ?? null,
};

/** 동 칩은 개수가 아니라 줄 수로 자른다 — 처음 3줄, 화면이 넓으면 한 줄에 더 들어간다 */
const DONG_ROWS = 3;
const CHIP_H = 36;
const CHIP_GAP = 8;
const COLLAPSED_H = DONG_ROWS * CHIP_H + (DONG_ROWS - 1) * CHIP_GAP;

/** 동 칩 묶음 — 접으면 3줄까지, 넘치면 더보기. 지도에서 고른 동이 가려져 있으면 저절로 펼친다 */
function DongChipWrap({
  dongs,
  selected,
  flash,
  expanded,
  setExpanded,
  onPick,
}: {
  dongs: string[];
  selected: string | null;
  flash: { dong: string; at: number } | null;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  onPick: (dong: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hidden, setHidden] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      let n = 0;
      for (const c of Array.from(el.children) as HTMLElement[]) if (c.offsetTop >= COLLAPSED_H) n++;
      setHidden(n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dongs]);
  useEffect(() => {
    if (!flash || expanded || !ref.current) return;
    const idx = dongs.indexOf(flash.dong);
    const chip = ref.current.children[idx] as HTMLElement | undefined;
    if (chip && chip.offsetTop >= COLLAPSED_H) setExpanded(true);
  }, [flash, expanded, dongs, setExpanded]);
  return (
    <>
      <div
        ref={ref}
        className="relative flex flex-wrap gap-2 overflow-hidden p-0.5 -m-0.5"
        role="group"
        aria-label="동"
        style={expanded ? undefined : { maxHeight: COLLAPSED_H + 4 }}
      >
        {dongs.map((d) => (
          <Chip
            key={d}
            on={d === selected}
            flash={flash?.dong === d ? flash.at : undefined}
            onClick={() => onPick(d)}
          >
            {d}
          </Chip>
        ))}
      </div>
      {hidden > 0 ? (
        <LabMoreButton expanded={expanded} onToggle={() => setExpanded(!expanded)} label={`${hidden}개 동 더보기`} />
      ) : null}
    </>
  );
}

function Chip({
  on,
  onClick,
  children,
  flash,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /** 지도에서 고른 동 — 버튼이 한 번 눌리는 모션으로 어디인지 알려 준다 */
  flash?: number;
}) {
  return (
    <button
      key={flash}
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-[14px] leading-5 tabular-nums transition active:scale-[0.97] ${flash ? "lab-chip-flash " : ""}${
        on
          ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] font-semibold text-[color:var(--lab-teal-700)]"
          : "border-[color:var(--lab-border)] bg-white font-medium text-[color:var(--lab-navy-950)]"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * 타입·동 정보 — 선택한 평형 안의 타입(공급·전용면적)별 최근 실거래와, 그 타입이 있는 동.
 * 동을 고르면 그 동의 다른 타입을 보여 준다. 평형은 페이지의 평형 선택을 따른다.
 */
export function ComplexTypeDongSection({
  complexId,
  selectedArea,
  items,
}: {
  complexId: string;
  selectedArea: AptAreaOption | null;
  items: AptHistoryItem[];
}) {
  const query = useQuery({
    queryKey: ["complex-types", complexId],
    queryFn: () => fetchComplexTypes(complexId),
    staleTime: 60 * 60 * 1000,
  });
  const all = useMemo(() => mergeNearSupply(query.data?.types ?? []), [query.data]);
  const labels = useMemo(() => supplyLabels(all), [all]);

  const inArea = useMemo(() => {
    if (!selectedArea) return all;
    const min = (selectedArea.exclusiveAreaMin ?? selectedArea.exclusiveArea) - 0.5;
    const max = (selectedArea.exclusiveAreaMax ?? selectedArea.exclusiveArea) + 0.5;
    return all.filter((t) => t.exclusiveSqm >= min && t.exclusiveSqm <= max);
  }, [all, selectedArea]);

  const [pickedType, setPickedType] = useState<string | null>(null);
  const [pickedDong, setPickedDong] = useState<string | null>(null);
  const [allDongs, setAllDongs] = useState(false);
  const [flash, setFlash] = useState<{ dong: string; at: number } | null>(null);
  const crownId = useMemo(
    () => inArea.reduce<UnitTypeInfo | null>((b, t) => (!b || (t.households ?? 0) > (b.households ?? 0) ? t : b), null)?.id ?? null,
    [inArea],
  );
  const type = inArea.find((t) => t.id === pickedType) ?? inArea.find((t) => t.id === crownId) ?? inArea[0] ?? null;
  const dong = type?.dongs.find((d) => d.dong === pickedDong) ?? null;

  const trades = useMemo(
    () => (type ? items.filter((i) => i.dealType === "trade" && sameSqm(Number(i.exclusiveArea), type.exclusiveSqm)) : []),
    [items, type],
  );
  const latest = useMemo(() => pickLatestDeal(trades, "trade", PICK), [trades]);
  const yearAgo = useMemo(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }, []);
  const trades1y = trades.filter((t) => t.dealDate >= yearAgo);
  const sharedExclusive = type ? all.filter((t) => t.id !== type.id && sameSqm(t.exclusiveSqm, type.exclusiveSqm)) : [];
  const otherTypesInDong = dong ? all.filter((t) => t.dongs.some((d) => d.dong === dong.dong)) : [];

  if (query.isLoading || !inArea.length || !type) return null;

  return (
    <LabSection
      id="section-type-dong"
      title="타입·동 정보"
      tip={
        <p>
          같은 평형 안에서도 공급면적(타입)에 따라 구조와 가격이 다릅니다. 타입은 건축물대장의 공급·전용면적으로 나누고, 동별
          세대수도 건축물대장 기준입니다. 왕관은 세대가 가장 많은 타입입니다. 분양 공고의 타입 이름이 없는 단지는 공급면적이 같은 타입을 전용면적이 작은 순서로 A·B로 구분합니다.
        </p>
      }
    >
      <div className="flex flex-wrap gap-2" role="group" aria-label="타입">
        {[...inArea].sort((x, y) => (x.supplySqm ?? 0) - (y.supplySqm ?? 0) || x.exclusiveSqm - y.exclusiveSqm).map((t) => (
          <Chip
            key={t.id}
            on={t.id === type.id}
            onClick={() => {
              setPickedType(t.id);
              setPickedDong(null);
            }}
          >
            {labels.get(t.id)}
            {t.id === crownId && inArea.length > 1 ? <Crown className="h-3.5 w-3.5 text-[#A86B00]" aria-label="대표 타입" /> : null}
          </Chip>
        ))}
      </div>

      {/* 부수 정보 — 흰 카드 두 개 (이름 / 값 / 보조) */}
      <dl className="grid grid-cols-2 gap-2 tabular-nums">
        <div className="min-w-0 rounded-xl border border-[color:var(--lab-border)] bg-white px-3 py-2">
          <dt className="text-[13px] leading-[18px] text-[color:var(--lab-muted)]">최근 매매</dt>
          <dd className="text-[16px] font-bold leading-6 text-[color:var(--lab-navy-950)]">
            {latest ? formatEok(Number(latest.dealAmount)) : "거래 없음"}
          </dd>
          {latest ? (
            <dd className="truncate text-[13px] leading-[18px] text-[color:var(--lab-muted)]">
              {formatDealDate(latest.dealDate)}
              {Number.isFinite(latest.floor) ? ` · ${latest.floor}층` : ""}
            </dd>
          ) : null}
        </div>
        <div className="min-w-0 rounded-xl border border-[color:var(--lab-border)] bg-white px-3 py-2">
          <dt className="text-[13px] leading-[18px] text-[color:var(--lab-muted)]">최근 1년 거래</dt>
          <dd className="text-[16px] font-bold leading-6 text-[color:var(--lab-navy-950)]">
            {trades1y.length.toLocaleString("ko-KR")}건
          </dd>
          {trades1y.length ? (
            <dd className="truncate text-[13px] leading-[18px] text-[color:var(--lab-muted)]">
              {formatEok(Math.min(...trades1y.map((t) => Number(t.dealAmount))))}~
              {formatEok(Math.max(...trades1y.map((t) => Number(t.dealAmount))))}
            </dd>
          ) : null}
        </div>
      </dl>
      {sharedExclusive.length ? (
        <p className="detail-meta -mt-1">
          실거래는 전용면적으로만 신고돼요. 전용 {type.exclusiveSqm.toFixed(2)}㎡가 같은{" "}
          {sharedExclusive.map((t) => labels.get(t.id)).join(", ")} 타입 거래도 위 최근 매매·거래 수에 함께 들어가 있어요.
        </p>
      ) : null}

      {type.dongs.length ? (
        <ComplexTypeDongMap
          complexId={complexId}
          typeDongs={type.dongs.map((d) => d.dong)}
          typeLabel={labels.get(type.id) ?? ""}
          pickedDong={dong?.dong ?? null}
          onPickDong={(d) => {
            setPickedDong(d);
            setFlash({ dong: d, at: Date.now() });
          }}
        />
      ) : null}

      {type.dongs.length ? (
        <div className="flex flex-col gap-2">
          <p className="detail-subsection-title">
            이 타입이 있는 동 <span className="detail-meta font-normal">{type.dongs.length}개 동</span>
          </p>
          <DongChipWrap
            dongs={type.dongs.map((d) => d.dong)}
            selected={dong?.dong ?? null}
            flash={flash}
            expanded={allDongs}
            setExpanded={setAllDongs}
            onPick={(d) => setPickedDong(d === dong?.dong ? null : d)}
          />
          {dong ? (
            // 고른 동의 타입 구성 — 지금 타입 먼저(굵게·청록 막대), 다른 타입은 회색 막대 (누르면 그 타입으로)
            (() => {
              const rows = [type, ...otherTypesInDong.filter((t) => t.id !== type.id)].map((t) => ({
                t,
                n: t.dongs.find((d) => d.dong === dong.dong)?.households ?? 0,
                inThisArea: inArea.some((x) => x.id === t.id),
              }));
              const total = rows.reduce((sum, r) => sum + r.n, 0) || 1;
              const grays = ["#94A3B8", "#CBD5E1", "#E2E8F0"];
              const color = (i: number) => (i === 0 ? "var(--lab-brand-primary)" : grays[(i - 1) % grays.length]!);
              return (
                <div className="flex flex-col gap-1.5 border-t border-[color:var(--lab-border)] pt-2.5 text-[13px] leading-[18px] tabular-nums">
                  <p className="text-[color:var(--lab-muted)]">
                    <span className="font-semibold text-[color:var(--lab-navy-950)]">{dong.dong}</span> 구성 ·{" "}
                    {total.toLocaleString("ko-KR")}세대
                  </p>
                  {/* 동 전체를 막대 하나로 — 타입별 칸 */}
                  <div className="flex h-2 w-full overflow-hidden rounded-full bg-[color:var(--lab-surface-subtle)]" aria-hidden>
                    {rows.map(({ t, n }, i) => (
                      <span key={t.id} className="h-full" style={{ width: `${(n / total) * 100}%`, background: color(i), marginLeft: i ? 1 : 0 }} />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {rows.map(({ t, n, inThisArea }, i) => {
                      const current = i === 0;
                      const body = (
                        <>
                          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color(i) }} aria-hidden />
                          <span className={current ? "font-semibold text-[color:var(--lab-navy-950)]" : "text-[color:var(--lab-muted)]"}>
                            {!inThisArea && t.pyeongLabel ? `${t.pyeongLabel} ` : ""}
                            {labels.get(t.id)} {n.toLocaleString("ko-KR")}세대
                          </span>
                        </>
                      );
                      return !current && inThisArea ? (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setPickedType(t.id)}
                          className="inline-flex items-center gap-1 underline decoration-[color:var(--lab-border)] underline-offset-2"
                          aria-label={`${labels.get(t.id)} 타입 보기`}
                        >
                          {body}
                        </button>
                      ) : (
                        <span key={t.id} className="inline-flex items-center gap-1">
                          {body}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })()
          ) : null}
        </div>
      ) : all.some((t) => t.dongs.length > 0) ? (
        // 다른 타입은 동 정보가 있는데 이 타입만 없을 때만 알린다 — 단지 전체에 동 정보가 없으면(한 동짜리 등) 조용히 둔다
        <p className="detail-meta">이 타입의 동별 정보는 아직 없어요.</p>
      ) : null}
    </LabSection>
  );
}
