/**
 * SINGOGA_V2 batched / chunked data loader (Stage17).
 *
 * Rebuild-scope complex list → chunk → transactions once → groups once →
 * links once → in-memory partition by complex.
 *
 * No per-complex trade/group/link query loop.
 * No per-transaction prior SQL.
 * No unbounded all-Seoul single load (caller chunks complex scope).
 */

import type { Client, InArgs } from "@libsql/client";
import {
  isEligibleSingogaV2GroupSource,
  singogaV2AreaKey,
  type SingogaV2Group,
  type SingogaV2Trade,
} from "@/lib/unit-type/singoga-v2";

/** Reasonable IN-clause chunk; matches existing market CHUNK≈100 convention. */
export const SINGOGA_V2_COMPLEX_CHUNK = 50;

export type SingogaV2ComplexRef = {
  complexId: string;
  aptNameNorm: string;
  lawdCd: string;
};

export type SingogaV2ComplexBundle = {
  complexId: string;
  aptNameNorm: string;
  lawdCd: string;
  trades: Array<
    SingogaV2Trade & {
      firstSeenAt: string | null;
      discoveryAt: string | null;
      dong: string;
    }
  >;
  groups: SingogaV2Group[];
};

export type SingogaV2QueryTiming = {
  queryType: "transactions" | "groups" | "links" | "master";
  rowsReturned: number;
  elapsedMs: number;
};

export type SingogaV2BatchLoadStats = {
  complexCount: number;
  chunkCount: number;
  chunkSize: number;
  transactionFetchQueries: number;
  groupFetchQueries: number;
  linkFetchQueries: number;
  masterLookupQueries: number;
  totalDbQueries: number;
  historyRows: number;
  perComplexQueryPattern: boolean;
  perTransactionQuery: boolean;
  /** Optional per-query timings when opts.collectTimings is true. */
  queryTimings?: SingogaV2QueryTiming[];
  phaseMs?: {
    transactionsFetch: number;
    groupsFetch: number;
    linksFetch: number;
    normalizePartition: number;
  };
};

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Resolve cx_ unit-master complexes (bounded population) from apt_unit_types.
 * Masters fetched in chunks — not one query per complex.
 */
export async function loadCxUnitMasterComplexes(
  db: Client,
  chunkSize = SINGOGA_V2_COMPLEX_CHUNK,
): Promise<{
  complexes: SingogaV2ComplexRef[];
  queryCount: number;
}> {
  const keys = await db.execute(
    `SELECT DISTINCT complex_key FROM apt_unit_types
     WHERE complex_key LIKE 'cx_%' ORDER BY complex_key`,
  );
  const complexIds = keys.rows.map((r) => String(r.complex_key));
  let queryCount = 1;
  const complexes: SingogaV2ComplexRef[] = [];

  for (const chunk of chunkArray(complexIds, chunkSize)) {
    const ph = chunk.map(() => "?").join(",");
    const m = await db.execute({
      sql: `SELECT complex_id, apt_name_norm, lawd_cd
            FROM apt_complex_master
            WHERE complex_id IN (${ph})`,
      args: chunk as InArgs,
    });
    queryCount += 1;
    const byId = new Map<string, { aptNameNorm: string; lawdCd: string }>();
    for (const row of m.rows) {
      byId.set(String(row.complex_id), {
        aptNameNorm: String(row.apt_name_norm),
        lawdCd: String(row.lawd_cd),
      });
    }
    for (const id of chunk) {
      const hit = byId.get(id);
      if (!hit) continue;
      complexes.push({
        complexId: id,
        aptNameNorm: hit.aptNameNorm,
        lawdCd: hit.lawdCd,
      });
    }
  }

  return { complexes, queryCount };
}

/**
 * Batch-load trades + V1 groups + links for a rebuild-scope complex list.
 * Chunks complex IDs; partitions results in memory.
 */
