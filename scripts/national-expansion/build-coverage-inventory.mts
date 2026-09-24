/**
 * Read-only national coverage inventory.
 * Does not scan transactions and does not write Production.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import lawdRows from "../../src/lib/constants/nationwide-lawd.json";
import {
  NATIONAL_SIDO_CODES,
  SIDO_LABEL,
  evaluateMasterGate,
  productionApplyAllowed,
  selectFirstWave,
  type SidoWaveInput,
} from "../../src/lib/national-expansion/wave-gate";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(ROOT, "data/poc/national-expansion");
const SEOUL_ZIP = path.join(ROOT, "seoul_parcel_coordinates_cursor_input_20260908.zip");
const REB_CACHE = "/tmp/coord-source/reb-seoul-basic.csv";

type LawdRow = { code: string; fullName: string };

function sigunguLabel(fullName: string): string {
  const parts = fullName.split(" ").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : fullName;
}

async function sha256(file: string): Promise<{ bytes: number; sha256: string } | null> {
  if (!existsSync(file)) return null;
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(file);
    s.on("data", (buf) => {
      bytes += buf.length;
      hash.update(buf);
    });
    s.on("end", () => resolve());
    s.on("error", reject);
  });
  return { bytes, sha256: hash.digest("hex") };
}

async function main() {
  const applyFlag = process.argv.includes("--apply") || process.argv.includes("--write");
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO credentials missing");
  const db = createClient({ url, authToken });

  const master = await db.execute(
    `SELECT sido_code, COUNT(*) n,
            SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) coords
     FROM apt_complex_master GROUP BY sido_code`,
  );
  const links = await db.execute(
    `SELECT l.source source, m.sido_code sido_code, COUNT(*) n
     FROM apt_complex_source_links l
     JOIN apt_complex_master m ON m.complex_id = l.complex_id
     GROUP BY l.source, m.sido_code`,
  );
  const enrich = await db.execute(
    `SELECT domain, status, COUNT(*) n FROM apt_complex_enrichment_state GROUP BY domain, status`,
  );
  const sync = await db.execute(
    `SELECT substr(lawd_cd,1,2) sido, COUNT(DISTINCT lawd_cd) lawds, COUNT(*) cells, SUM(row_count) rows
     FROM sync_months GROUP BY 1`,
  );
  const syncExtra = await db.execute(
    `SELECT lawd_cd, year_month, deal_kind, row_count
     FROM sync_months
     WHERE lawd_cd NOT LIKE '11%' AND lawd_cd NOT LIKE '41%'
     ORDER BY lawd_cd, year_month`,
  );
  const catalogN = await db.execute(`SELECT COUNT(*) n FROM apt_catalog`);
  const catalogGu = await db.execute(`SELECT gu, COUNT(*) n FROM apt_catalog GROUP BY gu`);

  const masterBy = new Map<string, { n: number; coords: number }>();
  for (const r of master.rows) {
    masterBy.set(String(r.sido_code), { n: Number(r.n), coords: Number(r.coords) });
  }
  const linkBy = new Map<string, Record<string, number>>();
  for (const r of links.rows) {
    const sido = String(r.sido_code);
    const cur = linkBy.get(sido) ?? {};
    cur[String(r.source)] = Number(r.n);
    linkBy.set(sido, cur);
  }
  const syncBy = new Map<string, { lawds: number; cells: number; rows: number }>();
  for (const r of sync.rows) {
    syncBy.set(String(r.sido), {
      lawds: Number(r.lawds),
      cells: Number(r.cells),
      rows: Number(r.rows),
    });
  }

  const lawd = lawdRows as LawdRow[];
  const lawdCount = new Map<string, number>();
  const labelSido = new Map<string, Set<string>>();
  for (const row of lawd) {
    const sido = row.code.slice(0, 2);
    lawdCount.set(sido, (lawdCount.get(sido) ?? 0) + 1);
    const label = sigunguLabel(row.fullName);
    const set = labelSido.get(label) ?? new Set<string>();
    set.add(sido);
    labelSido.set(label, set);
  }

  const catalogSignal = new Map<string, number>();
  let catalogAmbiguous = 0;
  let catalogUnmapped = 0;
  for (const r of catalogGu.rows) {
    const gu = String(r.gu);
    const n = Number(r.n);
    const sidos = labelSido.get(gu);
    if (!sidos || sidos.size === 0) catalogUnmapped += n;
    else if (sidos.size > 1) catalogAmbiguous += n;
    else {
      const sido = [...sidos][0];
      catalogSignal.set(sido, (catalogSignal.get(sido) ?? 0) + n);
    }
  }

  const zip = await sha256(SEOUL_ZIP);
  let zipMeta: Record<string, unknown> | null = null;
  if (existsSync(SEOUL_ZIP)) {
    const { execFileSync } = await import("node:child_process");
    const raw = execFileSync(
      "python3",
      [
        "-c",
        "import zipfile; z=zipfile.ZipFile('seoul_parcel_coordinates_cursor_input_20260908.zip'); print(z.read('seoul_parcel_representative_points_20260908.metadata.json').decode())",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    zipMeta = JSON.parse(raw);
  }

  const legalDongOnBranch = existsSync(path.join(ROOT, "data/static/legal_dong_seoul_gyeonggi.json"));
  const generatedAt = new Date().toISOString();

  const sido = NATIONAL_SIDO_CODES.map((code) => {
    const current = masterBy.get(code)?.n ?? 0;
    const coords = masterBy.get(code)?.coords ?? 0;
    const syncRow = syncBy.get(code) ?? { lawds: 0, cells: 0, rows: 0 };
    const cadastral = code === "11" && zip != null;
    const blockers: string[] = [];
    if (code !== "11" && code !== "41") {
      blockers.push("NO_DETERMINISTIC_COMPLEX_UNIVERSE");
      blockers.push("LEGAL_DONG_RESOLVER_ABSENT");
      if (syncRow.lawds === 0) blockers.push("NO_SYNC_UNIVERSE");
      else blockers.push("SYNC_IS_NOT_COMPLEX_IDENTITY");
      blockers.push("NO_CADASTRAL_SOURCE");
      blockers.push("NO_SCHOOL_SOURCE");
    } else {
      blockers.push("EXISTING_MASTER_PROTECTED");
      if (coords === 0) blockers.push("COORDINATES_NOT_WRITTEN");
      if (code === "11") blockers.push("BLOCKED_SOURCE_CACHE_LOST");
    }
    return {
      sido_code: code,
      sido: SIDO_LABEL[code],
      current_master: current,
      coordinates_written: coords,
      candidate_complexes: {
        safe: 0,
        ambiguous: 0,
        unresolved: 0,
        catalog_name_signal_not_identity: catalogSignal.get(code) ?? 0,
      },
      source_coverage: {
        lawd_catalog: lawdCount.get(code) ?? 0,
        molit_links: linkBy.get(code)?.MOLIT ?? 0,
        kapt_links: linkBy.get(code)?.KAPT ?? 0,
        building_hub_parcel_links: linkBy.get(code)?.BUILDING_HUB_PARCEL ?? 0,
        sync_lawds: syncRow.lawds,
        sync_month_cells: syncRow.cells,
        sync_row_count_sum: syncRow.rows,
      },
      coordinate_source_availability: cadastral
        ? "SEOUL_PARCEL_ZIP_ONLY_REB_CACHE_MISSING"
        : "NO_SOURCE",
      school_source_availability: "NO_NATIONAL_SOURCE_IN_REPO",
      blockers,
    };
  });

  const waveInput: SidoWaveInput[] = sido.map((row) => ({
    sido_code: row.sido_code,
    candidate_safe: row.candidate_complexes.safe,
    legal_dong_resolver: legalDongOnBranch && (row.sido_code === "11" || row.sido_code === "41"),
    sync_lawds: row.source_coverage.sync_lawds,
    cadastral_source: row.coordinate_source_availability !== "NO_SOURCE",
    pnu_source: false,
  }));
  const selected = selectFirstWave(waveInput);
  const gate = evaluateMasterGate({
    selected_sido: selected,
    safe: 0,
    ambiguous_in_payload: 0,
    unresolved_in_payload: 0,
    duplicate_complex_id: 0,
    duplicate_external_identity: 0,
    invalid_sido_lawd: 0,
    existing_row_overwrite: 0,
    provenance_missing: 0,
    expected_candidate_count: 0,
  });
  const applyAllowed = productionApplyAllowed(gate.pass);
  if (applyFlag) {
    console.error(JSON.stringify({ apply: "REFUSED", gate, applyAllowed }));
    process.exit(2);
  }

  const inventory = {
    generated_at: generatedAt,
    transaction_scan: false,
    seoul_safe_7963_recomputed: false,
    identity_contract: {
      complex_id: "cx_ + sha1(utf8 molit:{lawd}:{apt_name_norm})[:16]",
      source: "MOLIT",
      source_key: "{lawd_cd}|{apt_name_norm}",
      safe_class: "IDENTITY-READY only",
      legal_dong_table_on_this_branch: legalDongOnBranch,
      note: "catalog apt name / gu is not an identity. Existing complex_id values are not reissued.",
    },
    totals: {
      current_master: [...masterBy.values()].reduce((a, b) => a + b.n, 0),
      sido_with_master: [...masterBy.keys()],
      coordinates_written: [...masterBy.values()].reduce((a, b) => a + b.coords, 0),
      apt_catalog_rows: Number(catalogN.rows[0]?.n ?? 0),
      apt_catalog_sido: "NOT_KEYED",
      catalog_rows_unique_sigungu_name: [...catalogSignal.entries()],
      catalog_rows_ambiguous_sigungu_name: catalogAmbiguous,
      catalog_rows_unmapped_gu: catalogUnmapped,
    },
    enrichment_state_existing_domains_only: enrich.rows,
    transaction_region_universe: {
      source: "sync_months aggregate, not transactions",
      by_sido: sync.rows,
      outside_11_41: syncExtra.rows,
    },
    candidate_source: {
      confirmed: "MOLIT",
      writable_safe_outside_capital: 0,
      expected_nationwide_coverage: "not_estimable_without_ingested_lawd_universe_and_legal_dong_table",
    },
    sido,
    global_blockers: [
      "LEGAL_DONG_RESOLVER_NOT_ON_BRANCH",
      "NO_NON_CAPITAL_COMPLEX_IDENTITY_UNIVERSE",
      "CATALOG_HAS_NO_LAWD",
      "NO_NON_SEOUL_CADASTRAL_SOURCE",
      "SEOUL_REB_CACHE_MISSING",
    ],
  };

  const dryRun = {
    generated_at: generatedAt,
    wave: 1,
    selected_sido: selected,
    candidates: 0,
    safe: 0,
    ambiguous: 0,
    unresolved: 0,
    sample: [],
    collision: {
      duplicate_complex_id: 0,
      duplicate_external_identity: 0,
      existing_row_overwrite: 0,
    },
    gate,
    apply: "REFUSED",
    production_rows_written: 0,
    post_write_validation: "NOT_RUN",
    reason:
      "No sido outside Seoul/Gyeonggi has a deterministic MOLIT identity universe. Partial Busan lawd 26350 in sync_months is not a complex candidate set.",
  };

  const checkpoints = NATIONAL_SIDO_CODES.filter((c) => c !== "11" && c !== "41").map((code) => ({
    sido: code,
    domain: "MASTER",
    status: "BLOCKED",
    source_version: "molit-identity-v1",
    candidate_count: 0,
    applied_count: 0,
    unresolved_count: 0,
    last_cursor: null,
    updated_at: generatedAt,
    artifact_path: "data/poc/national-expansion/wave1-master-dryrun.json",
  }));

  const manifest = {
    generated_at: generatedAt,
    semantics: "PARCEL_REPRESENTATIVE_POINT",
    cache_policy: {
      tracked: ["data/poc/national-expansion/coordinates/source-manifest.json"],
      gitignored_cache: "data/poc/national-expansion/coordinates/cache/",
      do_not_depend_on: ["/tmp/coord-source/reb-seoul-basic.csv"],
      raw_commit_policy: "Do not commit additional large raw cadastral or REB extracts. Record hash, CRS, row count, and retrieval name here.",
    },
    inputs: [
      zip
        ? {
            source_name: "국토교통부 일별연속지적도형정보 서울특별시",
            source_version: String(zipMeta?.source_file ?? "AL_D002_11_20260908.zip"),
            original_crs: String(zipMeta?.source_crs ?? "EPSG:5186"),
            output_crs: String(zipMeta?.target_crs ?? "EPSG:4326"),
            sido: "11",
            file: "seoul_parcel_coordinates_cursor_input_20260908.zip",
            file_hash: zip.sha256,
            file_bytes: zip.bytes,
            row_count: Number(zipMeta?.output_rows ?? 0),
            reb_basic_cache_present: existsSync(REB_CACHE),
            status: "PARCEL_ZIP_PRESENT_REB_CACHE_ABSENT",
          }
        : {
            source_name: "서울 연속지적도",
            sido: "11",
            status: "MISSING",
          },
    ],
    other_sido: "NO_SOURCE",
  };

  mkdirSync(path.join(OUT_DIR, "coordinates"), { recursive: true });
  writeFileSync(path.join(OUT_DIR, "national-coverage-inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
  writeFileSync(path.join(OUT_DIR, "wave1-master-dryrun.json"), JSON.stringify(dryRun, null, 2) + "\n");
  writeFileSync(
    path.join(OUT_DIR, "master-checkpoints.json"),
    JSON.stringify({ generated_at: generatedAt, checkpoints }, null, 2) + "\n",
  );
  writeFileSync(
    path.join(OUT_DIR, "coordinates/source-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      ok: true,
      master: inventory.totals.current_master,
      selected,
      gate_pass: gate.pass,
      apply: dryRun.apply,
    }),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "inventory failed");
  process.exit(1);
});
