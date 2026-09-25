"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Crown } from "lucide-react";
import { LabSection } from "@/components/ui/LabSection";
import { LabMoreButton } from "@/components/ui/LabMoreButton";
import { ComplexTypeDongMap } from "@/components/apt/ComplexTypeDongMap";
import { pickLatestDeal } from "@/lib/deals/latest";
import { formatDealDate, formatEok } from "@/lib/utils/format";
import type { UnitTypeInfo } from "@/lib/apt/unit-types-dongs";
import type { AptAreaOption, AptHistoryItem } from "@/lib/molit/apt-client";

async function fetchTypes(complexId: string): Promise<{ types: UnitTypeInfo[] }> {
  const res = await fetch(`/api/complex-types/${complexId}`);
  if (!res.ok) return { types: [] };
  return res.json();
}

const PICK = {
  date: (i: AptHistoryItem) => i.dealDate,
  floor: (i: AptHistoryItem) => (Number.isFinite(i.floor) ? i.floor : null),
  amount: (i: AptHistoryItem) => i.dealAmount,
  gbn: (i: AptHistoryItem) => i.dealingGbn ?? null,
};

const DONG_PREVIEW = 12;

/**
 * 전용면적이 같고 공급면적 차이가 1㎡ 미만인 타입은 한 타입으로 본다 (측정 차이 — 네이버 부동산도 한 줄로 합친다).
 * 공급면적은 세대가 가장 많은 값, 세대수·동별 세대는 더한다. 타입 글자가 서로 다르면 합치지 않는다.
 */
function mergeNearSupply(types: UnitTypeInfo[]): UnitTypeInfo[] {
  const out: UnitTypeInfo[] = [];
  for (const t of [...types].sort((a, b) => (b.households ?? 0) - (a.households ?? 0))) {
    const host = out.find(
      (o) =>
        Math.abs(o.exclusiveSqm - t.exclusiveSqm) < 0.005 &&
        o.supplySqm != null &&
        t.supplySqm != null &&
        Math.abs(o.supplySqm - t.supplySqm) < 1 &&
        (o.typeName ?? "") === (t.typeName ?? ""),
    );
    if (!host) {
      out.push({ ...t, dongs: [...t.dongs] });
      continue;
    }
    host.households = (host.households ?? 0) + (t.households ?? 0);
    for (const d of t.dongs) {
      const hit = host.dongs.find((x) => x.dong === d.dong);
      if (hit) hit.households += d.households;
      else host.dongs.push({ ...d });
    }
    host.dongs.sort((a, b) => a.dong.localeCompare(b.dong, "ko", { numeric: true }));
  }
  return out.sort((a, b) => a.exclusiveSqm - b.exclusiveSqm || (a.supplySqm ?? 0) - (b.supplySqm ?? 0));
}

const sameSqm = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * 타입 이름 — 네이버(109.29A㎡)와 호갱노노(109A)의 중간: 공급면적 소수 둘째 자리 + 타입 글자
 *  - 분양 공고(청약홈) 타입 글자가 있으면 그대로: "114.19A/C㎡"
 *  - 글자가 없고 공급면적 정수가 다른 타입과 겹치면, 겹치는 타입끼리 전용면적이 작은 순서로 A·B·C: "109.29A㎡", "109.47B㎡"
 *    (공식 이름이 아니라 구분용)
 *  - 겹치지 않으면 "111.52㎡", 공급면적을 모르면 "전용 84.88㎡"
 */
