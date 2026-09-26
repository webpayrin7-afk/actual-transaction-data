/**
 * 단지 타입·동 — 평형 안의 공급·전용면적 조합(타입)과 그 타입이 있는 동(건축물대장 전유부 기준 세대수).
 * 원천: apt_canonical_unit_types · unit_type_building_links · complex_buildings. 읽기 전용, 값은 원천 그대로.
 * 타입 글자(A/B 등)는 분양 공고(청약홈)에서 확인된 것만 type_name에 있다 — 없으면 면적으로 부른다.
 */
import type { Client } from "@libsql/client";

export type UnitTypeDong = { dong: string; households: number };

export type UnitTypeInfo = {
  id: string;
  exclusiveSqm: number;
  supplySqm: number | null;
  pyeongLabel: string | null;
  /** 분양 공고의 타입 글자 ("A", "A/C") — 모르면 null */
  typeName: string | null;
  households: number | null;
  dongs: UnitTypeDong[];
};

const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function dongOrder(a: string, b: string): number {
  return a.localeCompare(b, "ko", { numeric: true });
}

export async function readUnitTypesWithDongs(db: Client, complexId: string): Promise<UnitTypeInfo[]> {
  const [types, links] = await Promise.all([
    db.execute({
      sql: `SELECT unit_type_id, exclusive_area, supply_area, display_pyeong_label, type_name, household_count
            FROM apt_canonical_unit_types WHERE complex_id = ? ORDER BY exclusive_area, supply_area`,
      args: [complexId],
    }),
    db
      .execute({
        sql: `SELECT l.unit_type_id, b.dong_label, SUM(l.household_count) AS n
              FROM unit_type_building_links l JOIN complex_buildings b ON b.building_id = l.building_id
              WHERE l.complex_id = ? GROUP BY l.unit_type_id, b.dong_label`,
        args: [complexId],
      })
      .catch(() => ({ rows: [] as Array<Record<string, unknown>> })),
  ]);
  const byType = new Map<string, UnitTypeDong[]>();
  for (const r of links.rows) {
    const id = String(r.unit_type_id);
    const dong = r.dong_label == null ? "" : String(r.dong_label).trim();
    if (!dong) continue;
    const list = byType.get(id) ?? [];
    list.push({ dong, households: Number(r.n ?? 0) });
    byType.set(id, list);
  }
  return types.rows.map((r) => {
    const id = String(r.unit_type_id);
    return {
      id,
      exclusiveSqm: Number(r.exclusive_area),
      supplySqm: num(r.supply_area),
      pyeongLabel: r.display_pyeong_label == null ? null : String(r.display_pyeong_label),
      typeName: r.type_name == null || String(r.type_name).trim() === "" ? null : String(r.type_name).trim(),
      households: num(r.household_count),
      dongs: (byType.get(id) ?? []).sort((a, b) => dongOrder(a.dong, b.dong)),
    };
  });
}
