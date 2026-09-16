/**
 * SINGOGA_V2 rebuild wiring helpers (Stage17).
 *
 * When ENABLE_SINGOGA_V2=1, market/stats rebuild may overlay primary priors
 * from the shared V2 classifier for trades that map to unit-master complexes.
 *
 * When flag OFF: callers must not invoke these overlays — legacy path only.
 * Public snapshot persistence is unchanged unless a rebuild is run with flag ON
 * (Stage17 keeps Production/Preview OFF; QA is dry-run/shadow only).
 */

import type { Client } from "@libsql/client";
import {
  loadSingogaV2BundlesBatched,
  SINGOGA_V2_COMPLEX_CHUNK,
  type SingogaV2ComplexRef,
} from "@/lib/unit-type/singoga-v2-batch";
import {
  classifySingogaV2ForComplex,
  type SingogaV2TxResult,
} from "@/lib/unit-type/singoga-v2";
import { isSingogaV2Enabled } from "@/lib/unit-type/singoga-v2-gate";

export type SingogaV2CandidateTrade = {
  id: string;
  aptNameNorm: string;
  lawdCd: string;
  dealDate: string;
  exclusiveArea: number;
  dealAmount: number;
};

export type SingogaV2PriorOverlay = {
  /** Primary prior amount for V2 judgment; 0 when no prior (matches legacy prior>0 gate). */
  priorMaxAmount: number;
  primarySingogaV2: boolean;
  exactOnlySingoga: boolean;
  baselineMode: SingogaV2TxResult["baselineMode"];
  groupKey: string | null;
  exactPriorMax: number | null;
  groupPriorMax: number | null;
};

/**
 * Resolve complex refs for candidate (norm, lawd) pairs via apt_complex_master.
 * Chunked; no per-trade SQL.
 */
async function resolveComplexRefsForCandidates(
  db: Client,
  candidates: SingogaV2CandidateTrade[],
  chunkSize = SINGOGA_V2_COMPLEX_CHUNK,
): Promise<SingogaV2ComplexRef[]> {
  const pairKey = (n: string, l: string) => `${n}\0${l}`;
  const uniquePairs: Array<{ aptNameNorm: string; lawdCd: string }> = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const k = pairKey(c.aptNameNorm, c.lawdCd);
    if (seen.has(k)) continue;
    seen.add(k);
    uniquePairs.push({ aptNameNorm: c.aptNameNorm, lawdCd: c.lawdCd });
  }

  const refs: SingogaV2ComplexRef[] = [];
  for (let i = 0; i < uniquePairs.length; i += chunkSize) {
    const slice = uniquePairs.slice(i, i + chunkSize);
    const ph = slice.map(() => "(?, ?)").join(", ");
    const args: string[] = [];
    for (const p of slice) {
      args.push(p.aptNameNorm, p.lawdCd);
    }
    const r = await db.execute({
      sql: `SELECT complex_id, apt_name_norm, lawd_cd
            FROM apt_complex_master
            WHERE (apt_name_norm, lawd_cd) IN (${ph})
              AND complex_id LIKE 'cx_%'`,
      args,
    });
    for (const row of r.rows) {
      refs.push({
        complexId: String(row.complex_id),
        aptNameNorm: String(row.apt_name_norm),
        lawdCd: String(row.lawd_cd),
      });
    }
  }
  return refs;
}

/**
 * Compute V2 primary prior overlays for candidate trades.
 * Only covers trades belonging to loaded cx_ complexes; others omitted
 * (caller keeps legacy exact prior for those).
 *
 * Requires ENABLE_SINGOGA_V2=1; returns empty map when flag OFF.
 */
export async function computeSingogaV2PriorOverlays(
  db: Client,
  candidates: SingogaV2CandidateTrade[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  byTxId: Map<string, SingogaV2PriorOverlay>;
  classifiedTxCount: number;
  complexCount: number;
}> {
  const byTxId = new Map<string, SingogaV2PriorOverlay>();
  if (!isSingogaV2Enabled(env) || candidates.length === 0) {
    return { byTxId, classifiedTxCount: 0, complexCount: 0 };
  }

  const refs = await resolveComplexRefsForCandidates(db, candidates);
  if (refs.length === 0) {
    return { byTxId, classifiedTxCount: 0, complexCount: 0 };
  }

  // Prefer complexes that also have unit-type masters (V1 groups live there).
  const unitKeys = await db.execute(
    `SELECT DISTINCT complex_key FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  const unitSet = new Set(unitKeys.rows.map((r) => String(r.complex_key)));
  const scoped = refs.filter((r) => unitSet.has(r.complexId));
  if (scoped.length === 0) {
    return { byTxId, classifiedTxCount: 0, complexCount: 0 };
  }

  const { bundles } = await loadSingogaV2BundlesBatched(db, scoped);
  const candidateIds = new Set(candidates.map((c) => c.id));

  let classifiedTxCount = 0;
  for (const bundle of bundles.values()) {
    const { results } = classifySingogaV2ForComplex({
      complexId: bundle.complexId,
      trades: bundle.trades,
      groups: bundle.groups,
      windowStart: "1900-01-01",
    });
    for (const r of results) {
      if (!candidateIds.has(r.txId)) continue;
      classifiedTxCount += 1;
      byTxId.set(r.txId, {
        priorMaxAmount: r.primaryPriorMax ?? 0,
        primarySingogaV2: r.primarySingogaV2,
        exactOnlySingoga: r.exactOnlySingoga,
        baselineMode: r.baselineMode,
        groupKey: r.groupKey,
        exactPriorMax: r.exactPriorMax,
        groupPriorMax: r.groupPriorMax,
      });
    }
  }

  return { byTxId, classifiedTxCount, complexCount: scoped.length };
}

/**
 * Apply V2 primary prior overlay onto a legacy prior map (mutates copy).
 * Only replaces entries present in the overlay.
 */
export function applySingogaV2PriorOverlay(
  legacyPriorByTxId: Map<string, number>,
  overlay: Map<string, SingogaV2PriorOverlay>,
): Map<string, number> {
  const out = new Map(legacyPriorByTxId);
  for (const [id, v] of overlay) {
    out.set(id, v.priorMaxAmount);
  }
  return out;
}
