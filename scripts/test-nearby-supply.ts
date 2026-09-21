/**
 * Nearby supply normalization. No DB. Live Applyhome is not required.
 *
 *   npx tsx scripts/test-nearby-supply.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SUPPLY_EMPTY_MESSAGE,
  SUPPLY_UNAVAILABLE_MESSAGE,
  buildSupplyFeed,
  deriveSupplyStatus,
  normalizeApplyhomeRow,
  pickCompetition,
  type ApplyhomeDetailRow,
} from "../src/lib/complex-detail/nearby-supply";
import { fetchNearbySalesBySigungu } from "../src/lib/complex-detail/applyhome-nearby-sales";

const TODAY = new Date(Date.UTC(2026, 8, 21, 12, 0, 0));

function day(iso: string): Date {
  return new Date(`${iso}T12:00:00.000Z`);
}

function row(partial: ApplyhomeDetailRow): ApplyhomeDetailRow {
  return {
    HOUSE_MANAGE_NO: "1",
    PBLANC_NO: "1",
    HOUSE_NM: "테스트",
    HOUSE_SECD: "01",
    HOUSE_SECD_NM: "APT",
    HSSPLY_ADRES: "서울특별시 송파구 잠실동 1",
    ...partial,
  };
}

assert.equal(
  deriveSupplyStatus(
    {
      subscriptionStart: day("2026-10-01"),
      subscriptionEnd: day("2026-10-03"),
      contractStart: null,
      contractEnd: null,
      winnerDate: null,
      moveInYm: "202812",
    },
    TODAY,
  ),
  "upcoming",
);

assert.equal(
  deriveSupplyStatus(
    {
      subscriptionStart: day("2026-09-14"),
      subscriptionEnd: day("2026-09-21"),
      contractStart: null,
      contractEnd: null,
      winnerDate: null,
      moveInYm: "203101",
    },
    TODAY,
  ),
  "open",
  "active subscription stays 청약 중 even when move-in exists",
);

assert.equal(
  deriveSupplyStatus(
    {
      subscriptionStart: day("2026-09-14"),
      subscriptionEnd: day("2026-09-14"),
      contractStart: day("2026-09-18"),
      contractEnd: day("2026-09-19"),
      winnerDate: day("2026-09-17"),
      moveInYm: "203101",
    },
    TODAY,
  ),
  "move_in_upcoming",
);

assert.equal(
  deriveSupplyStatus(
    {
      subscriptionStart: day("2025-09-01"),
      subscriptionEnd: day("2025-09-03"),
      contractStart: day("2025-09-10"),
      contractEnd: day("2025-09-12"),
      winnerDate: null,
      moveInYm: "202601",
    },
    TODAY,
  ),
  null,
  "past move-in is excluded",
);

assert.equal(
  deriveSupplyStatus(
    {
      subscriptionStart: day("2026-09-01"),
      subscriptionEnd: day("2026-09-10"),
      contractStart: day("2026-09-18"),
      contractEnd: day("2026-09-30"),
      winnerDate: null,
      moveInYm: "202601",
    },
    TODAY,
  ),
  "closed",
  "pending contract without a future move-in stays 청약 종료",
);

const apt = normalizeApplyhomeRow(
  row({
    HOUSE_MANAGE_NO: "2024000590",
    PBLANC_NO: "2024000590",
    HOUSE_NM: "잠실 래미안아이파크",
    TOT_SUPLY_HSHLDCO: 589,
    RCEPT_BGNDE: "2026-09-01",
    RCEPT_ENDDE: "2026-09-30",
    MVN_PREARNGE_YM: "202812",
    RCRIT_PBLANC_DE: "2026-08-20",
  }),
  "APT",
  "송파구",
  TODAY,
);
assert.ok(apt);
assert.equal(apt.sourceType, "APT");
assert.equal(apt.supplyUnits, 589);
assert.equal(apt.supplyUnitsLabel, "589세대");
assert.equal(apt.currentStatus, "open");
assert.equal(apt.announcementDate, "2026-08-20");
assert.equal(apt.competition, null);
assert.equal(apt.id, "applyhome:apt:2024000590:2024000590");

const officetel = normalizeApplyhomeRow(
  row({
    HOUSE_SECD: "02",
    HOUSE_SECD_NM: "도시형/오피스텔/생활숙박시설/민간임대",
    HOUSE_DTL_SECD: "02",
    HOUSE_DTL_SECD_NM: "오피스텔",
    HOUSE_MANAGE_NO: "2026950080",
    PBLANC_NO: "2026950080",
    HOUSE_NM: "힐스테이트 송파더그리드",
    TOT_SUPLY_HSHLDCO: 1393,
    RCEPT_BGNDE: "",
    SUBSCRPT_RCEPT_BGNDE: "2026-09-14",
    SUBSCRPT_RCEPT_ENDDE: "2026-09-14",
    CNTRCT_CNCLS_BGNDE: "2026-09-18",
    CNTRCT_CNCLS_ENDDE: "2026-09-19",
    MVN_PREARNGE_YM: "203101",
    HSSPLY_ADRES: "서울특별시 송파구 장지동 909",
  }),
  "OFFICETEL",
  "송파구",
  TODAY,
);
assert.ok(officetel);
assert.equal(officetel.sourceType, "OFFICETEL");
assert.equal(officetel.supplyUnitsLabel, "1,393실");
assert.equal(officetel.currentStatus, "move_in_upcoming");
assert.equal(officetel.statusLabel, "입주 예정");
assert.equal(officetel.moveInLabel, "2031.01");
assert.equal(officetel.moveInPlannedYm, "203101");
assert.equal(officetel.regionLabel, "서울 송파구 장지동");
assert.equal(officetel.subscriptionEndDate, "2026-09-14");
assert.doesNotMatch(officetel.supplyUnitsLabel ?? "", /세대/);

assert.equal(
  normalizeApplyhomeRow(
    row({
      HOUSE_SECD: "02",
      HOUSE_SECD_NM: "도시형/오피스텔/생활숙박시설/민간임대",
      HOUSE_DTL_SECD: "03",
      HOUSE_DTL_SECD_NM: "도시형생활주택",
      MVN_PREARNGE_YM: "203001",
      SUBSCRPT_RCEPT_ENDDE: "2026-01-01",
    }),
    "OFFICETEL",
    "송파구",
    TODAY,
  ),
  null,
);
assert.equal(
  normalizeApplyhomeRow(
    row({
      HOUSE_DTL_SECD_NM: "생활숙박시설",
      HOUSE_DTL_SECD: "04",
      MVN_PREARNGE_YM: "203001",
    }),
    "OFFICETEL",
    "송파구",
    TODAY,
  ),
  null,
);

const missing = normalizeApplyhomeRow(
  row({
    HOUSE_MANAGE_NO: "9",
    PBLANC_NO: "9",
    HOUSE_NM: "일정만",
    TOT_SUPLY_HSHLDCO: "",
    MVN_PREARNGE_YM: "203203",
    PBLANC_URL: "",
  }),
  "APT",
  "송파구",
  TODAY,
);
assert.ok(missing);
assert.equal(missing.supplyUnitsLabel, null);
assert.equal(missing.competition, null);
assert.equal(missing.pblancUrl, null);
assert.equal(missing.subscriptionStartDate, null);
assert.equal(missing.currentStatus, "move_in_upcoming");

assert.equal(pickCompetition([{ CMPET_RATE: "-", SUBSCRPT_RANK_CODE: 1, RESIDE_SECD: "01" }]), null);
assert.equal(pickCompetition([]), null);
assert.deepEqual(
  pickCompetition([
    { CMPET_RATE: "0", SUBSCRPT_RANK_CODE: 1, RESIDE_SECD: "01" },
    { CMPET_RATE: "3.2", SUBSCRPT_RANK_CODE: 2, RESIDE_SECD: "01" },
  ]),
  { rate: 0, label: "1순위 해당지역 0:1" },
);

const duplicateName = buildSupplyFeed(
  [
    {
      sourceType: "OFFICETEL",
      row: row({
        HOUSE_SECD: "02",
        HOUSE_DTL_SECD: "02",
        HOUSE_DTL_SECD_NM: "오피스텔",
        HOUSE_MANAGE_NO: "A",
        PBLANC_NO: "A",
        HOUSE_NM: "같은이름",
        MVN_PREARNGE_YM: "203101",
        SUBSCRPT_RCEPT_ENDDE: "2026-01-01",
      }),
    },
    {
      sourceType: "OFFICETEL",
      row: row({
        HOUSE_SECD: "02",
        HOUSE_DTL_SECD: "02",
        HOUSE_DTL_SECD_NM: "오피스텔",
        HOUSE_MANAGE_NO: "A",
        PBLANC_NO: "A",
        HOUSE_NM: "같은이름",
        TOT_SUPLY_HSHLDCO: 10,
        MVN_PREARNGE_YM: "203101",
        SUBSCRPT_RCEPT_ENDDE: "2026-01-01",
      }),
    },
    {
      sourceType: "OFFICETEL",
      row: row({
        HOUSE_SECD: "02",
        HOUSE_DTL_SECD: "02",
        HOUSE_DTL_SECD_NM: "오피스텔",
        HOUSE_MANAGE_NO: "B",
        PBLANC_NO: "B",
        HOUSE_NM: "같은이름",
        MVN_PREARNGE_YM: "203006",
        SUBSCRPT_RCEPT_ENDDE: "2026-01-01",
      }),
    },
  ],
  "송파구",
  TODAY,
);
assert.equal(duplicateName.length, 2);
assert.deepEqual(
  duplicateName.map((card) => card.sourceId),
  ["B:B", "A:A"],
  "move-in months sort ascending; same name with a different id is kept",
);

const sorted = buildSupplyFeed(
  [
    {
      sourceType: "APT",
      row: row({
        HOUSE_MANAGE_NO: "m1",
        PBLANC_NO: "m1",
        HOUSE_NM: "나중입주",
        MVN_PREARNGE_YM: "203201",
        RCEPT_ENDDE: "2026-01-01",
      }),
    },
    {
      sourceType: "APT",
      row: row({
        HOUSE_MANAGE_NO: "u1",
        PBLANC_NO: "u1",
        HOUSE_NM: "예정",
        RCEPT_BGNDE: "2026-11-01",
        RCEPT_ENDDE: "2026-11-03",
        MVN_PREARNGE_YM: "202901",
      }),
    },
    {
      sourceType: "APT",
      row: row({
        HOUSE_MANAGE_NO: "o1",
        PBLANC_NO: "o1",
        HOUSE_NM: "마감임박",
        RCEPT_BGNDE: "2026-09-01",
        RCEPT_ENDDE: "2026-09-22",
        MVN_PREARNGE_YM: "202901",
      }),
    },
    {
      sourceType: "APT",
      row: row({
        HOUSE_MANAGE_NO: "o2",
        PBLANC_NO: "o2",
        HOUSE_NM: "날짜없음",
        RCEPT_BGNDE: "2026-09-01",
        MVN_PREARNGE_YM: "202901",
      }),
    },
    {
      sourceType: "APT",
      row: row({
        HOUSE_MANAGE_NO: "c1",
        PBLANC_NO: "c1",
        HOUSE_NM: "종료",
        RCEPT_BGNDE: "2026-09-01",
        RCEPT_ENDDE: "2026-09-10",
        CNTRCT_CNCLS_ENDDE: "2026-09-30",
        MVN_PREARNGE_YM: "202001",
      }),
    },
  ],
  "송파구",
  TODAY,
);
assert.deepEqual(
  sorted.map((card) => card.projectName),
  ["마감임박", "예정", "날짜없음", "종료", "나중입주"],
);

const ui = readFileSync("src/components/apt/ComplexNearbySalesSection.tsx", "utf8");
const route = readFileSync("src/app/api/complex-nearby-sales/route.ts", "utf8");
for (const file of [ui, route]) {
  assert.equal(file.includes("공공데이터"), false);
  assert.equal(file.includes("SERVICE_KEY"), false);
  assert.equal(file.includes("API 호출 실패"), false);
  assert.equal(file.includes("MOLIT_API_KEY"), false);
}
assert.equal(ui.includes("1km"), false);
assert.equal(ui.includes("도보"), false);
assert.equal(ui.includes("세대"), false);

async function main() {
const prevKey = process.env.MOLIT_API_KEY;
delete process.env.MOLIT_API_KEY;
const missingKey = await fetchNearbySalesBySigungu("송파구", { today: TODAY });
assert.equal(missingKey.status, "UNAVAILABLE");
assert.equal(missingKey.message, SUPPLY_UNAVAILABLE_MESSAGE);
assert.equal(JSON.stringify(missingKey).includes("공공데이터"), false);
assert.equal(JSON.stringify(missingKey).includes("SERVICE_KEY"), false);
if (prevKey) process.env.MOLIT_API_KEY = prevKey;

const partial = await fetchNearbySalesBySigungu("송파구", {
  today: TODAY,
  fetcher: async (endpoint) => {
    if (endpoint === "apt-detail") throw new Error("apt down");
    if (endpoint === "officetel-detail") {
      return [
        row({
          HOUSE_SECD: "02",
          HOUSE_DTL_SECD: "02",
          HOUSE_DTL_SECD_NM: "오피스텔",
          HOUSE_MANAGE_NO: "2026950080",
          PBLANC_NO: "2026950080",
          HOUSE_NM: "힐스테이트 송파더그리드",
          TOT_SUPLY_HSHLDCO: 1393,
          SUBSCRPT_RCEPT_BGNDE: "2026-09-14",
          SUBSCRPT_RCEPT_ENDDE: "2026-09-14",
          CNTRCT_CNCLS_ENDDE: "2026-09-19",
          MVN_PREARNGE_YM: "203101",
          HSSPLY_ADRES: "서울특별시 송파구 장지동 909",
        }),
      ];
    }
    throw new Error("competition down");
  },
});
assert.equal(partial.status, "AVAILABLE");
assert.equal(partial.items.length, 1);
assert.equal(partial.items[0]?.supplyUnitsLabel, "1,393실");
assert.equal(partial.items[0]?.competition, null);

const failed = await fetchNearbySalesBySigungu("송파구", {
  today: TODAY,
  fetcher: async () => {
    throw new Error("Applyhome HTTP 500");
  },
});
assert.equal(failed.status, "UNAVAILABLE");
assert.equal(failed.message, SUPPLY_UNAVAILABLE_MESSAGE);
assert.equal(failed.items.length, 0);

const empty = await fetchNearbySalesBySigungu("송파구", {
  today: TODAY,
  fetcher: async () => [],
});
assert.equal(empty.status, "EMPTY");
assert.equal(empty.message, SUPPLY_EMPTY_MESSAGE);
console.log("nearby-supply tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