function supplyLabels(types: UnitTypeInfo[]): Map<string, string> {
  const out = new Map<string, string>();
  const groups = new Map<number, UnitTypeInfo[]>();
  const sup = (v: number) => v.toFixed(2);
  for (const t of types) {
    if (t.supplySqm == null) {
      out.set(t.id, `전용 ${t.exclusiveSqm.toFixed(2)}㎡`);
      continue;
    }
    if (t.typeName) {
      out.set(t.id, `${sup(t.supplySqm)}${t.typeName}㎡`);
      continue;
    }
    const whole = Math.floor(t.supplySqm);
    groups.set(whole, [...(groups.get(whole) ?? []), t]);
  }
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.set(list[0]!.id, `${sup(list[0]!.supplySqm!)}㎡`);
      continue;
    }
    const sorted = [...list].sort((x, y) => x.exclusiveSqm - y.exclusiveSqm || (x.supplySqm ?? 0) - (y.supplySqm ?? 0));
    sorted.forEach((t, i) => out.set(t.id, `${sup(t.supplySqm!)}${String.fromCharCode(65 + i)}㎡`));
  }
  return out;
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-[14px] leading-5 tabular-nums transition active:scale-[0.97] ${
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
    queryFn: () => fetchTypes(complexId),
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
      meta={selectedArea ? selectedArea.label : "전체 평형"}
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
      <p className="detail-meta -mt-1 tabular-nums">
        공급 {type.supplySqm ?? "—"}㎡ · 전용 {type.exclusiveSqm}㎡
        {type.households != null ? ` · ${type.households.toLocaleString("ko-KR")}세대` : ""}
      </p>

      <dl className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-[color:var(--lab-border)] px-3 py-2">
          <dt className="detail-label">최근 매매</dt>
          <dd className="detail-data-value-emphasis tabular-nums">{latest ? formatEok(Number(latest.dealAmount)) : "거래 없음"}</dd>
          {latest ? (
            <dd className="detail-meta tabular-nums">
              {formatDealDate(latest.dealDate)}
              {Number.isFinite(latest.floor) ? ` · ${latest.floor}층` : ""}
            </dd>
          ) : null}
        </div>
        <div className="rounded-xl border border-[color:var(--lab-border)] px-3 py-2">
          <dt className="detail-label">최근 1년</dt>
          <dd className="detail-data-value-emphasis tabular-nums">{trades1y.length.toLocaleString("ko-KR")}건</dd>
          {trades1y.length ? (
            <dd className="detail-meta tabular-nums">
              {formatEok(Math.min(...trades1y.map((t) => Number(t.dealAmount))))}~
              {formatEok(Math.max(...trades1y.map((t) => Number(t.dealAmount))))}
            </dd>
          ) : null}
        </div>
      </dl>
      {sharedExclusive.length ? (
        <p className="detail-meta -mt-1">전용면적이 같은 다른 타입({sharedExclusive.map((t) => labels.get(t.id)).join(", ")})과는 실거래를 나눌 수 없어 합쳐서 보여줘요.</p>
      ) : null}

      {type.dongs.length ? (
        <ComplexTypeDongMap
          complexId={complexId}
          typeDongs={type.dongs.map((d) => d.dong)}
          typeLabel={labels.get(type.id) ?? ""}
          pickedDong={dong?.dong ?? null}
          onPickDong={(d) => setPickedDong(d)}
        />
      ) : null}

      {type.dongs.length ? (
        <div className="flex flex-col gap-2">
          <p className="detail-subsection-title">
            이 타입이 있는 동 <span className="detail-meta font-normal">{type.dongs.length}개 동</span>
          </p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="동">
            {(allDongs ? type.dongs : type.dongs.slice(0, DONG_PREVIEW)).map((d) => (
              <Chip key={d.dong} on={d.dong === dong?.dong} onClick={() => setPickedDong(d.dong === dong?.dong ? null : d.dong)}>
                {d.dong}
              </Chip>
            ))}
          </div>
          {type.dongs.length > DONG_PREVIEW ? (
            <LabMoreButton
              expanded={allDongs}
              onToggle={() => setAllDongs((v) => !v)}
              label={`${type.dongs.length - DONG_PREVIEW}개 동 더보기`}
            />
          ) : null}
          {dong ? (
            <div className="flex flex-col gap-2 rounded-xl bg-[color:var(--lab-surface-subtle)] px-3 py-2.5">
              <p className="detail-body">
                <span className="font-semibold">{dong.dong}</span>에 이 타입 {dong.households.toLocaleString("ko-KR")}세대
              </p>
              {otherTypesInDong.length > 1 ? (
                <>
                  <p className="detail-meta">{dong.dong}의 다른 타입</p>
                  <div className="flex flex-wrap gap-2">
                    {otherTypesInDong.map((t) =>
                      inArea.some((x) => x.id === t.id) ? (
                        <Chip key={t.id} on={t.id === type.id} onClick={() => setPickedType(t.id)}>
                          {labels.get(t.id)}
                        </Chip>
                      ) : (
                        // 다른 평형 타입 — 위 평형 선택을 바꾸면 볼 수 있다
                        <span
                          key={t.id}
                          className="inline-flex min-h-9 items-center rounded-full border border-dashed border-[color:var(--lab-border)] px-3 text-[14px] leading-5 text-[color:var(--lab-muted)] tabular-nums"
                        >
                          {t.pyeongLabel ? `${t.pyeongLabel} · ` : ""}
                          {labels.get(t.id)}
                        </span>
                      ),
                    )}
                  </div>
                </>
              ) : (
                <p className="detail-meta">{dong.dong}은 이 타입만 있어요.</p>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="detail-meta">이 타입의 동별 정보는 아직 없어요.</p>
      )}
    </LabSection>
  );
}