export async function loadSingogaV2BundlesBatched(
  db: Client,
  complexes: SingogaV2ComplexRef[],
  opts?: { chunkSize?: number; collectTimings?: boolean },
): Promise<{
  bundles: Map<string, SingogaV2ComplexBundle>;
  stats: SingogaV2BatchLoadStats;
}> {
  const chunkSize = opts?.chunkSize ?? SINGOGA_V2_COMPLEX_CHUNK;
  const collectTimings = opts?.collectTimings === true;
  const queryTimings: SingogaV2QueryTiming[] = [];
  let transactionsFetchMs = 0;
  let groupsFetchMs = 0;
  let linksFetchMs = 0;
  let normalizePartitionMs = 0;

  const bundles = new Map<string, SingogaV2ComplexBundle>();
  for (const c of complexes) {
    bundles.set(c.complexId, {
      complexId: c.complexId,
      aptNameNorm: c.aptNameNorm,
      lawdCd: c.lawdCd,
      trades: [],
      groups: [],
    });
  }

  let transactionFetchQueries = 0;
  let groupFetchQueries = 0;
  let linkFetchQueries = 0;
  let historyRows = 0;

  const pairKey = (norm: string, lawd: string) => `${norm}\0${lawd}`;
  const complexByPair = new Map<string, string>();
  for (const c of complexes) {
    complexByPair.set(pairKey(c.aptNameNorm, c.lawdCd), c.complexId);
  }

  for (const chunk of chunkArray(complexes, chunkSize)) {
    // A. transactions — one query per chunk.
    // Prefer OR of (apt_name_norm, lawd_cd) equality pairs so SQLite can use
    // idx_tx_lawd_apt_ym / idx_tx_apt_norm instead of scanning via
    // idx_tx_type_first_seen + bloom filters on row-value IN.
    const pairArgs: Array<string> = [];
    const pairPredicates: string[] = [];
    for (const c of chunk) {
      pairPredicates.push("(apt_name_norm = ? AND lawd_cd = ?)");
      pairArgs.push(c.aptNameNorm, c.lawdCd);
    }
    const tTx0 = collectTimings ? performance.now() : 0;
    const txRes = await db.execute({
      sql: `SELECT id, deal_date, exclusive_area, deal_amount,
                   first_seen_at, discovery_at, dong,
                   apt_name_norm, lawd_cd
            FROM transactions
            WHERE (${pairPredicates.join(" OR ")})
              AND deal_type = 'trade'
              AND exclusive_area IS NOT NULL AND exclusive_area > 0
              AND deal_amount IS NOT NULL AND deal_amount > 0`,
      args: pairArgs as InArgs,
    });
    const tTx1 = collectTimings ? performance.now() : 0;
    transactionFetchQueries += 1;
    if (collectTimings) {
      const elapsed = Math.round((tTx1 - tTx0) * 100) / 100;
      transactionsFetchMs += elapsed;
      queryTimings.push({
        queryType: "transactions",
        rowsReturned: txRes.rows.length,
        elapsedMs: elapsed,
      });
    }
    const tNorm0 = collectTimings ? performance.now() : 0;
    for (const row of txRes.rows) {
      const cid = complexByPair.get(
        pairKey(String(row.apt_name_norm), String(row.lawd_cd)),
      );
      if (!cid) continue;
      const b = bundles.get(cid);
      if (!b) continue;
      b.trades.push({
        id: String(row.id),
        dealDate: String(row.deal_date).slice(0, 10),
        exclusiveArea: Number(row.exclusive_area),
        dealAmount: Number(row.deal_amount),
        firstSeenAt:
          row.first_seen_at == null || row.first_seen_at === ""
            ? null
            : String(row.first_seen_at),
        discoveryAt:
          row.discovery_at == null || row.discovery_at === ""
            ? null
            : String(row.discovery_at),
        dong: String(row.dong ?? ""),
      });
      historyRows += 1;
    }
    if (collectTimings) {
      normalizePartitionMs +=
        Math.round((performance.now() - tNorm0) * 100) / 100;
    }

    // B. V1 groups — one query per chunk
    const idPh = chunk.map(() => "?").join(",");
    const idArgs = chunk.map((c) => c.complexId);
    const tG0 = collectTimings ? performance.now() : 0;
    const gRes = await db.execute({
      sql: `SELECT group_key, complex_key, exclusive_area_min, exclusive_area_max, source
            FROM apt_pyeong_groups
            WHERE complex_key IN (${idPh})`,
      args: idArgs as InArgs,
    });
    const tG1 = collectTimings ? performance.now() : 0;
    groupFetchQueries += 1;
    if (collectTimings) {
      const elapsed = Math.round((tG1 - tG0) * 100) / 100;
      groupsFetchMs += elapsed;
      queryTimings.push({
        queryType: "groups",
        rowsReturned: gRes.rows.length,
        elapsedMs: elapsed,
      });
    }

    const eligibleGroupKeys: string[] = [];
    const groupMeta = new Map<
      string,
      {
        complexKey: string;
        source: string;
        exclusiveAreaMin: number;
        exclusiveAreaMax: number;
      }
    >();
    for (const g of gRes.rows) {
      const source = String(g.source ?? "");
      if (!isEligibleSingogaV2GroupSource(source)) continue;
      const groupKey = String(g.group_key);
      eligibleGroupKeys.push(groupKey);
      groupMeta.set(groupKey, {
        complexKey: String(g.complex_key),
        source,
        exclusiveAreaMin: Number(g.exclusive_area_min),
        exclusiveAreaMax: Number(g.exclusive_area_max),
      });
    }

    // C. links — one query per chunk (all eligible groups in chunk)
    const membersByGroup = new Map<string, number[]>();
    if (eligibleGroupKeys.length > 0) {
      for (const gkChunk of chunkArray(eligibleGroupKeys, chunkSize)) {
        const gkPh = gkChunk.map(() => "?").join(",");
        const tL0 = collectTimings ? performance.now() : 0;
        const lRes = await db.execute({
          sql: `SELECT group_key, unit_type_key
                FROM apt_unit_type_group_links
                WHERE group_key IN (${gkPh})`,
          args: gkChunk as InArgs,
        });
        const tL1 = collectTimings ? performance.now() : 0;
        linkFetchQueries += 1;
        if (collectTimings) {
          const elapsed = Math.round((tL1 - tL0) * 100) / 100;
          linksFetchMs += elapsed;
          queryTimings.push({
            queryType: "links",
            rowsReturned: lRes.rows.length,
            elapsedMs: elapsed,
          });
        }
        for (const l of lRes.rows) {
          const gk = String(l.group_key);
          const utk = String(l.unit_type_key);
          const m = utk.match(/:ex([0-9.]+)$/);
          if (!m) continue;
          const arr = membersByGroup.get(gk) ?? [];
          arr.push(singogaV2AreaKey(Number(m[1])));
          membersByGroup.set(gk, arr);
        }
      }
    }

    const tGroupNorm0 = collectTimings ? performance.now() : 0;
    for (const [groupKey, meta] of groupMeta) {
      let members = [...new Set(membersByGroup.get(groupKey) ?? [])].sort(
        (a, b) => a - b,
      );
      if (members.length === 0) {
        members = [
          ...new Set([
            singogaV2AreaKey(meta.exclusiveAreaMin),
            singogaV2AreaKey(meta.exclusiveAreaMax),
          ]),
        ].sort((a, b) => a - b);
      }
      // Zero-span / single-canonical: not a V1 multi-area group
      if (members.length < 2) continue;
      const b = bundles.get(meta.complexKey);
      if (!b) continue;
      b.groups.push({
        groupKey,
        memberAreaKeys: members,
        source: meta.source,
      });
    }
    if (collectTimings) {
      normalizePartitionMs +=
        Math.round((performance.now() - tGroupNorm0) * 100) / 100;
    }
  }

  const chunkCount = chunkArray(complexes, chunkSize).length;
  const stats: SingogaV2BatchLoadStats = {
    complexCount: complexes.length,
    chunkCount,
    chunkSize,
    transactionFetchQueries,
    groupFetchQueries,
    linkFetchQueries,
    masterLookupQueries: 0,
    totalDbQueries:
      transactionFetchQueries + groupFetchQueries + linkFetchQueries,
    historyRows,
    perComplexQueryPattern: false,
    perTransactionQuery: false,
    ...(collectTimings
      ? {
          queryTimings,
          phaseMs: {
            transactionsFetch: Math.round(transactionsFetchMs * 100) / 100,
            groupsFetch: Math.round(groupsFetchMs * 100) / 100,
            linksFetch: Math.round(linksFetchMs * 100) / 100,
            normalizePartition: Math.round(normalizePartitionMs * 100) / 100,
          },
        }
      : {}),
  };

  return { bundles, stats };
}
