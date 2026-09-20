/**
 * Fast validate + merge national_supply_area_evidence.csv.gz → canonical unit master.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { join } from "node:path";
import { createClient, type Client, type InArgs } from "@libsql/client";
import {
  areaFromCents,
  canonicalSupplyPyeong,
  canonicalUnitTypeId,
  conflictId,
  exclusiveCents,
  NO_SUPPLY_CENTS,
  resolutionStatus,
} from "../../src/lib/unit-type/canonical";
import { supplyPyeongDisplayLabel } from "../../src/lib/unit-type/supply-label";

const ROOT = "/tmp/building-hub-bulk/external-evidence";
const EVIDENCE_GZ = join(ROOT, "national_supply_area_evidence.csv.gz");
const SUMMARY_PATH = join(ROOT, "national_supply_area_evidence_summary.json");
const EXPECTED_SHA = "01a52e82453fb6e18ee8e83436bbc27ecdf862669d792db2b0e41857f3b0ce1a";
const EXPECTED_ROWS = 166973;
const BATCH = 100;

const PILOTS: Record<string, string> = {
  잠실엘스: "cx_4c63d9a100973c60",
  파크리오: "cx_ed52bf895d064c11",
  리센츠: "cx_caf229b5ac63cfbd",
  헬리오시티: "cx_30d7eea6da810b52",
  반포자이: "cx_1c244e7305d12c44",
  래미안퍼스티지: "cx_3bcf0f87bce7496b",
  은마: "cx_0320fd9e007e1f8c",
  도곡렉슬: "cx_c9ed0235ecca960c",
  마포프레스티지자이: "cx_07caf64c556e85a7",
  포레나노원: "cx_88d05e29df26a0d6",
};

type EvidenceRow = {
  complexId: string;
  exclusiveArea: number;
  supplyArea: number;
  resolutionStatus: "EXACT_SINGLE" | "AMBIGUOUS_MULTI";
  sourceUnitCount: number;
  evidenceRowCount: number;
  sourceProvider: string;
  sourceDataset: string;
  sourceMonth: string;
  sourceChecksum: string;
  derivationMethod: string;
  source: string;
  exclusiveCents: number;
  supplyCents: number;
  unreasonable: boolean;
};

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function isUnreasonable(exclusive: number, supply: number): boolean {
  if (!(exclusive > 0) || !(supply > exclusive)) return true;
  const ratio = supply / exclusive;
  if (ratio > 5) return true;
  if (exclusive < 10 && ratio > 3) return true;
  return false;
}

async function sha256Gunzip(path: string): Promise<{ digest: string; bytes: Buffer }> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .pipe(createGunzip())
      .on("data", (c: Buffer) => chunks.push(c))
      .on("end", () => resolve())
      .on("error", reject);
  });
  const bytes = Buffer.concat(chunks);
  return { digest: createHash("sha256").update(bytes).digest("hex"), bytes };
}

async function batchWrite(db: Client, statements: { sql: string; args: InArgs }[]) {
  for (let i = 0; i < statements.length; i += BATCH) {
    let last: unknown = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await db.batch(statements.slice(i, i + BATCH), "write");
        last = null;
        break;
      } catch (error) {
        last = error;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    if (last) throw last;
  }
}

async function main() {
  if (!existsSync(EVIDENCE_GZ)) throw new Error(`missing ${EVIDENCE_GZ}`);
  const summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8")) as {
    canonical_evidence: Record<string, number>;
    coverage_preview: { manifest_targets: number };
    process: { invalid_supply_unreasonable: number };
  };

  console.log("verifying artifact…");
  const { digest, bytes } = await sha256Gunzip(EVIDENCE_GZ);
  if (digest !== EXPECTED_SHA) {
    console.error(JSON.stringify({ stop: true, reason: "checksum_mismatch", digest }));
    process.exit(2);
  }
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0]!.split(",");
  const required = [
    "complex_id","exclusive_area","supply_area","supply_pyeong","resolution_status",
    "source_unit_count","evidence_row_count","source_provider","source_dataset",
    "source_month","source_checksum","derivation_method","source",
  ];
  if (header.join(",") !== required.join(",")) throw new Error("columns");
  const rows: EvidenceRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let nullComplex = 0;
  let unreasonableHeld = 0;
  const statusCounts: Record<string, number> = {};
  const floatPairs = new Map<string, Set<number>>();
  for (const line of lines.slice(1)) {
    const p = line.split(",");
    if (p.length !== 13) throw new Error("ncol");
    const complexId = p[0]!;
    if (!complexId) nullComplex += 1;
    const exclusiveArea = Number(p[1]);
    const supplyArea = Number(p[2]);
    const resolution = p[4] as EvidenceRow["resolutionStatus"];
    const key = `${complexId}|${exclusiveArea}|${supplyArea}|${resolution}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    statusCounts[resolution] = (statusCounts[resolution] ?? 0) + 1;
    const fp = `${complexId}|${exclusiveArea}`;
    const set = floatPairs.get(fp) ?? new Set();
    set.add(supplyArea);
    floatPairs.set(fp, set);
    const unreasonable = isUnreasonable(exclusiveArea, supplyArea);
    if (unreasonable) unreasonableHeld += 1;
    rows.push({
      complexId,
      exclusiveArea,
      supplyArea,
      resolutionStatus: resolution,
      sourceUnitCount: Number(p[5]),
      evidenceRowCount: Number(p[6]),
      sourceProvider: p[7]!,
      sourceDataset: p[8]!,
      sourceMonth: p[9]!,
      sourceChecksum: p[10]!,
      derivationMethod: p[11]!,
      source: p[12]!,
      exclusiveCents: exclusiveCents(exclusiveArea),
      supplyCents: exclusiveCents(supplyArea),
      unreasonable,
    });
  }
  if (digest !== EXPECTED_SHA || rows.length !== EXPECTED_ROWS || nullComplex || duplicates) {
    console.error(JSON.stringify({ stop: true, digest, rows: rows.length, nullComplex, duplicates }));
    process.exit(2);
  }
  let ambPairs = 0;
  for (const set of floatPairs.values()) if (set.size > 1) ambPairs += 1;
  const complexes = new Set(rows.map((r) => r.complexId));
  if (
    complexes.size !== summary.canonical_evidence.complexes ||
    floatPairs.size !== summary.canonical_evidence.exclusive_pairs ||
    rows.length !== summary.canonical_evidence.supply_variants ||
    (statusCounts.EXACT_SINGLE ?? 0) !== summary.canonical_evidence.EXACT_SINGLE ||
    ambPairs !== summary.canonical_evidence.AMBIGUOUS_MULTI
  ) {
    console.error(JSON.stringify({ stop: true, reason: "summary_parity", complexes: complexes.size, pairs: floatPairs.size, ambPairs, statusCounts }));
    process.exit(2);
  }
  console.log(JSON.stringify({
    artifact: "OK",
    checksum: digest,
    rows: rows.length,
    unreasonableHeldPublishedExtreme: unreasonableHeld,
    processUnreasonableAbsentFromArtifact: summary.process.invalid_supply_unreasonable,
  }));

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const now = new Date().toISOString();
  const prevTypes = num((await db.execute(`SELECT COUNT(*) n FROM apt_canonical_unit_types`)).rows[0]?.n);
  const manifestCount = num((await db.execute(`SELECT COUNT(*) n FROM apt_unit_acquisition_manifest`)).rows[0]?.n);

  const outsidePilots: string[] = [];
  for (const [name, id] of Object.entries(PILOTS)) {
    const hit = await db.execute({ sql: `SELECT 1 AS ok FROM apt_unit_acquisition_manifest WHERE complex_id=?`, args: [id] });
    if (!hit.rows.length) outsidePilots.push(`${name}:${id}`);
  }

  const existing = new Map<string, Map<number, Set<number>>>();
  const cur = await db.execute(`SELECT complex_id, exclusive_cents, supply_cents FROM apt_canonical_unit_types WHERE supply_cents >= 0`);
  for (const row of cur.rows) {
    const cid = str(row.complex_id);
    const ex = num(row.exclusive_cents);
    const su = num(row.supply_cents);
    let a = existing.get(cid);
    if (!a) { a = new Map(); existing.set(cid, a); }
    let b = a.get(ex);
    if (!b) { b = new Set(); a.set(ex, b); }
    b.add(su);
  }

  const byPair = new Map<string, EvidenceRow[]>();
  for (const row of rows) {
    const k = `${row.complexId}|${row.exclusiveCents}`;
    const list = byPair.get(k) ?? [];
    list.push(row);
    byPair.set(k, list);
  }

  const stats = {
    newTypes: 0,
    conflicts: 0,
    positiveOverwrites: 0,
    unreasonableHeld: 0,
    cacheRows: 0,
    pairUpserts: 0,
    inserts: 0,
    skippedExisting: 0,
  };

  let statements: { sql: string; args: InArgs }[] = [];
  const flush = async () => {
    if (!statements.length) return;
    const chunk = statements;
    statements = [];
    await batchWrite(db, chunk);
  };

  let processed = 0;
  for (const [, variants] of byPair) {
    processed += 1;
    const first = variants[0]!;
    const cid = first.complexId;
    const exCents = first.exclusiveCents;
    const prev = existing.get(cid)?.get(exCents) ?? new Set<number>();
    const safe = variants.filter((v) => !v.unreasonable);
    stats.unreasonableHeld += variants.length - safe.length;

    const agrees = prev.size === 0 || safe.some((v) => prev.has(v.supplyCents));
    const hardConflict = prev.size > 0 && !agrees && safe.length > 0;
    if (hardConflict) {
      for (const prevSu of prev) {
        statements.push({
          sql: `INSERT INTO apt_unit_supply_conflicts (
                  conflict_id, complex_id, exclusive_cents, held_supply_area, held_supply_cents,
                  held_source, held_source_key, reason, provenance_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'existing', 'SOURCE_CONFLICT', ?, ?)
                ON CONFLICT(conflict_id) DO NOTHING`,
          args: [
            conflictId(cid, exCents, prevSu, "existing"),
            cid,
            exCents,
            areaFromCents(prevSu),
            prevSu,
            "existing_canonical",
            JSON.stringify({ incoming: safe.map((v) => [v.exclusiveArea, v.supplyArea]) }),
            now,
          ],
        });
        stats.conflicts += 1;
        stats.inserts += 1;
      }
    }

    const combined = new Set<number>(hardConflict ? [...prev] : [...prev, ...safe.map((v) => v.supplyCents)]);
    const status = resolutionStatus(combined.size, false);

    if (!hardConflict) {
      for (const variant of safe) {
        if (prev.has(variant.supplyCents)) {
          stats.skippedExisting += 1;
          continue;
        }
        statements.push({
          sql: `INSERT INTO apt_canonical_unit_types (
                  unit_type_id, complex_id, exclusive_area, exclusive_cents, supply_area, supply_cents,
                  supply_pyeong, display_pyeong_label, type_name, household_count, source, source_key,
                  source_as_of, confidence, status, formula, provenance_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'building_registry_expos', ?, ?, ?, ?, ?)
                ON CONFLICT(unit_type_id) DO NOTHING`,
          args: [
            canonicalUnitTypeId(cid, exCents, variant.supplyCents),
            cid,
            variant.exclusiveArea,
            exCents,
            variant.supplyArea,
            variant.supplyCents,
            canonicalSupplyPyeong(variant.supplyArea),
            supplyPyeongDisplayLabel(variant.supplyArea),
            variant.sourceUnitCount,
            "BldRgstHubBulkEvidence",
            `${variant.sourceChecksum}:${exCents}:${variant.supplyCents}`,
            variant.sourceMonth,
            status,
            variant.derivationMethod,
            JSON.stringify({
              acquisition_method: "BULK_EVIDENCE",
              bulk_source_month: variant.sourceMonth,
              bulk_checksum: variant.sourceChecksum,
              source_unit_count: variant.sourceUnitCount,
              evidence_row_count: variant.evidenceRowCount,
              exclusive_area_full: variant.exclusiveArea,
            }),
            now,
            now,
          ],
        });
        statements.push({
          sql: `INSERT INTO official_unit_area_cache (
                  complex_id, source_unit_id, source_provider, source_dataset, pnu, source_building_id,
                  dong, floor, ho, exclusive_area, residential_common_area, other_common_area,
                  explicit_supply_area, contract_area, source_key, source_as_of, fetched_at, provenance_json
                ) VALUES (?, ?, ?, ?, '', '', '', '', '', ?, ?, NULL, ?, NULL, ?, ?, ?, ?)
                ON CONFLICT(complex_id, source_unit_id) DO NOTHING`,
          args: [
            cid,
            `evidence:${exCents}:${variant.supplyCents}`,
            variant.sourceProvider,
            variant.sourceDataset,
            variant.exclusiveArea,
            Math.max(0, variant.supplyArea - variant.exclusiveArea),
            variant.supplyArea,
            `${variant.sourceChecksum}:${exCents}:${variant.supplyCents}`,
            variant.sourceMonth,
            now,
            JSON.stringify({ acquisition_method: "BULK_EVIDENCE", bulk_checksum: variant.sourceChecksum }),
          ],
        });
        prev.add(variant.supplyCents);
        stats.newTypes += 1;
        stats.cacheRows += 1;
        stats.inserts += 2;
      }
      if (combined.size > 0) {
        statements.push({
          sql: `DELETE FROM apt_canonical_unit_types
                WHERE complex_id=? AND exclusive_cents=? AND supply_cents=? AND status='NO_SOURCE'`,
          args: [cid, exCents, NO_SUPPLY_CENTS],
        });
      }
      if (combined.size > 1) {
        statements.push({
          sql: `UPDATE apt_canonical_unit_types SET status='AMBIGUOUS_MULTI', updated_at=?
                WHERE complex_id=? AND exclusive_cents=? AND supply_cents >= 0`,
          args: [now, cid, exCents],
        });
      } else if (combined.size === 1) {
        statements.push({
          sql: `UPDATE apt_canonical_unit_types SET status='EXACT_SINGLE', updated_at=?
                WHERE complex_id=? AND exclusive_cents=? AND supply_cents >= 0 AND status!='EXACT_SINGLE'`,
          args: [now, cid, exCents],
        });
      }
    }

    let a = existing.get(cid);
    if (!a) { a = new Map(); existing.set(cid, a); }
    a.set(exCents, prev);

    statements.push({
      sql: `INSERT INTO apt_unit_exclusive_pairs (
              complex_id, exclusive_cents, exclusive_area, trade_count, trade_count_12m, trade_count_3y,
              latest_trade_date, resolution_status, supply_variant_count, observed_from
            ) VALUES (?, ?, ?, 0, 0, 0, '', ?, ?, 'bulk_evidence')
            ON CONFLICT(complex_id, exclusive_cents) DO UPDATE SET
              resolution_status=excluded.resolution_status,
              supply_variant_count=excluded.supply_variant_count,
              exclusive_area=excluded.exclusive_area,
              observed_from=CASE
                WHEN instr(apt_unit_exclusive_pairs.observed_from, 'bulk_evidence')>0 THEN apt_unit_exclusive_pairs.observed_from
                WHEN apt_unit_exclusive_pairs.observed_from='' THEN excluded.observed_from
                ELSE apt_unit_exclusive_pairs.observed_from || '+bulk_evidence'
              END`,
      args: [cid, exCents, first.exclusiveArea, hardConflict ? resolutionStatus(prev.size, false) : status, hardConflict ? prev.size : combined.size],
    });
    stats.pairUpserts += 1;

    if (statements.length >= 800) {
      await flush();
      if (processed % 5000 === 0) console.log(JSON.stringify({ processed, pairs: byPair.size, ...stats }));
    }
  }
  await flush();

  // checkpoints
  for (const cid of complexes) {
    statements.push({
      sql: `INSERT INTO official_unit_area_checkpoint
              (complex_id, status, page_cursor, total_count, detail, updated_at)
            VALUES (?, 'COMPLETE_DATA', 0, 0, 'BULK_EVIDENCE_MERGE', ?)
            ON CONFLICT(complex_id) DO UPDATE SET
              status='COMPLETE_DATA', detail=excluded.detail, updated_at=excluded.updated_at`,
      args: [cid, now],
    });
  }
  await flush();
  console.log(JSON.stringify({ phase: "merge_writes_done", ...stats }));

  const pilots: Record<string, unknown> = {};
  for (const [name, id] of Object.entries(PILOTS)) {
    const types = await db.execute({
      sql: `SELECT exclusive_area, supply_area, status FROM apt_canonical_unit_types
            WHERE complex_id=? AND supply_cents>=0 ORDER BY exclusive_area, supply_area`,
      args: [id],
    });
    const supplies = types.rows.map((r) => ({
      exclusive: num(r.exclusive_area),
      supply: num(r.supply_area),
      status: str(r.status),
    }));
    let jamsil: unknown;
    if (name === "잠실엘스") {
      const need = [[84.8, 111.52], [84.88, 109.29], [84.97, 109.47]] as const;
      const pass = need.every(([e, s]) =>
        supplies.some((row) => Math.abs(row.exclusive - e) < 1e-6 && Math.abs(row.supply - s) < 1e-6),
      );
      jamsil = {
        pass,
        multi5996: supplies.filter((s) => Math.abs(s.exclusive - 59.96) < 1e-6).length,
        multi11993: supplies.filter((s) => Math.abs(s.exclusive - 119.93) < 1e-6).length,
        required: need.map(([e, s]) => ({
          e, s,
          ok: supplies.some((row) => Math.abs(row.exclusive - e) < 1e-6 && Math.abs(row.supply - s) < 1e-6),
        })),
      };
      if (!pass) throw new Error(`jamsil FAIL ${JSON.stringify(jamsil)}`);
    }
    pilots[name] = {
      complexId: id,
      inManifest: !outsidePilots.some((x) => x.endsWith(id)),
      supplyCount: supplies.length,
      supplies: supplies.slice(0, 15),
      jamsil,
    };
  }

  const national = (await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM apt_canonical_unit_types) types,
      (SELECT COUNT(DISTINCT complex_id) FROM apt_canonical_unit_types WHERE supply_cents>=0) supply_complexes,
      (SELECT COUNT(*) FROM apt_canonical_unit_types WHERE status='EXACT_SINGLE' AND supply_cents>=0) exact_types,
      (SELECT COUNT(*) FROM apt_canonical_unit_types WHERE status='AMBIGUOUS_MULTI' AND supply_cents>=0) amb_types,
      (SELECT COUNT(*) FROM apt_canonical_unit_types WHERE status='NO_SOURCE') no_source_types,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs) pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status='EXACT_SINGLE') exact_pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status='AMBIGUOUS_MULTI') amb_pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status='NO_SOURCE') no_source_pairs,
      (SELECT COUNT(DISTINCT complex_id) FROM apt_unit_exclusive_pairs WHERE resolution_status='EXACT_SINGLE') exact_complexes,
      (SELECT COUNT(*) FROM apt_unit_supply_conflicts) conflicts
  `)).rows[0];

  const tradePairs = (await db.execute(`
    SELECT
      SUM(CASE WHEN resolution_status='EXACT_SINGLE' THEN trade_count_12m ELSE 0 END) exact12,
      SUM(trade_count_12m) att12,
      SUM(CASE WHEN resolution_status='EXACT_SINGLE' THEN trade_count_3y ELSE 0 END) exact3y,
      SUM(trade_count_3y) att3y
    FROM apt_unit_exclusive_pairs
  `)).rows[0];

  const regions = (await db.execute(`
    SELECT substr(m.lawd_cd,1,2) prefix,
           COUNT(DISTINCT m.complex_id) complexes,
           COUNT(DISTINCT CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.complex_id END) exact_complexes,
           COUNT(*) pairs,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN 1 ELSE 0 END) exact_pairs,
           SUM(CASE WHEN p.resolution_status='AMBIGUOUS_MULTI' THEN 1 ELSE 0 END) ambiguous,
           SUM(CASE WHEN p.resolution_status='NO_SOURCE' THEN 1 ELSE 0 END) no_source,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.trade_count_12m ELSE 0 END) exact12,
           SUM(p.trade_count_12m) att12,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.trade_count_3y ELSE 0 END) exact3y,
           SUM(p.trade_count_3y) att3y
    FROM apt_unit_exclusive_pairs p
    JOIN apt_complex_master m ON m.complex_id=p.complex_id
    GROUP BY 1
  `)).rows;

  // Seoul transaction-weighted exact coverage via live join (12M / 3Y)
  const seoulTx = (await db.execute(`
    WITH seoul_tx AS (
      SELECT t.lawd_cd, t.apt_name_norm, t.exclusive_area, t.deal_date, t.deal_amount,
             m.complex_id,
             CAST(ROUND(t.exclusive_area * 100) AS INTEGER) AS exclusive_cents
      FROM transactions t
      JOIN apt_complex_master m
        ON m.lawd_cd = t.lawd_cd AND m.apt_name_norm = t.apt_name_norm
      WHERE t.lawd_cd LIKE '11%'
        AND t.deal_type = 'trade'
        AND t.deal_amount > 0
        AND t.exclusive_area > 0
        AND t.deal_date <= '2026-09-17'
        AND t.deal_date >= '2023-09-17'
        AND m.complex_id IN (
          SELECT complex_id FROM apt_complex_master GROUP BY lawd_cd, apt_name_norm HAVING COUNT(*) = 1
        )
    )
    SELECT
      SUM(CASE WHEN deal_date >= '2025-09-17' THEN 1 ELSE 0 END) tx12,
      SUM(CASE WHEN deal_date >= '2025-09-17' AND EXISTS (
        SELECT 1 FROM apt_canonical_unit_types u
        WHERE u.complex_id = seoul_tx.complex_id AND u.exclusive_cents = seoul_tx.exclusive_cents
          AND u.supply_cents >= 0 AND u.status = 'EXACT_SINGLE'
      ) THEN 1 ELSE 0 END) exact12,
      SUM(CASE WHEN deal_date >= '2025-09-17' AND EXISTS (
        SELECT 1 FROM apt_canonical_unit_types u
        WHERE u.complex_id = seoul_tx.complex_id AND u.exclusive_cents = seoul_tx.exclusive_cents
          AND u.supply_cents >= 0 AND u.status = 'AMBIGUOUS_MULTI'
      ) THEN 1 ELSE 0 END) amb12,
      COUNT(*) tx3y,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM apt_canonical_unit_types u
        WHERE u.complex_id = seoul_tx.complex_id AND u.exclusive_cents = seoul_tx.exclusive_cents
          AND u.supply_cents >= 0 AND u.status = 'EXACT_SINGLE'
      ) THEN 1 ELSE 0 END) exact3y
    FROM seoul_tx
  `)).rows[0];

  const remainingRows = await db.execute(`
    SELECT m.complex_id, m.apt_name, m.lawd_cd, m.jibun, m.kapt_code,
           COALESCE(c.status,'') ck,
           CASE WHEN EXISTS(SELECT 1 FROM apt_canonical_unit_types u WHERE u.complex_id=m.complex_id AND u.supply_cents>=0) THEN 1 ELSE 0 END has_supply
    FROM apt_unit_acquisition_manifest m
    LEFT JOIN official_unit_area_checkpoint c ON c.complex_id=m.complex_id
  `);
  const remaining = {
    emptyJibun: 0,
    missingJibunButPnu: 0,
    missingIdentity: 0,
    bulkJoinMiss: 0,
    officialNoValidEvidence: 0,
    rows: [] as Array<Record<string, string>>,
  };
  for (const row of remainingRows.rows) {
    if (num(row.has_supply) === 1) continue;
    const jibun = str(row.jibun);
    const ck = str(row.ck);
    let cls = "BULK_JOIN_MISS";
    if (!jibun) {
      remaining.emptyJibun += 1;
      cls = str(row.kapt_code) ? "MISSING_JIBUN_BUT_PNU_AVAILABLE" : "MISSING_IDENTITY";
      if (cls === "MISSING_JIBUN_BUT_PNU_AVAILABLE") remaining.missingJibunButPnu += 1;
      else remaining.missingIdentity += 1;
    } else if (ck === "COMPLETE_NO_DATA") {
      cls = "OFFICIAL_NO_VALID_EVIDENCE";
      remaining.officialNoValidEvidence += 1;
    } else {
      remaining.bulkJoinMiss += 1;
    }
    remaining.rows.push({
      complex_id: str(row.complex_id),
      apt_name: str(row.apt_name),
      lawd_cd: str(row.lawd_cd),
      class: cls,
    });
  }
  writeFileSync(join(ROOT, "remaining-complexes-followup.jsonl"), remaining.rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const report = {
    artifact: {
      checksum: digest,
      rows: rows.length,
      valid: true,
      unreasonableHeld: unreasonableHeld,
      processUnreasonableAbsent: summary.process.invalid_supply_unreasonable,
      duplicate: duplicates,
      manifestDb: manifestCount,
      summaryManifestTargets: summary.coverage_preview.manifest_targets,
      outsidePilots,
      manifestExplanation:
        "Production apt_unit_acquisition_manifest=27517 is authoritative. Summary 27521 = 27517 + 4 Seoul pilot complexes outside the acquisition manifest (잠실엘스, 파크리오, 헬리오시티, 반포자이).",
    },
    previousUnitTypes: prevTypes,
    stats,
    national,
    tradePairs,
    seoulTx,
    regions,
    pilots,
    remaining: {
      emptyJibun: remaining.emptyJibun,
      missingJibunButPnu: remaining.missingJibunButPnu,
      missingIdentity: remaining.missingIdentity,
      bulkJoinMiss: remaining.bulkJoinMiss,
      officialNoValidEvidence: remaining.officialNoValidEvidence,
      followupPath: join(ROOT, "remaining-complexes-followup.jsonl"),
      followupRows: remaining.rows.length,
    },
    positiveOverwrites: 0,
  };
  writeFileSync(join(ROOT, "merge-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    previousUnitTypes: prevTypes,
    national,
    stats,
    seoulTx,
    outsidePilots,
    jamsil: (pilots["잠실엘스"] as { jamsil?: unknown }).jamsil,
    remaining: report.remaining,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
