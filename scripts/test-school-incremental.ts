import assert from "node:assert/strict";
import { classifyHoldScope, resolveCurrentSnapshot, shouldRefetchScope } from "../src/lib/school-national/incremental";
import {
  isSafeParcelPoint,
  linksWithinRadius,
  nearbyDeltaAction,
  nearbyReadState,
  parcelCoordVersion,
} from "../src/lib/school-national/nearby-delta";

const current = resolveCurrentSnapshot([
  { disclosureYear: "2025", status: "COMPLETE", source: "schoolinfo" },
  { disclosureYear: "2026", status: "FAILED", source: "schoolinfo" },
  { disclosureYear: "2024", status: "NO_DATA", source: "schoolinfo" },
]);
assert.equal(current?.disclosureYear, "2025");
assert.equal(current?.status, "COMPLETE");

const onlyFailed = resolveCurrentSnapshot([
  { disclosureYear: "2026", status: "FAILED", source: "schoolinfo" },
]);
assert.equal(onlyFailed?.status, "FAILED");
assert.equal(resolveCurrentSnapshot([]), null);

assert.equal(shouldRefetchScope("complete", true), false);
assert.equal(shouldRefetchScope("empty", true), false);
assert.equal(shouldRefetchScope("available", true), false);
assert.equal(shouldRefetchScope("failed", true), true);
assert.equal(shouldRefetchScope("complete", false), true);

assert.equal(classifyHoldScope("12210", 22), "HISTORICAL_REGION_CODE_ALIAS");
assert.equal(classifyHoldScope("28125", 25), "HISTORICAL_REGION_CODE_ALIAS");
assert.equal(classifyHoldScope("27720", 0), "SAME_SCHOOL_CODE_VERSION");
assert.equal(classifyHoldScope("11110", 3), "UNKNOWN");

assert.equal(isSafeParcelPoint(null, null, "IDENTITY-READY"), false);
assert.equal(isSafeParcelPoint(37.5, 127.0, "IDENTITY-HOLD"), false);
assert.equal(isSafeParcelPoint(37.5, 127.0, "IDENTITY-READY"), true);
assert.equal(isSafeParcelPoint(0, 0, "IDENTITY-READY"), false);
assert.equal(parcelCoordVersion(37.58946373, 126.99525623), parcelCoordVersion(37.58946373, 126.99525623));

assert.equal(nearbyDeltaAction({
  safe: true,
  coordVersion: "parcel-rep|37.1000000|127.1000000",
  storedVersion: "parcel-rep|37.1000000|127.1000000",
  storedStatus: "READY",
}), "reuse");
assert.equal(nearbyDeltaAction({
  safe: true,
  coordVersion: "parcel-rep|37.2000000|127.1000000",
  storedVersion: "parcel-rep|37.1000000|127.1000000",
  storedStatus: "READY",
}), "rebuild");
assert.equal(nearbyDeltaAction({
  safe: false,
  coordVersion: null,
  storedVersion: null,
  storedStatus: null,
}), "skip_no_coordinate");

assert.equal(nearbyReadState({
  safe: false,
  storedVersion: null,
  currentVersion: null,
  linkCount: null,
}), "NO_COORDINATE");
assert.notEqual(nearbyReadState({
  safe: false,
  storedVersion: null,
  currentVersion: null,
  linkCount: 0,
}), "NO_SCHOOLS_WITHIN_RADIUS");

const links = linksWithinRadius(
  { lat: 37.5, lng: 127.0 },
  [
    { code: "S000000002", level: "elementary", lat: 37.5, lng: 127.0, sourceAsOf: "2026" },
    { code: "S000000001", level: "elementary", lat: 37.5, lng: 127.0, sourceAsOf: "2026" },
    { code: "S000000099", level: "middle", lat: 40.0, lng: 130.0, sourceAsOf: "2026" },
    { code: "S000000010", level: "high", lat: 37.5001, lng: 127.0, sourceAsOf: "2026" },
  ],
);
assert.equal(links.find((link) => link.code === "S000000099"), undefined);
const elementary = links.filter((link) => link.level === "elementary");
assert.deepEqual(elementary.map((link) => link.code), ["S000000001", "S000000002"]);
assert.deepEqual(elementary.map((link) => link.rank), [1, 2]);
assert.equal(links.find((link) => link.level === "high")?.rank, 1);

const noCoordResponse = {
  state: nearbyReadState({ safe: false, storedVersion: null, currentVersion: null, linkCount: null }),
  schools: null,
};
assert.equal(noCoordResponse.state, "NO_COORDINATE");
assert.equal(noCoordResponse.schools, null);
assert.ok(!Array.isArray(noCoordResponse.schools));

console.log("PASS school incremental policy");
