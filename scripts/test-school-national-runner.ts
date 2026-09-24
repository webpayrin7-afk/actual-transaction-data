import assert from "node:assert/strict";
import {
  classifyComplex,
  compareTargets,
  emptyProgress,
  materializeNearbyLinks,
  parcelCoordVersion,
  priorityFor,
  regionFromSido,
  type ManifestTarget,
} from "../src/lib/school-national/national-runner";
import { buildSchoolGrid } from "../src/lib/school-national/nearby-delta";

assert.equal(regionFromSido("서울특별시"), "SEOUL");
assert.equal(regionFromSido("경기도"), "GYEONGGI");
assert.equal(regionFromSido("충청북도"), "CHUNGBUK");
assert.equal(priorityFor("SEOUL", "EXISTING_READY"), "P0_SEOUL");
assert.equal(priorityFor("GYEONGGI", "EXISTING_READY"), "P1_GYEONGGI");
assert.equal(priorityFor("BUSAN", "LIVING_FOLLOW"), "P2_LIVING_FOLLOW");

const wait = classifyComplex({
  complex_id: "cx_wait",
  sido: "경기도",
  lat: null,
  lng: null,
  identity_status: null,
  stored_version: null,
  stored_status: null,
  link_count: 0,
});
assert.equal(wait.status, "WAIT_COORDINATE");
assert.equal(wait.source, "LIVING_FOLLOW");

const ready = classifyComplex({
  complex_id: "cx_ready",
  sido: "서울특별시",
  lat: 37.5,
  lng: 127.0,
  identity_status: "IDENTITY-READY",
  stored_version: null,
  stored_status: null,
  link_count: 0,
});
assert.equal(ready.status, "READY_NEARBY");
assert.equal(ready.source, "EXISTING_READY");
assert.equal(ready.priority, "P0_SEOUL");

const version = parcelCoordVersion(37.5, 127.0);
const complete = classifyComplex({
  complex_id: "cx_done",
  sido: "서울특별시",
  lat: 37.5,
  lng: 127.0,
  identity_status: "IDENTITY-READY",
  stored_version: version,
  stored_status: "READY",
  link_count: 3,
});
assert.equal(complete.status, "COMPLETE");

const handoff = classifyComplex({
  complex_id: "cx_live",
  sido: "인천광역시",
  lat: 37.4,
  lng: 126.7,
  identity_status: "IDENTITY-READY",
  stored_version: null,
  stored_status: null,
  link_count: 0,
  livingHandoff: true,
});
assert.equal(handoff.source, "LIVING_FOLLOW");
assert.equal(handoff.status, "READY_NEARBY");

const a: ManifestTarget = { ...ready };
const b: ManifestTarget = { ...handoff };
assert.ok(compareTargets(a, b) < 0, "Seoul EXISTING before living follow");

const grid = buildSchoolGrid([
  { code: "S1", level: "elementary", lat: 37.5, lng: 127.0, sourceAsOf: "2026" },
  { code: "S2", level: "middle", lat: 37.5002, lng: 127.0, sourceAsOf: "2026" },
  { code: "S3", level: "high", lat: 40.0, lng: 130.0, sourceAsOf: "2026" },
]);
const links = materializeNearbyLinks({ lat: 37.5, lng: 127.0, grid });
assert.equal(links.length, 2);
assert.ok(links.every((l) => l.distanceM >= 0 && l.distanceM <= 1500));
assert.equal(links.find((l) => l.level === "elementary")?.rank, 1);

const progress = emptyProgress("2026-09-23T00:00:00.000Z");
assert.equal(progress.terminal_state, "RUNNING");
assert.equal(progress.wave, "EXISTING_READY");
assert.equal(progress.external_calls, 0);

console.log("test-school-national-runner: ok");
