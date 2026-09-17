/**
 * Minimal school-district pilot tests (잠실엘스 · 강동송파학교군).
 * No network. No DB write.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attachDistancesToDistrictMembers,
  formatDistrictDistance,
  sortDistrictMembersByDistance,
  SCHOOL_DISTRICT_DEFAULT_VISIBLE,
  type ProductSchoolDistrict,
} from "../src/lib/complex-detail/school-district";
import { buildSchoolDistrictsPayload } from "../src/lib/complex-detail/school-district-server";
import { JAMSIL_ELS_MAP_PILOT } from "../src/lib/nearby-map/jamsil-els-pilot";

function loadSeed() {
  const path = join(
    process.cwd(),
    "data/poc/school-district/seoul-high-gangdong-songpa.v1.json",
  );
  return JSON.parse(readFileSync(path, "utf8")) as {
    id: string;
    officialName: string;
    members: Array<{
      name: string;
      neisSdSchulCode: string | null;
      establishment: string;
    }>;
    complexLinks: Array<{ complexId: string; confidence: string }>;
  };
}

function main() {
  const seed = loadSeed();
  assert.equal(seed.id, "seoul-high-gangdong-songpa");
  assert.equal(seed.officialName, "강동송파학교군");
  assert.equal(seed.members.length, 26);
  assert.ok(
    seed.members.every((m) => m.neisSdSchulCode && /^\d{7}$/.test(m.neisSdSchulCode)),
    "all members must have NEIS SD_SCHUL_CODE",
  );
  assert.equal(
    seed.complexLinks[0]?.complexId,
    JAMSIL_ELS_MAP_PILOT.complexId,
  );

  const payload = buildSchoolDistrictsPayload({ aptName: "잠실엘스" });
  assert.equal(payload.highStatus, "CONFIRMED");
  assert.equal(payload.middleStatus, "HOLD_UNCONFIRMED");
  assert.equal(payload.middle, null);
  assert.ok(payload.high);
  assert.equal(payload.high.officialName, "강동송파학교군");
  assert.equal(payload.high.memberCount, 26);
  assert.equal(payload.high.members.length, 26);
  assert.match(payload.high.description, /일반학교군/);
  assert.match(payload.high.infoText, /배정학교를 의미하지 않습니다/);
  assert.doesNotMatch(payload.high.description, /배정되는 학교/);
  assert.ok(payload.high.members.every((m) => m.detailLinkable));
  assert.ok(payload.high.members.every((m) => m.isNearby === false));

  const other = buildSchoolDistrictsPayload({ aptName: "래미안" });
  assert.equal(other.high, null);
  assert.equal(other.highStatus, "NOT_APPLICABLE");

  const center = { lat: 37.5133051, lng: 127.0815962 };
  const places = [
    {
      schoolCode: "7011112",
      name: "잠일고등학교",
      lat: 37.5115,
      lng: 127.0818,
    },
    {
      schoolCode: "7010106",
      name: "잠신고등학교",
      lat: 37.5148,
      lng: 127.0845,
    },
    {
      schoolCode: "7010712",
      name: "영동일고등학교",
      lat: 37.5102,
      lng: 127.088,
    },
  ];

  const withDist = attachDistancesToDistrictMembers(
    payload.high as ProductSchoolDistrict,
    center,
    places,
  );
  const ranked = withDist.members.filter((m) => m.distanceM != null);
  assert.ok(ranked.length >= 3);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(
      (ranked[i - 1].distanceM as number) <= (ranked[i].distanceM as number),
      "distance ASC",
    );
  }
  assert.equal(withDist.members[0].name, "잠일고등학교");
  assert.equal(withDist.members[0].isNearby, true);
  assert.ok(
    withDist.members.find((m) => m.name === "강일고등학교")?.isNearby === false,
  );

  const preview = ranked.slice(0, SCHOOL_DISTRICT_DEFAULT_VISIBLE);
  assert.equal(preview.length, SCHOOL_DISTRICT_DEFAULT_VISIBLE);
  // Compact UI no longer shows these as default rows; constant remains for sheet/helpers.
  assert.equal(SCHOOL_DISTRICT_DEFAULT_VISIBLE, 3);

  assert.equal(formatDistrictDistance(186), "186m");
  assert.equal(formatDistrictDistance(1200), "1.2km");
  assert.equal(formatDistrictDistance(null), null);

  const resorted = sortDistrictMembersByDistance([
    { ...withDist.members[2], distanceM: 900 },
    { ...withDist.members[0], distanceM: 100 },
    { ...withDist.members[5], distanceM: null },
  ]);
  assert.equal(resorted[0].distanceM, 100);
  assert.equal(resorted[resorted.length - 1].distanceM, null);

  // Assignment misrepresentation guard on product strings
  const blob = JSON.stringify(payload.high);
  assert.doesNotMatch(blob, /이 아파트에 배정/);
  assert.doesNotMatch(blob, /"title":\s*"배정학교"/);

  console.log("test-school-district-pilot: PASS");
  console.log(
    JSON.stringify(
      {
        high: payload.high.officialName,
        members: payload.high.memberCount,
        top3: preview.map((m) => ({
          name: m.name,
          code: m.schoolCode,
          distanceM: m.distanceM,
        })),
        middleStatus: payload.middleStatus,
      },
      null,
      2,
    ),
  );
}

main();
