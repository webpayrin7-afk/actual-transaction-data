/**
 * READ-ONLY export: canonical title-building dong keymap for local unit↔building join.
 * No Production writes. No API acquisition.
 */
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createClient, type Client } from "@libsql/client";

const OUT_DIR = join(process.cwd(), "data/poc/building-topology");
const OUT_CSV = join(OUT_DIR, "canonical_building_dong_keymap.csv.gz");
const OUT_SUMMARY = join(OUT_DIR, "canonical_building_dong_keymap_summary.json");

const COLUMNS = [
  "complex_id",
  "building_id",
  "official_building_key",
  "pnu",
  "official_dong_label",
  "official_dong_label_normalized",
  "dong_label_status",
  "dong_uniqueness",
  "residential_flag",
  "source",
  "source_version",
] as const;

function dbClient(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url) throw new Error("TURSO_DATABASE_URL missing");
  return createClient({ url, authToken });
}

/** Formatting-only: NFKC + trim. Never strip digits or invent aliases. */
function normalizeOfficialDong(raw: string | null): string {
  if (raw == null) return "";
  return raw.normalize("NFKC").trim();
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

type BuildingRow = {
  complex_id: string;
  building_id: string;
  official_building_key: string;
  pnu: string;
  official_dong_label: string;
  dong_label_status: string;
  residential_flag: number;
  source: string;
  source_version: string;
};

async function loadResidential(db: Client): Promise<BuildingRow[]> {
  const pageSize = 5000;
  const rows: BuildingRow[] = [];
  let offset = 0;
  for (;;) {
    const res = await db.execute({
      sql: `SELECT b.complex_id, b.building_id, b.official_building_key,
                   COALESCE(c.pnu, '') AS pnu,
                   COALESCE(b.dong_label, '') AS official_dong_label,
                   b.dong_label_status,
                   b.residential_flag,
                   b.source,
                   COALESCE(b.source_as_of, '') AS source_version
            FROM complex_buildings b
            LEFT JOIN complex_building_checkpoint c ON c.complex_id = b.complex_id
            WHERE b.residential_flag = 1 AND b.status = 'EXACT'
            ORDER BY b.complex_id, b.building_id
            LIMIT ? OFFSET ?`,
      args: [pageSize, offset],
    });
    if (res.rows.length === 0) break;
    for (const r of res.rows) {
      rows.push({
        complex_id: String(r.complex_id),
        building_id: String(r.building_id),
        official_building_key: String(r.official_building_key),
        pnu: String(r.pnu ?? ""),
        official_dong_label: String(r.official_dong_label ?? ""),
        dong_label_status: String(r.dong_label_status ?? ""),
        residential_flag: Number(r.residential_flag) === 1 ? 1 : 0,
        source: String(r.source ?? ""),
        source_version: String(r.source_version ?? ""),
      });
    }
    offset += res.rows.length;
    if (res.rows.length < pageSize) break;
    if (offset % 20000 === 0) console.error(`loaded ${offset}`);
  }
  return rows;
}

type Uniqueness = "UNIQUE_EXACT" | "DUPLICATE_LABEL" | "MISSING_LABEL";

function classify(rows: BuildingRow[]): Map<string, Uniqueness> {
  // key = complex_id \t normalized_label (empty => MISSING)
  const counts = new Map<string, number>();
  for (const row of rows) {
    const norm = normalizeOfficialDong(row.official_dong_label);
    if (!norm) continue;
    const key = `${row.complex_id}\t${norm}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = new Map<string, Uniqueness>();
  for (const row of rows) {
    const norm = normalizeOfficialDong(row.official_dong_label);
    if (!norm) {
      out.set(row.building_id, "MISSING_LABEL");
      continue;
    }
    const n = counts.get(`${row.complex_id}\t${norm}`) ?? 0;
    out.set(row.building_id, n === 1 ? "UNIQUE_EXACT" : "DUPLICATE_LABEL");
  }
  return out;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const db = dbClient();
  const rows = await loadResidential(db);
  const uniqueness = classify(rows);

  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(OUT_CSV);
  const done = pipeline(gzip, out);
  gzip.write(`${COLUMNS.join(",")}\n`);

  let unique = 0;
  let duplicate = 0;
  let missing = 0;
  let labeled = 0;
  const complexes = new Set<string>();
  const complexesWithUnique = new Set<string>();

  for (const row of rows) {
    const u = uniqueness.get(row.building_id) ?? "MISSING_LABEL";
    if (u === "UNIQUE_EXACT") {
      unique += 1;
      complexesWithUnique.add(row.complex_id);
    } else if (u === "DUPLICATE_LABEL") duplicate += 1;
    else missing += 1;
    if (normalizeOfficialDong(row.official_dong_label)) labeled += 1;
    complexes.add(row.complex_id);
    const norm = normalizeOfficialDong(row.official_dong_label);
    const line = [
      row.complex_id,
      row.building_id,
      row.official_building_key,
      row.pnu,
      row.official_dong_label,
      norm,
      row.dong_label_status,
      u,
      String(row.residential_flag),
      row.source,
      row.source_version,
    ]
      .map(csvEscape)
      .join(",");
    gzip.write(`${line}\n`);
  }
  gzip.end();
  await done;

  const checksum = sha256File(OUT_CSV);
  const gzipSize = existsSync(OUT_CSV) ? statSync(OUT_CSV).size : 0;
  const summary = {
    generatedAt: new Date().toISOString(),
    output: {
      path: OUT_CSV,
      rows: rows.length,
      gzipSize,
      checksum,
    },
    buildings: {
      residential: rows.length,
      labeled,
      UNIQUE_EXACT: unique,
      DUPLICATE_LABEL: duplicate,
      MISSING_LABEL: missing,
    },
    complexes: {
      represented: complexes.size,
      withUniqueExactDongMapping: complexesWithUnique.size,
    },
    joinContract: {
      exactComplexIdPlusDong: true,
      fuzzyMatchingUsed: false,
      productionWrites: 0,
      normalization: "NFKC + trim only; raw label preserved in official_dong_label",
    },
  };
  mkdirSync(dirname(OUT_SUMMARY), { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
