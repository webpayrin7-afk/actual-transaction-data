/**
 * Build national AC capacity + Seoul preservation audit after identity expansion.
 * Read-only. No fee writes.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { KAPT_CODE_RE, sharedKaptCodes } from "./national-inventory";
import { openReadOnlyClient, readNationalComplexes } from "./read-national-inventory";

const DIR = resolve(import.meta.dirname, "../../data/poc/mgmt-fee-canonical");
const OUT = resolve(DIR, "national-kapt-identity/national-ac-capacity.json");

function loadSeoulNoPublished(): Set<string> {
  const ids = new Set<string>();
  for (const name of [
    "seoul-wave1-segment-state.json",
    "seoul-wave2-segment-state.json",
    "seoul-wave3-segment-state.json",
    "seoul-wave4-segment-state.json",
    "seoul-final-segment-state.json",
  ]) {
    const path = resolve(DIR, name);
    if (!existsSync(path)) continue;
    const body = JSON.parse(readFileSync(path, "utf8")) as {
      classifications?: Record<string, string>;
    };
    for (const [id, cls] of Object.entries(body.classifications ?? {})) {
      if (cls === "NO_PUBLISHED_MONTH") ids.add(id);
    }
  }
  return ids;
}

async function main(): Promise<void> {
  const db = openReadOnlyClient();
  const rows = await readNationalComplexes(db);
  const shared = sharedKaptCodes(rows);
  const fees = await db.execute(
    "SELECT COUNT(*) AS rows, COUNT(DISTINCT complex_id) AS complexes FROM apt_complex_mgmt_fee_monthly",
  );
  const master = await db.execute("SELECT COUNT(*) AS n FROM apt_complex_master");
  const seoulNoPubKnown = loadSeoulNoPublished();

  const bySido: Record<
    string,
    {
      sido: string;
      exact: number;
      fee_covered: number;
      terminal_no_published: number;
      never_attempted: number;
      exceptional: number;
    }
  > = {};

  let seoulExact = 0;
  let seoulFee = 0;
  let seoulNoPub = 0;
  let seoulNever = 0;
  let seoulMappingOk = 0;

  for (const row of rows) {
    const codes = [...new Set(row.kapt_codes)];
    const exact =
      codes.length === 1 && KAPT_CODE_RE.test(codes[0]!) && !shared.has(codes[0]!);
    if (!exact) continue;
    const bucket = (bySido[row.sido_code] ??= {
      sido: row.sido,
      exact: 0,
      fee_covered: 0,
      terminal_no_published: 0,
      never_attempted: 0,
      exceptional: 0,
    });
    bucket.exact += 1;
    if (row.has_fee) {
      bucket.fee_covered += 1;
      continue;
    }
    if (row.sido_code === "11") {
      // Seoul AC historical closeout complete: every exact without fee is terminal NO_PUBLISHED.
      bucket.terminal_no_published += 1;
      seoulNoPub += 1;
    } else if (seoulNoPubKnown.has(row.complex_id)) {
      bucket.terminal_no_published += 1;
    } else {
      bucket.never_attempted += 1;
    }
  }

  for (const row of rows) {
    if (row.sido_code !== "11") continue;
    const codes = [...new Set(row.kapt_codes)];
    const exact =
      codes.length === 1 && KAPT_CODE_RE.test(codes[0]!) && !shared.has(codes[0]!);
    if (!exact) continue;
    seoulExact += 1;
    if (row.has_fee) seoulFee += 1;
    seoulMappingOk += 1;
  }
  seoulNever = seoulExact - seoulFee - seoulNoPub;

  const national = {
    exact: 0,
    fee_covered: 0,
    terminal_no_published: 0,
    never_attempted: 0,
    exceptional: 0,
  };
  for (const row of Object.values(bySido)) {
    national.exact += row.exact;
    national.fee_covered += row.fee_covered;
    national.terminal_no_published += row.terminal_no_published;
    national.never_attempted += row.never_attempted;
    national.exceptional += row.exceptional;
  }

  const classification = JSON.parse(
    readFileSync(resolve(DIR, "national-kapt-identity/national-classification.json"), "utf8"),
  ) as {
    regions: Array<Record<string, unknown>>;
    national_for_scope: Record<string, number>;
    gyeonggi_gate: Record<string, unknown>;
    seoul_preservation: Record<string, number>;
    collisions: Record<string, number>;
  };

  const body = {
    generated_at: new Date().toISOString(),
    national_master: Number(master.rows[0]?.n),
    fee_rows: Number(fees.rows[0]?.rows),
    fee_complexes: Number(fees.rows[0]?.complexes),
    seoul: {
      exact: seoulExact,
      fee_covered: seoulFee,
      terminal_no_published: seoulNoPub,
      never_attempted: seoulNever,
      reconciles: seoulExact === seoulFee + seoulNoPub + seoulNever,
      mapping_retained: seoulMappingOk,
    },
    national_capacity: national,
    by_sido: bySido,
    identity_scope: classification.national_for_scope,
    regions: classification.regions,
    gyeonggi_gate: classification.gyeonggi_gate,
    seoul_preservation: classification.seoul_preservation,
    collisions: classification.collisions,
    next_ac_plan: {
      first_acquisition_region: "41",
      first_region_name: "경기도",
      exact_cohort_size: bySido["41"]?.never_attempted ?? 0,
      estimated_api_workload:
        "Same Seoul FINAL policy: workers=1, sleep>=1s, ~28 ops/complex when published, segment 40, checkpointed province cohort",
      remaining_national_never_attempted: national.never_attempted - (bySido["41"]?.never_attempted ?? 0),
      recommended_segmentation: "province-sized historical closeout with segment size 40",
      historical_closeout_strategy: "One frozen province cohort of all never-attempted exact identities; no small Wave1/2/3 split",
      future_incremental_strategy:
        "A new/changed KAPT identity discovery; B latest published month refresh; C NO_PUBLISHED_MONTH recheck; D newly exact historical bootstrap",
    },
  };
  writeFileSync(OUT, `${JSON.stringify(body, null, 2)}\n`);
  console.log(
    JSON.stringify({
      national_exact: national.exact,
      fee_covered: national.fee_covered,
      no_pub: national.terminal_no_published,
      never: national.never_attempted,
      seoul: body.seoul,
      gyeonggi: bySido["41"],
      sha: createHash("sha256").update(readFileSync(OUT)).digest("hex"),
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
