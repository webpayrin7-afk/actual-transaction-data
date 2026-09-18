import {
  buildPnu,
  composeJibunAddress,
  inSeoulBbox,
  isValidWgs84,
  normalizeJibunAddress,
  normalizeRoadAddress,
  parseJibun,
  pnuLandAgnosticKey,
  roadAddressJoinKey,
} from "../src/lib/complex-coordinates/parcel-key";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(parseJibun("19")?.bun === "0019" && parseJibun("19")?.ji === "0000", "jibun 19");
assert(parseJibun("128-10")?.bun === "0128" && parseJibun("128-10")?.ji === "0010", "jibun 128-10");
assert(parseJibun("abc") === null, "reject non-numeric jibun");

const pnu = buildPnu({
  lawdCd: "11710",
  bjdongCd: "10100",
  platGb: "0",
  bun: "0019",
  ji: "0000",
});
assert(pnu === "1171010100000190000", `pnu got ${pnu}`);
assert(
  buildPnu({
    lawdCd: "11710",
    bjdongCd: "10100",
    platGb: null,
    bun: "0019",
    ji: "0000",
  }) === null,
  "no invent platGb",
);

assert(
  pnuLandAgnosticKey("1171010100000190000") ===
    pnuLandAgnosticKey("1171010100100190000"),
  "land-agnostic equalizes hub0 vs reb1",
);
assert(
  pnuLandAgnosticKey("1171010100000190000") === "117101010000190000",
  "land-agnostic key shape",
);

assert(
  normalizeRoadAddress("서울특별시 송파구 올림픽로 99") === "서울 송파구 올림픽로 99",
  "road norm",
);
assert(roadAddressJoinKey("서울특별시 송파구 올림픽로 99") === "올림픽로 99", "road key full");
assert(roadAddressJoinKey("올림픽로 99") === "올림픽로 99", "road key short");
assert(
  roadAddressJoinKey("서울특별시 서대문구 통일로48가길 37") ===
    roadAddressJoinKey("통일로48가길 37"),
  "road key match across forms",
);

assert(
  composeJibunAddress({
    sido: "서울특별시",
    sigungu: "송파구",
    dong: "잠실동",
    jibun: "19",
  }) === "서울 송파구 잠실동 19",
  "compose jibun",
);
assert(
  normalizeJibunAddress("서울특별시 송파구 잠실동 19 잠실엘스") === "서울 송파구 잠실동 19",
  "strip trailing name",
);

assert(isValidWgs84(37.5, 127.0), "valid wgs");
assert(!isValidWgs84(0, 0), "reject 0,0");
assert(inSeoulBbox(37.5133051, 127.0815962), "jamsil in seoul");
assert(!inSeoulBbox(35.1, 129.0), "busan outside");

console.log("test-complex-coordinate-sources: PASS");
