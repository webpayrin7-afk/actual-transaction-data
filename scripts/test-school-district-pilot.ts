/**
 * Minimal school-district + attendance-zone pilot tests (잠실엘스).
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
import { buildAttendanceZonePayload } from "../src/lib/complex-detail/attendance-zone-server";
import { attachDistancesToAttendanceSchools } from "../src/lib/complex-detail/attendance-zone";
import { JAMSIL_ELS_MAP_PILOT } from "../src/lib/nearby-map/jamsil-els-pilot";

function loadHighSeed() {
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

function loadMiddleSeed() {
  const path = join(
    process.cwd(),
    "data/poc/school-district/seoul-middle-gangdong-songpa-3.v1.json",
  );
  return JSON.parse(readFileSync(path, "utf8")) as {
    id: string;
    officialName: string;
    members: Array<{
      name: string;
      neisSdSchulCode: string | null;
      establishment: string;
    }>;
  };
}

function loadElemSeed() {
  const path = join(
    process.cwd(),
    "data/poc/attendance-zone/seoul-jamsil-jam-il-elementary.v1.json",
  );
  return JSON.parse(readFileSync(path, "utf8")) as {
    id: string;
    officialName: string;
    zoneKind: string;
    designatedSchool: { name: string; neisSdSchulCode: string };
  };
}

function main() {
  const seed = loadHighSeed();
  assert.equal(seed.id, "seoul-high-gangdong-songpa");
  assert.equal(seed.officialName, "강동송파학교군");
  assert.equal(seed.members.length, 26);
  assert.ok(
    seed.members.every((m) => m.neisSdSchulCode && /^\d{7}$/.test(m.neisSdSchulCode)),
    "all high members must have NEIS SD_SCHUL_CODE",
  );
  assert.equal(
    seed.complexLinks[0]?.complexId,
    JAMSIL_ELS_MAP_PILOT.complexId,
  );

  const middleSeed = loadMiddleSeed();
  assert.equal(middleSeed.id, "seoul-middle-gangdong-songpa-3");
  assert.equal(middleSeed.officialName, "강동송파3학교군");
  assert.equal(middleSeed.members.length, 11);
  assert.ok(
    middleSeed.members.every(
      (m) => m.neisSdSchulCode && /^\d{7}$/.test(m.neisSdSchulCode),
    ),
  );
  assert.ok(middleSeed.members.some((m) => m.name === "신천중학교"));
  assert.ok(middleSeed.members.some((m) => m.name === "잠실여자중학교"));

  const elemSeed = loadElemSeed();
  assert.equal(elemSeed.officialName, "서울잠일초통학구역");
  assert.equal(elemSeed.zoneKind, "single");
  assert.equal(elemSeed.designatedSchool.name, "서울잠일초등학교");
  assert.equal(elemSeed.designatedSchool.neisSdSchulCode, "7130153");

  const payload = buildSchoolDistrictsPayload({ aptName: "잠실엘스" });
  assert.equal(payload.highStatus, "CONFIRMED");
  assert.equal(payload.middleStatus, "CONFIRMED");
  assert.ok(payload.middle);
  assert.equal(payload.middle.officialName, "강동송파3학교군");
  assert.equal(payload.middle.memberCount, 11);
  assert.equal(payload.middle.members.length, 11);
  assert.match(payload.middle.description, /중학교 학교군/);
  assert.match(payload.middle.infoText, /배정학교를 의미하지 않습니다/);
  assert.ok(payload.high);
  assert.equal(payload.high.officialName, "강동송파학교군");
  assert.equal(payload.high.memberCount, 26);
  assert.equal(payload.high.members.length, 26);
  assert.match(payload.high.description, /일반학교군/);
  assert.match(payload.high.infoText, /배정학교를 의미하지 않습니다/);
  assert.doesNotMatch(payload.high.description, /배정되는 학교/);
  assert.ok(payload.high.members.every((m) => m.detailLinkable));
  assert.ok(payload.high.members.every((m) => m.isNearby === false));
  assert.ok(payload.middle.members.every((m) => m.detailLinkable));

  const az = buildAttendanceZonePayload({ aptName: "잠실엘스" });
  assert.equal(az.elementaryStatus, "CONFIRMED");
  assert.ok(az.elementary);
  assert.equal(az.elementary.type, "attendance_zone");
  assert.equal(az.elementary.officialName, "서울잠일초통학구역");
  assert.equal(az.elementary.zoneKind, "single");
  assert.equal(az.elementary.ctaLabel, "통학구역 정보 보기");
  assert.match(az.elementary.description, /통학구역/);
  assert.doesNotMatch(az.elementary.infoText, /학교군 소속 학교는 실제 배정학교/);
  assert.equal(az.elementary.designatedSchools.length, 1);
  assert.equal(az.elementary.designatedSchools[0]?.name, "서울잠일초등학교");
  assert.equal(az.elementary.designatedSchools[0]?.schoolCode, "7130153");
  assert.equal(az.elementary.designatedSchools[0]?.detailLinkable, true);

  const other = buildSchoolDistrictsPayload({ aptName: "래미안" });
  assert.equal(other.high, null);
  assert.equal(other.middle, null);
  assert.equal(other.highStatus, "NOT_APPLICABLE");
  assert.equal(other.middleStatus, "NOT_APPLICABLE");
  const otherAz = buildAttendanceZonePayload({ aptName: "래미안" });
  assert.equal(otherAz.elementary, null);
  assert.equal(otherAz.elementaryStatus, "NOT_APPLICABLE");

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
    {
      schoolCode: "7130194",
      name: "신천중학교",
      lat: 37.51625,
      lng: 127.07928,
    },
    {
      schoolCode: "7130201",
      name: "잠신중학교",
      lat: 37.51614,
      lng: 127.0878,
    },
    {
      schoolCode: "7130153",
      name: "서울잠일초등학교",
      lat: 37.51474,
      lng: 127.08164,
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

  const midDist = attachDistancesToDistrictMembers(
    payload.middle as ProductSchoolDistrict,
    center,
    places,
  );
  assert.equal(midDist.members[0].name, "신천중학교");
  assert.ok((midDist.members[0].distanceM as number) > 0);

  const azDist = attachDistancesToAttendanceSchools(
    az.elementary!,
    center,
    places,
  );
  assert.equal(azDist.designatedSchools[0]?.isNearby, true);
  assert.ok((azDist.designatedSchools[0]?.distanceM as number) > 0);

  const preview = ranked.slice(0, SCHOOL_DISTRICT_DEFAULT_VISIBLE);
  assert.equal(preview.length, SCHOOL_DISTRICT_DEFAULT_VISIBLE);
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

  const blob = JSON.stringify(payload.high);
  assert.doesNotMatch(blob, /이 아파트에 배정/);
  assert.doesNotMatch(blob, /"title":\s*"배정학교"/);
  const midBlob = JSON.stringify(payload.middle);
  assert.doesNotMatch(midBlob, /이 아파트에 배정/);
  assert.doesNotMatch(JSON.stringify(az.elementary), /학교군 전체 보기/);

  console.log("test-school-district-pilot: PASS");
  console.log(
    JSON.stringify(
      {
        high: payload.high.officialName,
        highMembers: payload.high.memberCount,
        middle: payload.middle.officialName,
        middleMembers: payload.middle.memberCount,
        elementary: az.elementary.officialName,
        designated: az.elementary.designatedSchools[0]?.name,
        top3: preview.map((m) => ({
          name: m.name,
          code: m.schoolCode,
          distanceM: m.distanceM,
        })),
      },
      null,
      2,
    ),
  );
}

main();
