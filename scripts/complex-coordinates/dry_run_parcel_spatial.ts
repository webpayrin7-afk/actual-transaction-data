/**
 * REB full-PNU identity + official parcel spatial join DRY-RUN.
 *
 * Spatial SHP is optional. If PARCEL_SHP is absent, identity is still
 * aggregated and spatial join is recorded as BLOCKED_BY_ACCESS.
 * No Production writes. No geocoding. No school materialization.
 *
 *   npx tsx scripts/complex-coordinates/dry_run_parcel_spatial.ts [outDir]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { JAMSIL_ELS_CANONICAL_CENTER } from "../../src/lib/nearby-map/jamsil-els-canonical-center";
import {
  composeJibunAddress,
  normalizeJibunAddress,
  parseJibun,
  parsePnu,
  pnuLandAgnosticKey,
} from "../../src/lib/complex-coordinates/parcel-key";

const OUT = process.argv[2] || "data/poc/complex-coordinates";
const CACHE = process.env.COORD_SOURCE_CACHE || "/tmp/coord-source";
const PARCEL_SHP = process.env.PARCEL_SHP || "";

type RebHit = { pnu: string; pnuKey: string; jibun: string | null; name: string };

async function loadReb(): Promise<{ byKey: Map<string, RebHit[]>; byJibun: Map<string, RebHit[]> }> {
  const path = join(CACHE, "reb-seoul-basic.csv");
  if (!existsSync(path)) throw new Error(`REB cache missing: ${path}`);
  const byKey = new Map<string, RebHit[]>();
  const byJibun = new Map<string, RebHit[]>();
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }) });
  let headers: string[] | null = null;
  for await (const line of rl) {
    if (!headers) {
      headers = splitCsv(line).map((h) => h.trim());
      continue;
    }
    const cols = splitCsv(line);
    const get = (n: string) => {
      const i = headers!.indexOf(n);
      return i >= 0 ? (cols[i] ?? "").trim() : "";
    };
    const pnu = get("필지고유번호").replace(/\s+/g, "");
    const parsed = parsePnu(pnu);
    if (!parsed) continue;
    const hit: RebHit = {
      pnu: parsed.pnu,
      pnuKey: parsed.bjdong10 + parsed.bun + parsed.ji,
      jibun: normalizeJibunAddress(get("주소")),
      name: get("단지명_공시가격"),
    };
    push(byKey, hit.pnuKey, hit);
    if (hit.jibun) push(byJibun, hit.jibun, hit);
  }
  return { byKey, byJibun };
}

function push(map: Map<string, RebHit[]>, key: string, hit: RebHit) {
  const arr = map.get(key) || [];
  arr.push(hit);
  map.set(key, arr);
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

type IdentityStatus =
  | "SINGLE_PARCEL"
  | "MULTI_PARCEL"
  | "MULTI_RECORD_SAME_PARCEL"
  | "AMBIGUOUS_IDENTITY"
  | "NO_PNU"
  | "INVALID_PNU";

async function main() {
  if (process.argv.includes("--write")) {
    console.error("WRITE GUARD: parcel spatial dry-run refuses --write");
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const spatialReady = Boolean(PARCEL_SHP) && existsSync(PARCEL_SHP);
  const { byKey, byJibun } = await loadReb();

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
  const master = await db.execute({
    sql: `SELECT complex_id, apt_name, sigungu, lawd_cd, legal_dong_name, bjdong_cd, jibun
          FROM apt_complex_master WHERE sido LIKE ? ORDER BY complex_id`,
    args: ["%서울%"],
  });

  const counts: Record<string, number> = {};
  const rows: Array<Record<string, unknown>> = [];
  const allPnus = new Set<string>();
  let invalidStored = 0;

  for (const r of master.rows) {
    const jibun = r.jibun == null ? null : String(r.jibun);
    const parts = parseJibun(jibun);
    const jibunAddr = composeJibunAddress({
      sido: "서울특별시",
      sigungu: r.sigungu == null ? null : String(r.sigungu),
      dong: r.legal_dong_name == null ? null : String(r.legal_dong_name),
      jibun,
    });
    let key: string | null = null;
    if (parts && r.lawd_cd && r.bjdong_cd) {
      const composed = `${r.lawd_cd}${r.bjdong_cd}0${parts.bun}${parts.ji}`;
      key = pnuLandAgnosticKey(composed);
    }
    const hits =
      (key && byKey.get(key)) ||
      (jibunAddr && byJibun.get(jibunAddr)) ||
      [];
    const full = [...new Set(hits.map((h) => h.pnu))];
    const keys = [...new Set(hits.map((h) => h.pnuKey))];
    let status: IdentityStatus;
    if (hits.length === 0) status = parts ? "NO_PNU" : "INVALID_PNU";
    else if (!parts && hits.length === 0) status = "INVALID_PNU";
    else if (keys.length > 1) status = "AMBIGUOUS_IDENTITY";
    else if (full.length > 1) status = "MULTI_PARCEL";
    else if (hits.length > 1) status = "MULTI_RECORD_SAME_PARCEL";
    else status = "SINGLE_PARCEL";
    if (!parts) invalidStored += 1;
    counts[status] = (counts[status] || 0) + 1;
    for (const p of full) allPnus.add(p);
    rows.push({
      complex_id: String(r.complex_id),
      apt_name: String(r.apt_name ?? ""),
      sigungu: r.sigungu == null ? null : String(r.sigungu),
      jibun_addr: jibunAddr,
      identity_status: status,
      full_pnus: full,
      spatial_status: spatialReady ? "PENDING_JOIN" : "BLOCKED_BY_ACCESS",
    });
  }

  const jam = rows.find((x) => x.complex_id === JAMSIL_ELS_CANONICAL_CENTER.complexId);
  const sampleGus = ["강남구", "송파구", "종로구", "마포구", "강서구", "노원구"];
  const samples = [];
  for (const gu of sampleGus) {
    const hit =
      rows.find((x) => x.sigungu === gu && x.identity_status === "SINGLE_PARCEL") ||
      rows.find((x) => x.sigungu === gu);
    if (hit) samples.push(hit);
  }
  for (const st of ["MULTI_PARCEL", "MULTI_RECORD_SAME_PARCEL", "NO_PNU"] as const) {
    const hit = rows.find((x) => x.identity_status === st);
    if (hit && !samples.some((s) => s.complex_id === hit.complex_id)) samples.push(hit);
  }

  const summary = {
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    production_coordinate_rows_written: 0,
    school_rerun: false,
    spatial_join: spatialReady ? "READY" : "BLOCKED_BY_ACCESS",
    reb_identity: {
      total: rows.length,
      SINGLE_PARCEL: counts.SINGLE_PARCEL || 0,
      MULTI_RECORD_SAME_PARCEL: counts.MULTI_RECORD_SAME_PARCEL || 0,
      MULTI_PARCEL: counts.MULTI_PARCEL || 0,
      AMBIGUOUS_IDENTITY: counts.AMBIGUOUS_IDENTITY || 0,
      NO_PNU: counts.NO_PNU || 0,
      INVALID_PNU: counts.INVALID_PNU || 0,
      unique_full_pnu: allPnus.size,
      jibun_unparseable: invalidStored,
      high_confidence_identity:
        (counts.SINGLE_PARCEL || 0) +
        (counts.MULTI_RECORD_SAME_PARCEL || 0) +
        (counts.MULTI_PARCEL || 0),
    },
    spatial_source: {
      provider: "국토교통부 / VWorld",
      dataset: "일별연속지적도형정보 (dsId=23) 서울특별시 SHP",
      official: true,
      format: "SHP",
      bulk: true,
      access: "VWorld downloadResourceFile",
      credential: "none stated; host unreachable (HTTP 502 / connection reset)",
      version: "dataset page 수정일 2025-09-08; file date not retrieved",
      crs: "EPSG:5186 (official page: GRS80)",
      pnu_field: "PNU (confirm on file open; not guessed into a join)",
      coordinate_meaning: "parcel polygon; representative point not computed",
      license: "이용허락범위 제한 없음 (data.go.kr 15045882). Nationwide 20231113 file is 제4유형 and is rejected.",
      attribution: "UNKNOWN",
      alternative_checked: "geomarket LX 필지점 requires login; provincial cadastral fileData pages also redirect to VWorld",
    },
    high_confidence_coordinates: 0,
    jamsil_els: {
      complex_id: JAMSIL_ELS_CANONICAL_CENTER.complexId,
      identity_status: jam?.identity_status ?? null,
      full_pnus: jam?.full_pnus ?? [],
      known_anchor: {
        lat: JAMSIL_ELS_CANONICAL_CENTER.lat,
        lng: JAMSIL_ELS_CANONICAL_CENTER.lng,
      },
      representative_point: null,
      distance_meters: null,
      spatial_status: "BLOCKED_BY_ACCESS",
    },
    required_user_action: spatialReady
      ? null
      : "Place Seoul continuous-cadastral SHP (EPSG:5186, dsId=23) at PARCEL_SHP and re-run. Do not use the commercial-prohibited nationwide 제4유형 file.",
  };

  writeFileSync(join(OUT, "parcel-coordinate-summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(
    join(OUT, "parcel-coordinate-sample.json"),
    JSON.stringify({ samples: samples.slice(0, 40), jamsil_els: summary.jamsil_els }, null, 2),
  );
  const unresolved = rows.filter((x) =>
    ["NO_PNU", "INVALID_PNU", "AMBIGUOUS_IDENTITY", "MULTI_PARCEL"].includes(
      String(x.identity_status),
    ),
  );
  const csv = [
    "complex_id,apt_name,sigungu,identity_status,full_pnus",
    ...unresolved.map((x) =>
      [
        x.complex_id,
        JSON.stringify(x.apt_name),
        x.sigungu ?? "",
        x.identity_status,
        JSON.stringify(x.full_pnus),
      ].join(","),
    ),
  ].join("\n");
  writeFileSync(join(OUT, "parcel-coordinate-unresolved.csv"), csv);
  console.log(
    JSON.stringify(
      {
        total: rows.length,
        ...summary.reb_identity,
        spatial: summary.spatial_join,
        jamsil: summary.jamsil_els.full_pnus,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
