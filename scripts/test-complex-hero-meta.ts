/**
 * Presentation-only HERO meta tests. No DB writes, no invented fields.
 */
import {
  complexHeroMeta,
  formatParkingPerHouseholdLabel,
  occupancyYearLabel,
} from "../src/lib/complex-detail/hero-meta";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(occupancyYearLabel("2008-09-30") === "2008년 입주", "approval date → year 입주");
assert(occupancyYearLabel("2008") === "2008년 입주", "year-only approval");
assert(occupancyYearLabel(null, 2008) === "2008년 입주", "buildYear fallback");
assert(occupancyYearLabel("09-30") === null, "do not invent year from incomplete date");
assert(occupancyYearLabel("1800-01-01") === null, "reject out-of-range year");
assert(formatParkingPerHouseholdLabel(1.36) === "주차 1.4대/세대", "parking 1 decimal");
assert(formatParkingPerHouseholdLabel(1) === "주차 1대/세대", "integer parking");

const els = complexHeroMeta({
  sido: "서울",
  sigungu: "송파구",
  legalDongName: "잠실동",
  approvalDate: "2008-09-30",
  householdCount: 5678,
  buildingCount: 72,
  maxFloor: 35,
  parkingPerHousehold: 1.36,
  farRatio: 275,
  bcrRatio: 18,
  heatingType: "지역난방",
});
assert(els.line1.join(" · ") === "서울 송파구 잠실동 · 2008년 입주", `line1 ${els.line1.join(" · ")}`);
assert(
  els.line2.join(" · ") === "5,678세대 · 72동 · 최고 35층 · 주차 1.4대/세대",
  `line2 ${els.line2.join(" · ")}`,
);
assert(els.line3.join(" · ") === "용적률 275% · 건폐율 18% · 지역난방", `line3 ${els.line3.join(" · ")}`);
assert(!els.line1.includes("2008년 준공"), "occupancy copy is 입주, not 준공");
assert(!JSON.stringify(els).includes("관리"), "managementType stays out of HERO");
assert(!JSON.stringify(els).includes("주차대수"), "parkingTotal stays out of HERO");

const sparse = complexHeroMeta({
  sido: "서울",
  sigungu: "송파구",
  legalDongName: "잠실동",
  approvalDate: "2008-09-30",
  householdCount: 5678,
  buildingCount: null,
  maxFloor: 35,
  parkingPerHousehold: null,
  farRatio: null,
  bcrRatio: 18,
  heatingType: null,
});
assert(sparse.line2.join(" · ") === "5,678세대 · 최고 35층", `sparse line2 ${sparse.line2.join(" · ")}`);
assert(sparse.line3.join(" · ") === "건폐율 18%", `sparse line3 ${sparse.line3.join(" · ")}`);
assert(!sparse.line2.includes("동"), "missing building count omitted");
assert(!String(sparse.line3).includes("용적률"), "missing FAR omitted");
assert(!String(sparse.line2).includes("—"), "no placeholder dash");

const emptyScale = complexHeroMeta({
  sido: "서울",
  sigungu: "강남구",
  legalDongName: "대치동",
  householdCount: null,
  buildingCount: 0,
  maxFloor: null,
  parkingPerHousehold: 0,
});
assert(emptyScale.line2.length === 0, "empty scale line is omitted");
assert(emptyScale.line3.length === 0, "empty density line is omitted");
assert(emptyScale.line1.join(" · ") === "서울 강남구 대치동", "location-only line 1");

const noDupYear = complexHeroMeta({
  approvalDate: "2011-03-01",
  buildYear: 2011,
  householdCount: 100,
});
assert(noDupYear.line1.filter((item) => item.includes("입주")).length === 1, "occupancy once");
assert(!noDupYear.line2.some((item) => item.includes("입주")), "year stays on line 1");

console.log("ok: complex-hero-meta");
