/**
 * Auto-select up to 2 nearby/similar complexes for detail compare.
 * Bounded catalog + transaction queries only — no full scans.
 *
 * 빠른 길(콜드 1왕복): 후보 목록(apt_catalog)·세대수·면적 집계 스냅샷(apt_trade_area_stats)+신선도를
 * 동시에(병렬 execute) 읽는다. 구의 법정동코드 중 하나라도 게시 번호가 현재 거래 변경 번호와
 * 다르면(갱신 전·갱신 중) 면적 집계만 라이브 쿼리로 읽는다(결과는 같음).
 * 빠른 길이 실패하면(표 없음 등) 예전 순차 경로로 간다.
 * db.batch 는 쓰지 않는다 — 트랜잭션으로 묶여 다른 쓰기(동기화 등)가 돌 때 수 초~수십 초 멈춘다
 * (2026-09-26 측정: 같은 SELECT 가 execute 0.2s, batch("read") 6.8s~100s+).
 */
import type { Client, InStatement, Row } from "@libsql/client";
import { getDb } from "@/lib/db/client";
import { normalizeAptName } from "@/lib/db/repository";
import {
  ALL_REGIONS,
  districtNameFromCode,
  type RegionDef,
} from "@/lib/constants/regions";
import {
  parseStatsJson,
  peerAreaSnapshotStatement,
  rankPeerAreaRows,
  sameMarks,
  splitPeerAreaSnapshot,
  type AreaStatTuple,
  type PeerAreaRow,
} from "@/lib/complex-detail/peer-area-stats";
// regionFromGu mirrors molit/apt (not exported).

export type ComparePeerCandidate = {
  aptName: string;
  regionSlug: string;
  gu: string;
  dong: string;
  sameLegalDong: boolean;
  bestExclusiveArea: number | null;
  areaGap: number | null;
  buildYear: number | null;
  householdCount: number | null;
  latestDealDate: string;
  dealCount: number;
};

export type SelectComparePeersInput = {
  aptName: string;
  gu: string;
  dong: string;
  /** Target exclusive ㎡ center from current area selection */
  targetExclusiveCenter: number | null;
  buildYear: number | null;
  householdCount: number | null;
  limit?: number;
};

function regionFromGu(gu: string): RegionDef | undefined {
  return ALL_REGIONS.find((r) => {
    if (r.metro === "seoul") return gu.includes(r.name) || r.name === gu;
    return (
      gu.includes(r.name) ||
      r.districts.some((d) => gu.includes(d.name) || d.name === gu)
    );
  });
}

let lawdCodesByGu: Map<string, string[]> | null = null;

/**
 * transactions.gu 는 적재 시 districtNameFromCode(sggCd|lawdCd) 로만 채워진다.
 * 그 역(표시명 → 법정동코드)으로 lawd_cd 를 좁혀 idx_tx_trade_lawd_apt_ym 범위 검색을
 * 하게 한다. gu = ? 조건은 그대로 두므로 결과 행은 gu 만으로 거른 것과 같다.
 * (2026-09-26 전체 매매 5.09M 행 검증: gu 가 비어 있지 않은 행은 모두
 * gu = districtNameFromCode(lawd_cd).)
 */
function lawdCodesForGu(gu: string): string[] {
  if (!lawdCodesByGu) {
    const map = new Map<string, string[]>();
    for (const region of ALL_REGIONS) {
      for (const d of region.districts) {
        const name = districtNameFromCode(d.code);
        if (!name) continue;
        const list = map.get(name) ?? [];
        if (!list.includes(d.code)) list.push(d.code);
        map.set(name, list);
      }
    }
    lawdCodesByGu = map;
  }
  return lawdCodesByGu.get(gu) ?? [];
}

function asStr(v: unknown): string {
  return v == null ? "" : String(v);
}

function asNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type CatalogRow = {
  aptName: string;
  aptNameNorm: string;
  gu: string;
  dong: string;
  dealCount: number;
  latestDealDate: string;
  sameLegalDong: boolean;
};

// 1) Bounded catalog: legalDong first, then same gu.
const DONG_CATALOG_SQL = `SELECT apt_name, apt_name_norm, gu, dong, deal_count, latest_deal_date
                  FROM apt_catalog
                  WHERE gu = ? AND dong = ? AND apt_name_norm != ?
                    AND deal_count > 0
                  ORDER BY latest_deal_date DESC
                  LIMIT 30`;
