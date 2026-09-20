import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { precheckAdditiveCreateSql } from "../src/lib/region-ranking/migration-precheck";
import {
  deriveOfficialSupplies,
  namesMatch,
  parseParcelJibun,
  priorityRank,
  type ExposRow,
} from "../src/lib/unit-type/official-expos";

const parcel = parseParcelJibun("22");
assert.deepEqual(parcel, { platGbCd: "0", bun: "0022", ji: "0000" });
assert.equal(parseParcelJibun("산12-3")?.platGbCd, "1");
assert.equal(parseParcelJibun("산12-3")?.bun, "0012");
assert.equal(parseParcelJibun(""), null);
assert.equal(namesMatch("잠실리센츠", "리센츠"), true);
assert.equal(namesMatch("다른아파트", "리센츠"), false);

function row(partial: Partial<ExposRow>): ExposRow {
  return {
    dongNm: "101동",
    hoNm: "101",
    flrNo: 1,
    bldNm: "잠실엘스",
    mainPurpsCdNm: "아파트",
    mgmBldrgstPk: "1",
    crtnDay: "20220813",
    ...partial,
  };
}

const exclusive = (ho: string, area: number): ExposRow =>
  row({
    hoNm: ho,
    exposPubuseGbCdNm: "전유",
    mainAtchGbCdNm: "주건축물",
    etcPurps: "아파트",
    area,
  });
const wall = (ho: string, area: number): ExposRow =>
  row({
    hoNm: ho,
    exposPubuseGbCdNm: "공용",
    mainAtchGbCdNm: "주건축물",
    etcPurps: "벽체",
    area,
  });
const parking = (ho: string, area: number): ExposRow =>
  row({
    hoNm: ho,
    exposPubuseGbCdNm: "공용",
    mainAtchGbCdNm: "부속건축물",
    etcPurps: "지하주차장",
    area,
  });

const rows: ExposRow[] = [];
for (let i = 0; i < 3; i += 1) {
  const ho = String(100 + i);
  rows.push(exclusive(ho, 84.88), wall(ho, 24.41), parking(ho, 30));
}
for (let i = 0; i < 3; i += 1) {
  const ho = String(200 + i);
  rows.push(exclusive(ho, 84.98), wall(ho, 31.14), parking(ho, 10));
  rows.push(row({
    hoNm: ho,
    exposPubuseGbCdNm: "공용",
    mainAtchGbCdNm: "주건축물",
    etcPurps: "계단실,승강기",
    area: 0,
  }));
}
const second = 116.71 - 84.98;
for (let i = 0; i < 3; i += 1) {
  const ho = String(300 + i);
  rows.push(
    row({ hoNm: ho, dongNm: "102동", exposPubuseGbCdNm: "전유", mainAtchGbCdNm: "주건축물", etcPurps: "아파트", area: 84.98 }),
    row({ hoNm: ho, dongNm: "102동", exposPubuseGbCdNm: "공용", mainAtchGbCdNm: "주건축물", etcPurps: "복도", area: second }),
  );
}

const derived = deriveOfficialSupplies(rows, "잠실엘스");
assert.equal(derived.distinguishable, true);
const one = derived.supplies.find((item) => item.exclusiveCents === 8488);
assert.equal(one?.supplyCents, 10929);
assert.equal(one?.formula, "exclusive_plus_residential_common");
const multi = derived.supplies.filter((item) => item.exclusiveCents === 8498).map((item) => item.supplyCents);
assert.deepEqual(multi, [11612, 11671]);
assert.equal(derived.units[0]?.otherCommonArea, 30);
assert.ok((derived.units[0]?.residentialCommonArea ?? 0) > 0);

const partialRows: ExposRow[] = [];
for (let i = 0; i < 3; i += 1) {
  partialRows.push(
    row({ hoNm: String(i), exposPubuseGbCdNm: "전유", mainAtchGbCdNm: "주건축물", etcPurps: "일부공유", area: 76.79 }),
    wall(String(i), 6),
  );
}
const partial = deriveOfficialSupplies(partialRows, "잠실엘스");
assert.equal(partial.supplies.length, 0);

assert.equal(priorityRank("11710", 3), 1);
assert.equal(priorityRank("41110", 2), 2);
assert.equal(priorityRank("28110", 0), 5);
assert.equal(priorityRank("26110", 0), 6);
assert.equal(priorityRank("12345", 0), 9);

const migration = readFileSync("src/lib/db/migrations/20260924_official_unit_area.sql", "utf8");
assert.equal(precheckAdditiveCreateSql(migration).ok, true);
console.log("official expos tests passed");
