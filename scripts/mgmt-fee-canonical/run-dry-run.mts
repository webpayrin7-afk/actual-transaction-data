/**
 * Offline canonical fee dry-run.
 *
 *   npx tsx scripts/mgmt-fee-canonical/run-dry-run.mts \
 *     --fixture data/poc/mgmt-fee-canonical/fixture.sample.json \
 *     --periods 202507,202508
 *
 * Refuses --apply. Does not call a fee API or Production.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CheckpointStore } from "./checkpoint";
import { parsePeriodList } from "./cohort";
import { runCanonicalDryRun } from "./dry-run";
import type {
  DryRunInput,
  ExistingFeeKey,
  OpObservation,
  SampleMember,
} from "./types";

type FixtureFile = {
  cohort: SampleMember[];
  periods?: string[];
  expected_ops?: string[];
  existing_fee_keys?: ExistingFeeKey[];
  targets?: Array<{
    complex_id: string;
    period_yyyymm: string;
    observations?: OpObservation[];
  }>;
};

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function main(): void {
  if (process.argv.includes("--apply")) {
    console.error("refusing --apply: this entrypoint is dry-run only");
    process.exit(2);
  }

  const fixturePath = argValue("--fixture");
  if (!fixturePath) {
    console.error("missing --fixture");
    process.exit(2);
  }

  const fixture = JSON.parse(readFileSync(resolve(fixturePath), "utf8")) as FixtureFile;
  const periodArg = argValue("--periods");
  const periods = parsePeriodList(
    periodArg ?? (fixture.periods ?? []).join(","),
  );

  let checkpoint = CheckpointStore.empty();
  const checkpointPath = argValue("--checkpoint");
  if (checkpointPath && existsSync(resolve(checkpointPath))) {
    checkpoint = CheckpointStore.parse(readFileSync(resolve(checkpointPath), "utf8"));
  }

  const input: DryRunInput = {
    cohort: fixture.cohort,
    periods,
    targets: fixture.targets ?? [],
    existingFeeKeys: fixture.existing_fee_keys ?? [],
    checkpoint,
    expectedOps: fixture.expected_ops,
    now: argValue("--now"),
  };

  const output = runCanonicalDryRun(input);
  if (checkpointPath) {
    writeFileSync(resolve(checkpointPath), output.checkpoint.serialize(), "utf8");
  }

  const body = JSON.stringify(
    { report: output.report, plans: output.plans, results: output.results },
    null,
    2,
  );
  const outPath = argValue("--out");
  if (outPath) writeFileSync(resolve(outPath), body, "utf8");
  console.log(body);
}

main();