const GU_CATALOG_SQL = `SELECT apt_name, apt_name_norm, gu, dong, deal_count, latest_deal_date
                FROM apt_catalog
                WHERE gu = ? AND apt_name_norm != ?
                  AND deal_count > 0
                ORDER BY latest_deal_date DESC
                LIMIT 24`;
const NEED_GU_BELOW = 12;

// 3) Optional household counts from master/profile (same gu/dong scope).
// Profile coverage is sparse — only attach when household_count > 0.
// Missing values are omitted from UI and skipped in household-gap scoring.
function householdStatement(gu: string, dong: string): InStatement {
  return dong.length > 0
    ? {
        sql: `SELECT m.apt_name, p.household_count
                  FROM apt_complex_master m
                  LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
                  WHERE m.sigungu = ? AND m.legal_dong_name = ?
                    AND p.household_count IS NOT NULL AND p.household_count > 0
                  LIMIT 60`,
        args: [gu, dong],
      }
    : {
        sql: `SELECT m.apt_name, p.household_count
                  FROM apt_complex_master m
                  LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
                  WHERE m.sigungu = ?
                    AND p.household_count IS NOT NULL AND p.household_count > 0
                  LIMIT 80`,
        args: [gu],
      };
}

function buildCatalog(dong: string, dongRows: Row[], guRows: Row[]): CatalogRow[] {
  const byNorm = new Map<string, CatalogRow>();
  for (const row of dongRows) {
    const norm = asStr(row.apt_name_norm);
    if (!norm || byNorm.has(norm)) continue;
    byNorm.set(norm, {
      aptName: asStr(row.apt_name),
      aptNameNorm: norm,
      gu: asStr(row.gu),
      dong: asStr(row.dong),
      dealCount: asNum(row.deal_count) ?? 0,
      latestDealDate: asStr(row.latest_deal_date),
      sameLegalDong: true,
    });
  }
  for (const row of guRows) {
    const norm = asStr(row.apt_name_norm);
    if (!norm || byNorm.has(norm)) continue;
    const rowDong = asStr(row.dong);
    byNorm.set(norm, {
      aptName: asStr(row.apt_name),
      aptNameNorm: norm,
      gu: asStr(row.gu),
      dong: rowDong,
      dealCount: asNum(row.deal_count) ?? 0,
      latestDealDate: asStr(row.latest_deal_date),
      sameLegalDong: dong.length > 0 && rowDong === dong,
    });
  }
  return [...byNorm.values()];
}

function householdMap(rows: Row[]): Map<string, number> {
  const householdByNorm = new Map<string, number>();
  for (const row of rows) {
    const norm = normalizeAptName(asStr(row.apt_name));
    const hh = asNum(row.household_count);
    if (norm && hh != null && hh > 0) householdByNorm.set(norm, hh);
  }
  return householdByNorm;
}

function toAreaRows(rows: Row[]): PeerAreaRow[] {
  return rows.map((row) => ({
    aptNameNorm: asStr(row.apt_name_norm),
    exclusiveArea: Number(row.exclusive_area),
    buildYear: (row.build_year ?? null) as number | string | null,
    c: Number(row.c),
  }));
}

/**
 * 2) Area + build year from trades of these candidates only (bounded IN list) — 라이브.
 * gu 만 주면 통계 없는 플래너가 deal_type 인덱스로 전국 매매를 훑는다(10~30초, 504).
 * gu 의 법정동코드로 (lawd_cd, apt_name_norm) 매매 부분 인덱스를 타게 한다 — 기간 제한
 * 없이 같은 행·같은 집계(비교 결과 동일). 코드를 모르는 gu 만 예전 쿼리로 둔다.
 */
