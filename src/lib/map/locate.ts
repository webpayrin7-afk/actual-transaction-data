/**
 * 지도 브리핑 항목 → 지도 위치 한 곳. 단지 이름(+구·동)으로 단지 하나의 좌표를 찾고,
 * 단지를 못 찾으면 그 동(없으면 구) 단지들의 가운데로 대신한다. 한 번에 한 곳만 — 목록·대량 조회 없음.
 * 좌표는 지도와 같은 규칙: NAVER 중심점(complex_map_anchor) 우선, 없으면 필지 대표점.
 */
import type { Client } from "@libsql/client";
import { normalizeAptName } from "@/lib/db/repository";

export type MapLocateResult =
  | { kind: "complex"; complexId: string; aptName: string; lat: number; lng: number }
  | { kind: "region"; label: string; lat: number; lng: number };

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "");

/** "성남시 분당구" ↔ "성남시분당구" / "분당구" — 공백 없이 한쪽이 다른 쪽을 품으면 같은 구로 본다 */
function sameGu(a: string, b: string): boolean {
  const x = squash(a);
  const y = squash(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(y) || y.endsWith(x);
}

function validLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat > 32 && lat < 39.5 && lng > 124 && lng < 132;
}

async function complexRows(db: Client, norm: string, anchored: boolean) {
  const lat = anchored ? "COALESCE(a.lat, m.latitude)" : "m.latitude";
  const lng = anchored ? "COALESCE(a.lng, m.longitude)" : "m.longitude";
  return db.execute({
    sql: `SELECT m.complex_id, m.apt_name, m.lawd_cd, m.sigungu, m.legal_dong_name, ${lat} AS lat, ${lng} AS lng
          FROM apt_complex_master m
          ${anchored ? "LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id" : ""}
          WHERE m.apt_name_norm = ?
          LIMIT 20`,
    args: [norm],
  });
}

export async function locateForMap(
  db: Client,
  q: {
    name: string;
    gu: string;
    dong: string | null;
    /** 항목 링크의 지역(region slug)에서 푼 시군구 코드 — '남구'처럼 여러 시에 같은 구 이름이 있을 때 가른다 */
    lawdCodes?: string[];
  },
): Promise<MapLocateResult | null> {
  const lawds = (q.lawdCodes ?? []).filter((c) => /^\d{5}$/.test(c));
  const norm = normalizeAptName(q.name);
  if (norm) {
    let res;
    try {
      res = await complexRows(db, norm, true);
    } catch (error) {
      if (!/no such table/i.test(String(error))) throw error;
      res = await complexRows(db, norm, false);
    }
    const rows = res.rows
      .map((r) => ({
        id: String(r.complex_id),
        name: String(r.apt_name ?? q.name),
        lawd: String(r.lawd_cd ?? ""),
        gu: String(r.sigungu ?? ""),
        dong: String(r.legal_dong_name ?? ""),
        lat: Number(r.lat),
        lng: Number(r.lng),
      }))
      .filter((r) => validLatLng(r.lat, r.lng));
    // 같은 이름이 여러 곳이면 구·동이 맞는 곳. 구를 모르면 이름이 하나일 때만.
    // 코드가 맞는 곳 먼저, 없으면(링크 지역이 기본값인 경우 등) 구 이름으로
    const byLawd = lawds.length ? rows.filter((r) => lawds.includes(r.lawd)) : [];
    const inGu = byLawd.length ? byLawd : rows.filter((r) => sameGu(r.gu, q.gu));
    const hit =
      inGu.find((r) => q.dong && squash(r.dong) === squash(q.dong)) ??
      inGu[0] ??
      (rows.length === 1 && !q.gu ? rows[0] : undefined);
    if (hit) return { kind: "complex", complexId: hit.id, aptName: hit.name, lat: hit.lat, lng: hit.lng };
  }

  // 단지를 못 찾으면 동(없으면 구) 단지들의 가운데
  if (lawds.length) {
    // 시군구 코드를 알면 그걸로 — idx_acm_lawd
    const marks = lawds.map(() => "?").join(",");
    const avg = async (dong: string | null) =>
      (
        await db.execute({
          sql: `SELECT AVG(latitude) AS lat, AVG(longitude) AS lng FROM apt_complex_master
                WHERE lawd_cd IN (${marks}) ${dong ? "AND legal_dong_name = ?" : ""}
                  AND latitude IS NOT NULL AND longitude IS NOT NULL`,
          args: dong ? [...lawds, dong] : lawds,
        })
      ).rows[0];
    const d = q.dong ? await avg(q.dong.trim()) : null;
    if (d && validLatLng(Number(d.lat), Number(d.lng))) {
      return { kind: "region", label: `${q.gu} ${q.dong}`.trim(), lat: Number(d.lat), lng: Number(d.lng) };
    }
    const g = await avg(null);
    if (g && validLatLng(Number(g.lat), Number(g.lng))) {
      return { kind: "region", label: q.gu, lat: Number(g.lat), lng: Number(g.lng) };
    }
    return null;
  }
  // 코드를 모르면 구 이름으로 — idx_acm_sigungu_dong
  if (!q.gu) return null;
  const guCandidates = [q.gu.trim(), squash(q.gu), q.gu.trim().split(/\s+/).pop() ?? ""].filter(
    (v, i, a) => v && a.indexOf(v) === i,
  );
  for (const gu of guCandidates) {
    const withDong = q.dong
      ? await db.execute({
          sql: `SELECT AVG(latitude) AS lat, AVG(longitude) AS lng FROM apt_complex_master
                WHERE sigungu = ? AND legal_dong_name = ? AND latitude IS NOT NULL AND longitude IS NOT NULL`,
          args: [gu, q.dong.trim()],
        })
      : null;
    const d = withDong?.rows[0];
    if (d && validLatLng(Number(d.lat), Number(d.lng))) {
      return { kind: "region", label: `${q.gu} ${q.dong}`, lat: Number(d.lat), lng: Number(d.lng) };
    }
    const g = (
      await db.execute({
        sql: `SELECT AVG(latitude) AS lat, AVG(longitude) AS lng FROM apt_complex_master
              WHERE sigungu = ? AND latitude IS NOT NULL AND longitude IS NOT NULL`,
        args: [gu],
      })
    ).rows[0];
    if (g && validLatLng(Number(g.lat), Number(g.lng))) {
      return { kind: "region", label: q.gu, lat: Number(g.lat), lng: Number(g.lng) };
    }
  }
  return null;
}
