import assert from "node:assert/strict";
import {
  classifyInternalPnus,
  classifySupplyConflict,
  decodeParcelPnu,
  sameIncrementalSource,
} from "../src/lib/unit-type/supply-residual";

const pnu = "1168010100001750000";
const decoded = decodeParcelPnu(pnu);
assert.equal(decoded?.lawdCd, "11680");
assert.equal(decoded?.bjdongCd, "10100");
assert.equal(decoded?.platGbCd, "0");
assert.equal(decoded?.bun, "0175");
assert.equal(decoded?.ji, "0000");
assert.equal(decodeParcelPnu("1168010100"), null);
assert.equal(decodeParcelPnu("서리 175"), null);

const recovered = classifyInternalPnus([pnu, pnu], "11680", "10100");
assert.equal(recovered.status, "IDENTITY_RECOVERED");
assert.equal(classifyInternalPnus([], "11680", "10100").status, "IDENTITY_STILL_MISSING");
assert.equal(classifyInternalPnus([pnu], "11110", "10100").status, "IDENTITY_CONFLICT");
assert.equal(
  classifyInternalPnus(["1168010100001750000", "1168010100001760000"], "11680", "10100").status,
  "IDENTITY_CONFLICT",
);

assert.equal(
  classifySupplyConflict({
    exclusiveCents: 8499,
    heldSupplyCents: 11097,
    reason: "SOURCE_CONFLICT",
    provenanceJson: JSON.stringify({ incoming: [[84.9939, 110.9779]] }),
  }),
  "PRECISION_ONLY",
);
assert.equal(
  classifySupplyConflict({
    exclusiveCents: 5982,
    heldSupplyCents: 7866,
    reason: "SOURCE_CONFLICT",
    provenanceJson: JSON.stringify({ incoming: [[59.82, 72.574]] }),
  }),
  "REAL_VARIANT",
);
assert.equal(
  classifySupplyConflict({
    exclusiveCents: 8480,
    heldSupplyCents: 11152,
    reason: "SOURCE_CONFLICT",
    provenanceJson: JSON.stringify({ held: { source: "older" } }),
  }),
  "OLDER_SOURCE",
);
assert.equal(
  classifySupplyConflict({
    exclusiveCents: 8480,
    heldSupplyCents: 11152,
    reason: "SOURCE_CONFLICT",
    provenanceJson: JSON.stringify({ incoming: [[59.99, 80]] }),
  }),
  "IDENTITY_CONFLICT",
);
assert.equal(
  classifySupplyConflict({
    exclusiveCents: 8480,
    heldSupplyCents: 11152,
    reason: "GROUPED_DIFFERS_FROM_VERIFIED",
    provenanceJson: JSON.stringify({ incoming: [[84.8, 111.52]], formula: "grouped_average" }),
  }),
  "DERIVATION_CONFLICT",
);
assert.equal(
  classifySupplyConflict({
    exclusiveCents: 8480,
    heldSupplyCents: 11152,
    reason: "GROUPED_DIFFERS_FROM_VERIFIED",
    provenanceJson: JSON.stringify({ incoming: [[90, 111.52]] }),
  }),
  "DERIVATION_CONFLICT",
);
assert.equal(sameIncrementalSource({ month: "2026-08", sha256: "abc" }, { month: "2026-08", sha256: "abc" }), true);
assert.equal(sameIncrementalSource({ month: "2026-08", sha256: "abc" }, { month: "2026-09", sha256: "abc" }), false);

console.log("supply residual tests ok");