async function liveAreaRows(
  db: Client,
  gu: string,
  lawdCodes: string[],
  norms: string[],
): Promise<PeerAreaRow[]> {
  const ph = norms.map(() => "?").join(",");
  const areaRes = await db.execute(
    lawdCodes.length > 0
      ? {
          sql: `SELECT apt_name_norm, exclusive_area, build_year, COUNT(*) AS c
                FROM transactions INDEXED BY idx_tx_trade_lawd_apt_ym
                WHERE lawd_cd IN (${lawdCodes.map(() => "?").join(",")})
                  AND apt_name_norm IN (${ph}) AND deal_type = 'trade'
                  AND gu = ? AND exclusive_area > 0
                GROUP BY apt_name_norm, exclusive_area, build_year
                ORDER BY c DESC
                LIMIT 400`,
          args: [...lawdCodes, ...norms, gu],
        }
      : {
          sql: `SELECT apt_name_norm, exclusive_area, build_year, COUNT(*) AS c
                FROM transactions
                WHERE gu = ? AND apt_name_norm IN (${ph}) AND deal_type = 'trade'
                  AND exclusive_area > 0
                GROUP BY apt_name_norm, exclusive_area, build_year
                ORDER BY c DESC
                LIMIT 400`,
          args: [gu, ...norms],
        },
  );
  return toAreaRows(areaRes.rows);
}

type Loaded = {
  catalog: CatalogRow[];
  areaRows: PeerAreaRow[];
  householdByNorm: Map<string, number>;
  /** 진단용: 면적 집계를 어디서 읽었나 */
  areaSource: "snapshot" | "live";
};

/** 예전 순차 경로(카탈로그 → 면적 라이브 → 세대수). */
async function loadSequential(
  db: Client,
  gu: string,
  dong: string,
  selfNorm: string,
  lawdCodes: string[],
): Promise<Loaded | null> {
  const dongRows =
    dong.length > 0
      ? (await db.execute({ sql: DONG_CATALOG_SQL, args: [gu, dong, selfNorm] }))
          .rows
      : [];
  const needGu = dongRows.length < NEED_GU_BELOW;
  const guRows = needGu
    ? (await db.execute({ sql: GU_CATALOG_SQL, args: [gu, selfNorm] })).rows
    : [];
  const catalog = buildCatalog(dong, dongRows, guRows);
  if (catalog.length === 0) return null;

  const areaRows = await liveAreaRows(
    db,
    gu,
    lawdCodes,
    catalog.map((c) => c.aptNameNorm),
  );

  let householdByNorm = new Map<string, number>();
  try {
    const masterRes = await db.execute(householdStatement(gu, dong));
    householdByNorm = householdMap(masterRes.rows);
  } catch {
    // Master/profile may be unavailable — scoring continues without households.
  }
  return { catalog, areaRows, householdByNorm, areaSource: "live" };
}

/**
 * 빠른 길: 카탈로그(동·구)·세대수·스냅샷(+법정동코드별 변경 번호)을 병렬로 한 번에 읽는다.
 * 스냅샷 행은 두 카탈로그 쿼리와 같은 조건의 서브쿼리로 후보를 고른다(합집합 — JS 에서 실제 후보로 거름).
 * 번호가 하나라도 현재와 다르면(갱신 전·갱신 중) 면적 집계만 라이브로 읽는다. 표가 없는 등
 * 읽기 에러는 호출한 쪽이 예전 순차(라이브) 경로로 보낸다.
 */
