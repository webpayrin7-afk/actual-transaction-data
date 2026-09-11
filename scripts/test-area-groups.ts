/**
 * Area grouping unit tests (no supply-area / no fake pyeong).
 * Run: npx tsx scripts/test-area-groups.ts
 */
import assert from "node:assert/strict";
import type { AptAreaOption } from "../src/lib/molit/apt";
import {
  buildAreaGroups,
  formatAreaGroupLabel,
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

const areas = [
  area(59.82, 3),
  area(59.91, 2),
  area(59.96, 1),
  area(84.78, 10),
  area(84.82, 4),
  area(84.97, 8),
  area(114.12, 5),
];

const groups = buildAreaGroups(areas);
assert.equal(groups.length, 3);
assert.deepEqual(
  groups.map((g) => g.key),
  ["g:59", "g:84", "g:114"],
);
assert.equal(groups[0]!.members.length, 3);
assert.equal(groups[1]!.members.length, 3);
assert.equal(formatAreaGroupLabel(groups[0]!), "전용 59㎡형");
assert.equal(formatAreaGroupLabel(groups[1]!), "전용 84㎡형");
// Must NOT look like exclusive÷3.3 pyeong (59→약 18평)
assert.equal(formatAreaGroupLabel(groups[0]!).includes("평"), false);

assert.equal(itemMatchesAreaGroup(59.91, "g:59"), true);
assert.equal(itemMatchesAreaGroup(84.97, "g:59"), false);
assert.equal(itemMatchesAreaGroup(84.78, "g:84"), true);
assert.equal(itemMatchesAreaGroup(84.97, "all"), true);

assert.equal(resolveToAreaGroupKey("84.97", areas), "g:84");
assert.equal(resolveToAreaGroupKey("g:59", areas), "g:59");
assert.equal(resolveToAreaGroupKey("all", areas), "all");

const items = [
  trade(59.82, "2024-01-01"),
  trade(84.78, "2024-02-01"),
  trade(84.97, "2024-03-01"),
  trade(84.82, "2024-01-15"),
  trade(114.12, "2024-04-01"),
];
assert.equal(resolveDefaultAreaGroupKey(areas, items), "g:84");

const no84 = [area(59.82, 1), area(59.91, 10), area(74.5, 2)];
const no84Items = [
  trade(59.91, "2024-05-01"),
  trade(59.91, "2024-06-01"),
  trade(74.5, "2024-07-01"),
];
assert.equal(resolveDefaultAreaGroupKey(no84, no84Items), "g:59");

console.log("ok: area-groups");
