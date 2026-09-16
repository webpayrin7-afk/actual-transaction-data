/**
 * Explicit Preview SINGOGA_V2 rebuild entry script (Stage20+).
 *
 *   PREVIEW_V2_REBUILD=1 npx tsx scripts/rebuild-preview-singoga-v2.mts [--stub]
 *
 * Writes ONLY *_preview_v2 tables. Aborts if Production tables would be targeted.
 * Stage20 default: --stub (no full classifier). Stage21: real classify.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

process.env.PREVIEW_V2_REBUILD = "1";

import {
  clearPreviewV2StubRows,
  rebuildPreviewSingogaV2Stub,
  runMinimalClassifierReachabilityCheck,
  verifyPreviewV2RebuildTargetsOrAbort,
} from "../src/lib/market/rebuild-preview-singoga-v2";

async function main() {
  const stub = process.argv.includes("--stub") || !process.argv.includes("--classify");
  const targets = verifyPreviewV2RebuildTargetsOrAbort();
  const reach = runMinimalClassifierReachabilityCheck();

  if (!stub) {
    throw new Error(
      "Stage20: full classify rebuild not enabled yet. Use --stub. Stage21 will activate classify.",
    );
  }

  const written = await rebuildPreviewSingogaV2Stub();
  // Stage20 probe cleanup when --clean
  let cleaned = null;
  if (process.argv.includes("--clean")) {
    cleaned = await clearPreviewV2StubRows();
  }

  console.log(
    JSON.stringify(
      {
        targets,
        reach,
        written,
        cleaned,
        productionTablesUntouched: true,
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