async function loadFast(
  db: Client,
  gu: string,
  dong: string,
  selfNorm: string,
  lawdCodes: string[],
): Promise<Loaded | null> {
  const hasDong = dong.length > 0;
  const normsSubquery = hasDong
    ? `SELECT apt_name_norm FROM (${DONG_CATALOG_SQL})
       UNION SELECT apt_name_norm FROM (${GU_CATALOG_SQL})`
    : `SELECT apt_name_norm FROM (${GU_CATALOG_SQL})`;
  const normsArgs = hasDong ? [gu, dong, selfNorm, gu, selfNorm] : [gu, selfNorm];

  const [dongRes, guRes, householdRes, snapRes] = await Promise.all([
    hasDong
      ? db.execute({ sql: DONG_CATALOG_SQL, args: [gu, dong, selfNorm] })
      : Promise.resolve(null),
    db.execute({ sql: GU_CATALOG_SQL, args: [gu, selfNorm] }),
    db.execute(householdStatement(gu, dong)),
    db.execute(
      peerAreaSnapshotStatement(lawdCodes, gu, {
        subquery: normsSubquery,
        args: normsArgs,
      }),
    ),
  ]);
  const dongRows = dongRes?.rows ?? [];
  const guRowsAll = guRes.rows;
  const householdRows = householdRes.rows;

  const needGu = dongRows.length < NEED_GU_BELOW;
  const catalog = buildCatalog(dong, dongRows, needGu ? guRowsAll : []);
  if (catalog.length === 0) return null;
  const householdByNorm = householdMap(householdRows);
  const norms = catalog.map((c) => c.aptNameNorm);

  const live = async (): Promise<Loaded> => ({
    catalog,
    areaRows: await liveAreaRows(db, gu, lawdCodes, norms),
    householdByNorm,
    areaSource: "live",
  });

  const first = splitPeerAreaSnapshot(snapRes.rows, lawdCodes);
  if (!first.fresh) return live();

  const wanted = new Set(norms);
  const stored = new Map<string, AreaStatTuple[][]>();
  let broken = false;
  const collect = (rows: Row[]) => {
    for (const row of rows) {
      const norm = asStr(row.apt_name_norm);
      if (!wanted.has(norm)) continue;
      const tuples = parseStatsJson(row.stats_json);
      if (!tuples) {
        broken = true;
        continue;
      }
      const list = stored.get(norm) ?? [];
      list.push(tuples);
      stored.set(norm, list);
    }
  };
  collect(first.statRows);
  if (broken) return live();
  // 서브쿼리와 카탈로그 쿼리의 동률 순서가 어긋나 문장이 보지 못한 후보만 한 번 더 읽는다(보통 없음).
  // 문장이 본 후보인데 행이 없으면 조건(매매·면적>0)에 맞는 거래가 없는 것 — 라이브도 행이 없다.
  const missing = norms.filter((n) => !first.seenNorms.has(n));
  if (missing.length > 0) {
    const extraRes = await db.execute(
      peerAreaSnapshotStatement(lawdCodes, gu, { list: missing }),
    );
    const extra = splitPeerAreaSnapshot(extraRes.rows, lawdCodes);
    // 두 읽기 사이에 갱신이 끼면 섞지 않는다
    if (!extra.fresh || !sameMarks(first.marks, extra.marks)) return live();
    collect(extra.statRows);
    if (broken) return live();
  }

  const areaRows = rankPeerAreaRows(
    [...stored].flatMap(([aptNameNorm, lists]) =>
      lists.map((tuples) => ({ aptNameNorm, tuples })),
    ),
  );
  return { catalog, areaRows, householdByNorm, areaSource: "snapshot" };
}

/**
 * Deterministic peer pick: same legalDong > same sigungu,
 * then area / build-year / household proximity. Recent deals required.
 */
export async function selectComparePeers(
  input: SelectComparePeersInput,
): Promise<ComparePeerCandidate[]> {
  const db = getDb();
  if (!db) return [];

  const aptName = input.aptName.trim();
  const gu = input.gu.trim();
  const dong = input.dong.trim();
  if (!aptName || !gu) return [];

  const selfNorm = normalizeAptName(aptName);
  const limit = Math.min(Math.max(input.limit ?? 2, 1), 2);
  const targetCenter = input.targetExclusiveCenter;
  const lawdCodes = lawdCodesForGu(gu);

  let loaded: Loaded | null | undefined;
  if (lawdCodes.length > 0) {
    try {
      loaded = await loadFast(db, gu, dong, selfNorm, lawdCodes);
    } catch (err) {
      // 스냅샷 테이블이 아직 없거나 읽기 실패 — 예전 순차 경로로 같은 결과를 만든다.
      console.warn(
        "[complex-compare-peers] fast read failed, falling back:",
        err instanceof Error ? err.message : err,
      );
      loaded = undefined;
    }
  }
  if (loaded === undefined) {
    loaded = await loadSequential(db, gu, dong, selfNorm, lawdCodes);
  }
  if (!loaded) return [];
  return scorePeers(input, loaded, targetCenter, limit);
}

