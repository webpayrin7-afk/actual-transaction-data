/**
 * Local-file repair only (no Production access, no API calls).
 * Removes op-checkpoint records that failed with an OpenAPI gateway envelope (result_class openapi_*,
 * e.g. openapi_04 "HTTP_ERROR") so run-province-final refetches them instead of treating them as terminal.
 * A dry-run report computed from such records is moved aside (suffix .superseded-<ts>.json) because its
 * NO_PUBLISHED_MONTH / PARTIAL counts are not trustworthy. Refuses if the province is already applied.
 *
 *   npx tsx scripts/mgmt-fee-canonical/purge-transient-failures.mts --province=daegu [--commit]
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { provinceArtifactPrefix, provinceFromArgv } from "./provinces";
import type { OpCheckpointFile } from "./op-checkpoint";

const PROVINCE = provinceFromArgv(process.argv);
const PREFIX = provinceArtifactPrefix(PROVINCE);
const DIR = resolve(import.meta.dirname, "../../data/poc/mgmt-fee-canonical");
const CHECKPOINT_PATH = resolve(DIR, `${PREFIX}-op-checkpoint.json`);
const REPORT_PATH = resolve(DIR, `${PREFIX}-dryrun.json`);
const APPLY_PATH = resolve(DIR, `${PREFIX}-apply-result.json`);
const COMMIT = process.argv.includes("--commit");

if (existsSync(APPLY_PATH)) throw new Error(`${PROVINCE.slug} already has an apply result; refusing`);
const file = JSON.parse(readFileSync(CHECKPOINT_PATH, "utf8")) as OpCheckpointFile;
if (file.version !== 1 || !Array.isArray(file.records)) throw new Error("invalid op checkpoint");
const isTransient = (r: OpCheckpointFile["records"][number]) => r.status === "failed" && /^openapi_/.test(r.result_class);
const purged = file.records.filter(isTransient);
const kept = file.records.filter((r) => !isTransient(r));
const summary = {
  province: PROVINCE.slug,
  records_before: file.records.length,
  purged: purged.length,
  records_after: kept.length,
  complexes_touched: new Set(purged.map((r) => r.complex_id)).size,
  first_failure_at: purged.map((r) => r.completed_at).sort()[0] ?? null,
  last_failure_at: purged.map((r) => r.completed_at).sort().at(-1) ?? null,
  dryrun_report_present: existsSync(REPORT_PATH),
  commit: COMMIT,
};
if (COMMIT && purged.length > 0) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(resolve(DIR, `purge-backup-${PREFIX}-op-checkpoint-${ts}.json`), readFileSync(CHECKPOINT_PATH));
  writeFileSync(CHECKPOINT_PATH, JSON.stringify({ ...file, records: kept }));
  if (existsSync(REPORT_PATH)) renameSync(REPORT_PATH, resolve(DIR, `${PREFIX}-dryrun.superseded-${ts}.json`));
}
console.log(JSON.stringify(summary));
