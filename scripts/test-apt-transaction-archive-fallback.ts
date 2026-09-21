/**
 * Fixture test for archive-from-detail fallback (no DB).
 */
import { buildArchiveFromDetail } from "../src/lib/apt/get-apt-transaction-archive";
import type { AptDetailResponse, AptHistoryItem } from "../src/lib/molit/apt-client";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function item(
  partial: Partial<AptHistoryItem> &
    Pick<AptHistoryItem, "id" | "dealType" | "dealDate" | "dealAmount">,
): AptHistoryItem {
  return {
    aptName: "잠실엘스",
    gu: "송파구",
    dong: "잠실동",
    exclusiveArea: 84.8,
    monthlyRent: 0,
    floor: 10,
    buildYear: 2008,
    jibun: "22",
    dealingGbn: "",
    isSingoga: false,
    pyeong: 26,
    ...partial,
  };
}

const detail: AptDetailResponse = {
  aptName: "잠실엘스",
  regionSlug: "seoul-songpa",
  regionName: "서울 송파",
  fullName: "서울특별시 송파구",
  gu: "송파구",
  dong: "잠실동",
  buildYear: 2008,
  source: "mock",
  yearMonth: "202609",
  loadedMonths: 12,
  stats: {
    recent3mCount: 1,
    maxDealAmount: 280000,
    avgDealAmount: 260000,
    totalTradeCount: 2,
    totalRentCount: 2,
  },
  areas: [
    {
      key: "84.8",
      label: "84.80㎡",
      exclusiveArea: 84.8,
      count: 3,
      selectorKind: "exclusive",
    },
    {
      key: "59.9",
      label: "59.90㎡",
      exclusiveArea: 59.9,
      count: 1,
      selectorKind: "exclusive",
    },
  ],
  chart: [],
  items: [
    item({
      id: "t1",
      dealType: "trade",
      dealDate: "2026-09-12",
      dealAmount: 280000,
    }),
    item({
      id: "t2",
      dealType: "trade",
      dealDate: "2025-03-01",
      dealAmount: 240000,
    }),
    item({
      id: "j1",
      dealType: "rent",
      dealDate: "2026-08-01",
      dealAmount: 90000,
      monthlyRent: 0,
    }),
    item({
      id: "m1",
      dealType: "rent",
      dealDate: "2026-07-15",
      dealAmount: 20000,
      monthlyRent: 120,
      exclusiveArea: 59.9,
    }),
  ],
};

const sale = buildArchiveFromDetail(detail, {
  aptName: "잠실엘스",
  regionSlug: "seoul-songpa",
  areaKey: "84.8",
  type: "trade",
  year: "all",
  offset: 0,
  limit: 20,
});

assert(sale.items.length === 2, `sale items ${sale.items.length}`);
assert(sale.kpi.tradeCount === 2, `tradeCount ${sale.kpi.tradeCount}`);
assert(sale.kpi.saleHigh?.amount === 280000, "sale high");
assert(sale.kpi.saleHigh?.date === "2026-09-12", "sale high date");
assert(sale.years[0] === 2026 && sale.years.includes(2025), "years");
assert(sale.hasMore === false, "no more on first page");
assert(sale.metaIncluded === true, "meta on offset 0");

const sale2026 = buildArchiveFromDetail(detail, {
  aptName: "잠실엘스",
  regionSlug: "seoul-songpa",
  areaKey: "84.8",
  type: "trade",
  year: "2026",
});
assert(sale2026.items.length === 1, "year filter");
assert(sale2026.items[0]?.id === "t1", "year filter id");
assert(sale2026.kpi.tradeCount === 1, "year trade count");

const monthly = buildArchiveFromDetail(detail, {
  aptName: "잠실엘스",
  regionSlug: "seoul-songpa",
  areaKey: "59.9",
  type: "monthly",
  year: "all",
});
assert(monthly.items.length === 1, "monthly items");
assert(monthly.kpi.monthlyCount === 1, "monthly count");
assert(monthly.kpi.monthlyRentHigh?.amount === 120, "monthly rent high");

const page2 = buildArchiveFromDetail(detail, {
  aptName: "잠실엘스",
  regionSlug: "seoul-songpa",
  areaKey: "84.8",
  type: "trade",
  year: "all",
  offset: 20,
  limit: 20,
});
assert(page2.metaIncluded === false, "no meta on later page");
assert(page2.items.length === 0, "empty later page");
assert(page2.kpi.tradeCount === 0, "empty kpi on later page");

console.log("ok: archive-from-detail fallback");