function scorePeers(
  input: SelectComparePeersInput,
  loaded: Loaded,
  targetCenter: number | null,
  limit: number,
): ComparePeerCandidate[] {
  const { catalog, areaRows, householdByNorm } = loaded;

  type AreaAgg = {
    bestArea: number | null;
    areaGap: number | null;
    buildYear: number | null;
  };
  const areaByNorm = new Map<string, AreaAgg>();
  for (const row of areaRows) {
    const norm = row.aptNameNorm;
    const area = asNum(row.exclusiveArea);
    const by = asNum(row.buildYear);
    if (!norm || area == null) continue;
    const gap =
      targetCenter != null && Number.isFinite(targetCenter)
        ? Math.abs(area - targetCenter)
        : null;
    const prev = areaByNorm.get(norm);
    if (!prev) {
      areaByNorm.set(norm, { bestArea: area, areaGap: gap, buildYear: by });
      continue;
    }
    if (
      gap != null &&
      (prev.areaGap == null || gap < prev.areaGap - 0.0001)
    ) {
      areaByNorm.set(norm, {
        bestArea: area,
        areaGap: gap,
        buildYear: by ?? prev.buildYear,
      });
    } else if (prev.buildYear == null && by != null) {
      areaByNorm.set(norm, { ...prev, buildYear: by });
    }
  }

  const MAX_AREA_GAP = 18; // refuse silent 84↔114 style matches at selection time

  const scored = catalog
    .map((c) => {
      const agg = areaByNorm.get(c.aptNameNorm);
      const areaGap = agg?.areaGap ?? null;
      const bestArea = agg?.bestArea ?? null;
      const buildYear = agg?.buildYear ?? null;
      const householdCount = householdByNorm.get(c.aptNameNorm) ?? null;

      // Prefer candidates with a usable area match when target is known.
      if (
        targetCenter != null &&
        areaGap != null &&
        areaGap > MAX_AREA_GAP
      ) {
        return null;
      }
      // Soft-exclude when we have a target but no area signal at all.
      if (targetCenter != null && areaGap == null) {
        return null;
      }

      let score = 0;
      if (c.sameLegalDong) score += 1_000_000;
      score += Math.min(c.dealCount, 5_000); // recent-trade presence
      if (areaGap != null) score -= Math.round(areaGap * 1_000);
      if (
        input.buildYear != null &&
        buildYear != null &&
        input.buildYear > 0 &&
        buildYear > 0
      ) {
        score -= Math.abs(input.buildYear - buildYear) * 80;
      }
      if (
        input.householdCount != null &&
        householdCount != null &&
        input.householdCount > 0 &&
        householdCount > 0
      ) {
        const hhGap = Math.abs(input.householdCount - householdCount);
        score -= Math.min(hhGap, 8_000) * 0.05;
      }

      const region = regionFromGu(c.gu);
      if (!region) return null;

      return {
        peer: {
          aptName: c.aptName,
          regionSlug: region.slug,
          gu: c.gu,
          dong: c.dong,
          sameLegalDong: c.sameLegalDong,
          bestExclusiveArea: bestArea,
          areaGap,
          buildYear,
          householdCount,
          latestDealDate: c.latestDealDate,
          dealCount: c.dealCount,
        } satisfies ComparePeerCandidate,
        score,
        latestDealDate: c.latestDealDate,
      };
    })
    .filter(Boolean) as Array<{
    peer: ComparePeerCandidate;
    score: number;
    latestDealDate: string;
  }>;

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.latestDealDate.localeCompare(a.latestDealDate);
  });

  return scored.slice(0, limit).map((s) => s.peer);
}

/** 검증 스크립트용: 두 경로(스냅샷·라이브)의 면적 집계 행을 그대로 돌려준다. */
export async function debugLoadComparePeerAreaRows(input: {
  aptName: string;
  gu: string;
  dong: string;
}): Promise<{ fast: Loaded | null; sequential: Loaded | null } | null> {
  const db = getDb();
  if (!db) return null;
  const gu = input.gu.trim();
  const dong = input.dong.trim();
  const selfNorm = normalizeAptName(input.aptName.trim());
  const lawdCodes = lawdCodesForGu(gu);
  if (lawdCodes.length === 0) return null;
  const fast = await loadFast(db, gu, dong, selfNorm, lawdCodes);
  const sequential = await loadSequential(db, gu, dong, selfNorm, lawdCodes);
  return { fast, sequential };
}

/** 검증 스크립트용: 내부 단계(라이브 순차 읽기·점수) — 요청 경로에서 쓰지 않는다. */
export const comparePeersDebug = { lawdCodesForGu, loadSequential, scorePeers };
export type ComparePeersLoaded = Loaded;
