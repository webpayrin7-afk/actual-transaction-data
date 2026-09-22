/**
 * Unit checks for rgstDate normalize + archive registration labels.
 *   npx tsx scripts/test-rgst-date.ts
 */
import assert from "node:assert/strict";
import {
  archiveRegistrationDateTitle,
  archiveRegistrationLabel,
  normalizeMolitRgstDate,
  rgstDateFromTx,
} from "../src/lib/molit/rgst-date";
import { isSameTransactionContent, snapshotFromTx } from "../src/lib/db/sync-diff";
import type { Transaction } from "../src/types/transaction";

assert.equal(normalizeMolitRgstDate("24.04.19"), "2024-04-19");
assert.equal(normalizeMolitRgstDate("26.09.18"), "2026-09-18");
assert.equal(normalizeMolitRgstDate("2024-04-19"), "2024-04-19");
assert.equal(normalizeMolitRgstDate(""), null);
assert.equal(normalizeMolitRgstDate("  "), null);
assert.equal(normalizeMolitRgstDate("bogus"), null);

assert.equal(archiveRegistrationLabel("2024-01-27", "2024-04-19"), "등기완료");
assert.equal(archiveRegistrationLabel("2024-01-27", "24.04.19"), "등기완료");
assert.equal(archiveRegistrationLabel("2026-08-11", null), "등기 미확인");
assert.equal(archiveRegistrationLabel("2026-08-11", ""), "등기 미확인");
assert.equal(archiveRegistrationLabel("2022-12-31", null), null);
assert.equal(
  archiveRegistrationDateTitle("2024-04-19"),
  "등기일 2024.04.19",
);

const base: Transaction = {
  id: "t1",
  dealType: "trade",
  dealDate: "2024-01-27",
  aptName: "잠실엘스",
  gu: "송파구",
  dong: "잠실동",
  exclusiveArea: 84.8,
  dealAmount: 225000,
  monthlyRent: 0,
  floor: 12,
  buildYear: 2008,
  jibun: "19",
  dealingGbn: "중개거래",
  ingestMeta: {
    cdealType: "",
    cdealDay: "",
    rgstDate: "24.04.19",
    aptDong: "147",
  },
};

assert.equal(rgstDateFromTx(base), "2024-04-19");
const snapEmpty = snapshotFromTx({ ...base, rgstDate: null, ingestMeta: undefined });
const snapFilled = snapshotFromTx({ ...base, rgstDate: "2024-04-19" });
assert.equal(snapEmpty.rgstDate, "");
assert.equal(snapFilled.rgstDate, "2024-04-19");
assert.equal(isSameTransactionContent(snapEmpty, snapFilled), false);
assert.equal(isSameTransactionContent(snapFilled, snapFilled), true);

console.log(
  JSON.stringify({
    ok: true,
    cases: [
      "normalize-yy-mm-dd",
      "label-registered",
      "label-unresolved-2023plus",
      "label-pre2023-null",
      "dirty-when-rgst-fills",
    ],
  }),
);
