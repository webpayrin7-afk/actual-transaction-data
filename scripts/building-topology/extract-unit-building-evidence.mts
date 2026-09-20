import { createWriteStream, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import readline from "node:readline";
import {
  COMPACT_OUTPUT_COLUMNS,
  cell,
  csvEscape,
  isExclusiveAreaRow,
  isResidentialCommonRow,
  mapUnitEvidenceColumns,
  parseDelimitedHeader,
  physicalUnitKey,
  commonAreaJoinKey,
  splitCsvLine,
  type ColumnMapping,
} from "@/lib/buildings/unit-evidence";

const DEFAULT_INPUT = "C:\\data\\buildinghub\\2026-08\\filtered\\official_unit_area_bulk_filtered.csv.gz";
const DEFAULT_OUT = "C:\\data\\buildinghub\\2026-08\\filtered\\national_unit_building_evidence.csv.gz";
const DEFAULT_SUMMARY = "C:\\data\\buildinghub\\2026-08\\filtered\\national_unit_building_evidence_summary.json";

function resolveMaybeWindows(pathValue: string): string {
  if (/^[A-Za-z]:[\\/]/.test(pathValue)) {
    const mnt = `/mnt/${pathValue[0].toLowerCase()}/${pathValue.slice(3).replace(/\\/g, "/")}`;
    if (existsSync(pathValue)) return pathValue;
    if (existsSync(mnt)) return mnt;
    return pathValue;
  }
  return resolve(pathValue);
}

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function inspectHeader(inputPath: string): Promise<{
  mapping: ColumnMapping;
  delimiter: "," | "|" | "\t";
}> {
  const rl = readline.createInterface({
    input: createReadStream(inputPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    rl.close();
    const parsed = parseDelimitedHeader(line);
    return { mapping: mapUnitEvidenceColumns(parsed.header), delimiter: parsed.delimiter };
  }
  throw new Error("empty input; no header");
}

function mappingReport(mapping: ColumnMapping) {
  return {
    sourceColumns: mapping.header,
    unitRowPk: mapping.unitPk,
    parentBuildingPk: mapping.parentBuildingPk,
    dongLabel: mapping.dong,
    hoPhysicalUnit: mapping.ho,
    parentBuildingKeyPresent: mapping.parentBuildingKeyPresent,
    unitPkWouldBeMistakenForTitle: mapping.unitPkWouldBeMistakenForTitle,
    note: mapping.parentBuildingKeyPresent
      ? "표제부 parent key column present; use parent_building_pk only for building join"
      : "표제부 parent key ABSENT. mgmBldrgstPk in 전유공용면적 is the unit/전유부 PK, not 표제부. Do not rescan 44GB automatically.",
  };
}

async function extract(inputPath: string, outPath: string, mapping: ColumnMapping, delimiter: string) {
  mkdirSync(dirname(outPath), { recursive: true });
  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(outPath);
  const done = pipeline(gzip, out);
  gzip.write(`${COMPACT_OUTPUT_COLUMNS.join(",")}\n`);

  const stats = {
    inputRows: 0,
    eligibleRows: 0,
    outputRows: 0,
    complexes: new Set<string>(),
    buildings: new Set<string>(),
    physicalUnits: 0,
    exactBuildingIdentities: 0,
    missingBuildingIdentities: 0,
    duplicatePhysicalUnitKeys: 0,
    ambiguousJoins: 0,
    skippedNoIdentity: 0,
  };
  const seenUnit = new Map<string, number>();
  const commonByUnit = new Map<string, number>();

  const read = async (mode: "common" | "exclusive") => {
    const rl = readline.createInterface({
      input: createReadStream(inputPath).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    let headerSkipped = false;
    for await (const line of rl) {
      if (!headerSkipped) {
        headerSkipped = true;
        continue;
      }
      if (!line.trim()) continue;
      if (mode === "exclusive") stats.inputRows += 1;
      const cols = splitCsvLine(line, delimiter);
      const category = cell(cols, mapping, mapping.areaCategory);
      const atch = cell(cols, mapping, mapping.mainAtch);
      const etc = cell(cols, mapping, mapping.etcPurps);
      const complexId = cell(cols, mapping, mapping.complexId);
      const unitPk = cell(cols, mapping, mapping.unitPk);
      const parentPk = cell(cols, mapping, mapping.parentBuildingPk);
      const dong = cell(cols, mapping, mapping.dong);
      const ho = cell(cols, mapping, mapping.ho);
      const floor = cell(cols, mapping, mapping.floor);
      const ident = physicalUnitKey({
        unitRegisterPk: unitPk,
        complexId,
        parentBuildingPk: parentPk,
        dong,
        floor,
        ho,
      });
      const joinKey = commonAreaJoinKey({ complexId, dong, floor, ho });
      if (mode === "common") {
        if (!joinKey) continue;
        if (!isResidentialCommonRow(category, atch, etc)) continue;
        const areaRaw = cell(cols, mapping, mapping.area) || cell(cols, mapping, mapping.residentialCommon);
        const area = Number(areaRaw);
        if (!Number.isFinite(area) || area <= 0) continue;
        commonByUnit.set(joinKey, (commonByUnit.get(joinKey) ?? 0) + area);
        continue;
      }

      const flattened = mapping.flattenedExclusive;
      const exclusiveRow = flattened || !category || isExclusiveAreaRow(category, atch);
      if (!exclusiveRow) continue;
      stats.eligibleRows += 1;
      if (!ident.key) {
        stats.skippedNoIdentity += 1;
        continue;
      }
      const prev = seenUnit.get(ident.key) ?? 0;
      seenUnit.set(ident.key, prev + 1);
      if (prev > 0) {
        stats.duplicatePhysicalUnitKeys += 1;
        continue;
      }
      const exclusiveRaw = cell(cols, mapping, mapping.exclusiveArea) || cell(cols, mapping, mapping.area);
      const exclusive = Number(exclusiveRaw);
      if (!Number.isFinite(exclusive) || exclusive <= 0) continue;
      const commonPresent = cell(cols, mapping, mapping.residentialCommon);
      const commonFromCol = Number(commonPresent);
      const common =
        Number.isFinite(commonFromCol) && commonPresent !== ""
          ? commonFromCol
          : joinKey
            ? (commonByUnit.get(joinKey) ?? null)
            : null;
      const supplyPresent = cell(cols, mapping, mapping.supplyArea);
      const supplyFromCol = Number(supplyPresent);
      const supply =
        Number.isFinite(supplyFromCol) && supplyPresent !== ""
          ? supplyFromCol
          : common != null
            ? exclusive + common
            : "";
      if (complexId) stats.complexes.add(complexId);
      if (parentPk) {
        stats.buildings.add(parentPk);
        stats.exactBuildingIdentities += 1;
      } else {
        stats.missingBuildingIdentities += 1;
      }
      const row = {
        complex_id: complexId,
        pnu: cell(cols, mapping, mapping.pnu),
        unit_register_pk: unitPk,
        parent_building_pk: parentPk,
        dong_nm: dong,
        ho_nm: ho,
        floor,
        exclusive_area: String(exclusive),
        residential_common_area: common == null ? "" : String(common),
        supply_area: supply === "" ? "" : String(supply),
        area_category: category || (flattened ? "exclusive" : ""),
        main_usage: cell(cols, mapping, mapping.mainUsage),
        physical_unit_key: ident.key,
        physical_unit_key_kind: ident.kind,
        source_row_id: cell(cols, mapping, mapping.sourceRow),
        source_version: cell(cols, mapping, mapping.sourceVersion) || "2026-08",
      };
      gzip.write(`${COMPACT_OUTPUT_COLUMNS.map((c) => csvEscape(row[c])).join(",")}\n`);
      stats.outputRows += 1;
      stats.physicalUnits += 1;
    }
  };

  if (mapping.areaCategory && !mapping.flattenedExclusive) {
    await read("common");
  }
  await read("exclusive");
  gzip.end();
  await done;
  return stats;
}

async function main() {
  const inputPath = resolveMaybeWindows(argValue("--input", process.env.UNIT_AREA_BULK_PATH || DEFAULT_INPUT));
  const outPath = resolveMaybeWindows(argValue("--out", DEFAULT_OUT));
  const summaryPath = resolveMaybeWindows(argValue("--summary", DEFAULT_SUMMARY));
  const inspectOnly = process.argv.includes("--inspect-header");
  if (!existsSync(inputPath)) {
    console.error(JSON.stringify({
      error: "INPUT_NOT_FOUND",
      inputPath,
      LOCAL_EXECUTION_REQUIRED: "YES",
      command: `npx tsx scripts/building-topology/extract-unit-building-evidence.mts --input "${DEFAULT_INPUT}" --out "${DEFAULT_OUT}" --summary "${DEFAULT_SUMMARY}"`,
    }, null, 2));
    process.exit(2);
  }
  const { mapping, delimiter } = await inspectHeader(inputPath);
  const report = mappingReport(mapping);
  console.log(JSON.stringify({ delimiter, mapping: report }, null, 2));
  if (inspectOnly) return;
  const inputChecksum = await sha256File(inputPath);
  const stats = await extract(inputPath, outPath, mapping, delimiter);
  const outputChecksum = await sha256File(outPath);
  const { statSync } = await import("node:fs");
  const summary = {
    input: inputPath,
    output: outPath,
    inputChecksum,
    outputChecksum,
    inputBytes: statSync(inputPath).size,
    outputBytes: statSync(outPath).size,
    delimiter,
    columnMapping: report,
    inputRows: stats.inputRows,
    eligibleRows: stats.eligibleRows,
    complexes: stats.complexes.size,
    buildings: stats.buildings.size,
    physicalUnits: stats.physicalUnits,
    exactBuildingIdentities: stats.exactBuildingIdentities,
    missingBuildingIdentities: stats.missingBuildingIdentities,
    duplicatePhysicalUnitKeys: stats.duplicatePhysicalUnitKeys,
    ambiguousJoins: stats.ambiguousJoins,
    skippedNoIdentity: stats.skippedNoIdentity,
    outputRows: stats.outputRows,
    parentBuildingKey: mapping.parentBuildingPk,
    unitRowPk: mapping.unitPk,
    LOCAL_EXECUTION_REQUIRED: "NO",
  };
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
