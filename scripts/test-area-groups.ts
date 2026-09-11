/**
 * Area grouping unit tests.
 * Supply-area fields are absent → exclusive proximity clustering fallback.
 * Run: npx tsx scripts/test-area-groups.ts
 */
import assert from "node:assert/strict";
import type { AptAreaOption } from "../src/lib/molit/apt";
import {
  CLUSTER_MAX_GAP_SQM,
  CLUSTER_MAX_SPAN_SQM,
  HAS_SUPPLY_AREA_DATA,
  buildAreaGroups,
  formatAreaGroupPrimaryLabel,
  formatAreaGroupSecondaryLabel,
  itemMatchesAreaGroup,
  resolveDefaultAreaGroupKey,
  resolveToAreaGroupKey,
} from "../src/lib/apt/area-groups";

function area(sqm: number, count = 1): AptAreaOption {
  return {
    key: String(Math.round(sqm * 100) / 100),
    label: `${sqm}`,
    exclusiveArea: sqm,
    count,
  };
}

function trade(sqm: number, date: string, dealType = "trade") {
  return { dealType, exclusiveArea: sqm, dealDate: date };
}

assert.equal(HAS_SUPPLY_AREA_DATA, false);

// 한강(대우)류: 59~60 / 84 / 134~135 — floor 분리 없이 근접 클러스터
const hangangAreas = [
  area(59.82, 40),
  area(59.94, 80),
  area(60.0, 70),
  area(60.12, 77),
  area(84.78, 50),
  area(84.97, 90),
  area(134.48, 20),
  area(134.97, 15),
  area(135.12, 18),
];

const hangangGroups = buildAreaGroups(hangangAreas);
assert.equal(hangangGroups.length, 3);
assert.equal(formatAreaGroupPrimaryLabel(hangangGroups[0]!), "전용 59~60㎡형");
assert.equal(formatAreaGroupPrimaryLabel(hangangGroups[1]!), "전용 84㎡형");
assert.equal(formatAreaGroupPrimaryLabel(hangangGroups[2]!), "전용 134~135㎡형");
assert.equal(formatAreaGroupSecondaryLabel(hangangGroups[0]!), null);
assert.deepEqual(
  hangangGroups[0]!.members.map((m) => m.exclusiveArea),
  [59.82, 59.94, 60.0, 60.12],
);
assert.deepEqual(
  hangangGroups[1]!.members.map((m) => m.exclusiveArea),
  [84.78, 84.97],
);
assert.deepEqual(
  hangangGroups[2]!.members.map((m) => m.exclusiveArea),
  [134.48, 134.97, 135.12],
);
// 가짜 평형(÷3.3) 금지
assert.equal(formatAreaGroupPrimaryLabel(hangangGroups[0]!).includes("평"), false);
assert.equal(formatAreaGroupPrimaryLabel(hangangGroups[0]!).includes("24"), false);

const g59 = hangangGroups[0]!.key;
assert.equal(itemMatchesAreaGroup(59.94, g59, hangangGroups), true);
assert.equal(itemMatchesAreaGroup(60.12, g59, hangangGroups), true);
assert.equal(itemMatchesAreaGroup(84.97, g59, hangangGroups), false);
assert.equal(itemMatchesAreaGroup(84.78, hangangGroups[1]!.key, hangangGroups), true);

assert.equal(resolveToAreaGroupKey("84.97", hangangAreas), hangangGroups[1]!.key);
assert.equal(resolveToAreaGroupKey("all", hangangAreas), "all");

const hangangItems = [
  trade(59.94, "2024-01-01"),
  trade(84.78, "2024-02-01"),
  trade(84.97, "2024-03-01"),
  trade(134.97, "2024-04-01"),
];
assert.equal(
  resolveDefaultAreaGroupKey(hangangAreas, hangangItems),
  hangangGroups[1]!.key,
);

// 84 없으면 거래량 최다 그룹
const no84 = [area(59.82, 1), area(59.91, 10), area(60.05, 5), area(114.12, 2)];
const no84Groups = buildAreaGroups(no84);
assert.equal(no84Groups.length, 2);
assert.equal(formatAreaGroupPrimaryLabel(no84Groups[0]!), "전용 59~60㎡형");
const no84Items = [
  trade(59.91, "2024-05-01"),
  trade(59.91, "2024-06-01"),
  trade(60.05, "2024-06-15"),
  trade(114.12, "2024-07-01"),
];
assert.equal(resolveDefaultAreaGroupKey(no84, no84Items), no84Groups[0]!.key);

// 거리만으로 넓게 합치지 않음 (84 vs 114)
assert.ok(84 + CLUSTER_MAX_GAP_SQM < 114);
assert.ok(CLUSTER_MAX_SPAN_SQM < 20);

// gap이 크면 같은 인근이라도 분리 (강제 합치기 금지)
const farVariants = [area(134.0, 1), area(136.5, 1)];
const farGroups = buildAreaGroups(farVariants);
assert.equal(farGroups.length, 2);
assert.ok(136.5 - 134.0 > CLUSTER_MAX_GAP_SQM);

console.log("ok: area-groups", {
  hangang: hangangGroups.map((g) => ({
    key: g.key,
    label: formatAreaGroupPrimaryLabel(g),
    members: g.members.map((m) => m.exclusiveArea),
    count: g.count,
  })),
});
