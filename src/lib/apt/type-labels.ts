/**
 * 단지 타입 이름·합치기 — 단지 상세 타입·동 섹션과 3D 단지 탐색이 같이 쓴다.
 */
import type { UnitTypeInfo } from "@/lib/apt/unit-types-dongs";

/**
 * 전용면적이 같고 공급면적 차이가 1㎡ 미만인 타입은 한 타입으로 본다 (측정 차이 — 네이버 부동산도 한 줄로 합친다).
 * 공급면적은 세대가 가장 많은 값, 세대수·동별 세대는 더한다. 타입 글자가 서로 다르면 합치지 않는다.
 */
export function mergeNearSupply(types: UnitTypeInfo[]): UnitTypeInfo[] {
  // 실거래에서만 나온 타입(공급·세대·동 모두 없음 — 예: 원베일리 전용 168.87㎡, 대장엔 없는 신고값)은 뺀다.
  // 그 거래는 위 차트·거래내역의 평형 묶음에 그대로 들어가고, 가까운 대장 타입에 붙이지는 않는다(추정 금지).
  const registered = types.filter((t) => t.supplySqm != null || (t.households ?? 0) > 0 || t.dongs.length > 0);
  const source = registered.length ? registered : types;
  const out: UnitTypeInfo[] = [];
  for (const t of [...source].sort((a, b) => (b.households ?? 0) - (a.households ?? 0))) {
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

export const sameSqm = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * 타입 이름 — 네이버(109.29A㎡)와 호갱노노(109A)의 중간: 공급면적 소수 둘째 자리 + 타입 글자
 *  - 분양 공고(청약홈) 타입 글자가 있으면 그대로: "114.19A/C㎡"
 *  - 글자가 없고 공급면적 정수가 다른 타입과 겹치면, 겹치는 타입끼리 전용면적이 작은 순서로 A·B·C: "109.29A㎡", "109.47B㎡"
 *    (공식 이름이 아니라 구분용)
 *  - 겹치지 않으면 "111.52㎡", 공급면적을 모르면 "전용 84.88㎡"
 */
export function supplyLabels(types: UnitTypeInfo[]): Map<string, string> {
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
