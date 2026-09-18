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
  parsePnu,
  parseCadastralPnu,
  buildLandAgnosticParcelKey,
  trailingLotAgreesPnu,
  alignedCadastralPnuFromAddress,
  parseSameRowLot,
  deriveSameRowCadastralPnu,
} from "../src/lib/complex-coordinates/parcel-key";
import {
  indexParcelPoints,
  joinExactPnu,
  quantile,
} from "../src/lib/complex-coordinates/parcel-point-join";
import { classifySameRowRepair } from "../src/lib/complex-coordinates/same-row-pnu-repair";

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
assert(parsePnu("1171010100100190000")?.platGb === "1", "reb plat digit preserved");
assert(parsePnu("1171010100000190000")?.bun === "0019", "leading-zero bun");
assert(parsePnu("1171010100000190010")?.ji === "0010", "bun+ji");
assert(parsePnu(" 1171010100100190000 ")?.pnu === "1171010100100190000", "trim spaces");
assert(parsePnu("123") === null, "invalid length");
assert(parsePnu(null) === null, "null pnu");
assert(parsePnu("1171010100300190000") === null, "unknown plat digit");
assert(parsePnu("1111010100200040036")?.platGb === "2", "mountain plat 2 preserved");
assert(parseCadastralPnu("1111010100200040036")?.pnu === "1111010100200040036", "cadastral mountain");
assert(parseCadastralPnu("1171010100100190000")?.bun === "0019", "cadastral leading zero");
assert(parseCadastralPnu("1171010100000190000") === null, "hub plat 0 is not cadastral");
assert(parseCadastralPnu(null) === null, "cadastral null");

const points = indexParcelPoints([
  { pnu: "1171010100100190000", lat: 37.51413457, lng: 127.07932524, sourceDate: "2026-09-05", method: "PARCEL_REPRESENTATIVE_POINT" },
  { pnu: "1111010100100800001", lat: 37.58, lng: 126.97, sourceDate: "2026-09-05", method: "PARCEL_REPRESENTATIVE_POINT" },
  { pnu: "1111010100100800001", lat: 37.58, lng: 126.97, sourceDate: "2026-09-05", method: "PARCEL_REPRESENTATIVE_POINT" },
  { pnu: "1111010100100120023", lat: 37.1, lng: 127.1, sourceDate: "2026-09-05", method: "PARCEL_REPRESENTATIVE_POINT" },
  { pnu: "1111010100100120023", lat: 37.2, lng: 127.2, sourceDate: "2026-09-05", method: "PARCEL_REPRESENTATIVE_POINT" },
]);
assert(points.get("1171010100100190000")?.status === "UNIQUE", "unique parcel");
assert(points.get("1111010100100800001")?.status === "DUPLICATE_IDENTICAL", "identical duplicate collapsed");
assert(points.get("1111010100100120023")?.status === "DUPLICATE_CONFLICT", "conflict not first-row");
assert(Number.isNaN(points.get("1111010100100120023")?.lat), "conflict coord cleared");

const ok = (lat: number, lng: number) => lat > 37 && lng > 126;
const exact = joinExactPnu(["1171010100100190000"], points, ok);
assert(exact.status === "EXACT_PNU" && exact.spatialPnu === "1171010100100190000", "exact join");
const dup = joinExactPnu(["1111010100100800001"], points, ok);
assert(dup.status === "EXACT_PNU" && dup.lat === 37.58, "identical duplicate join");
const conflict = joinExactPnu(["1111010100100120023"], points, ok);
assert(conflict.status === "DUPLICATE_GEOMETRY" && conflict.lat === null, "conflict join refuses first");
const multi = joinExactPnu(["1171010100100190000", "1111010100100800001"], points, ok);
assert(multi.status === "MULTI_PARCEL" && multi.lat === null, "multi parcel does not pick first");
const missing = joinExactPnu(["1171010100100990000"], points, ok);
assert(missing.status === "PNU_NOT_FOUND", "missing pnu");
const none = joinExactPnu([], points, ok);
assert(none.status === "NO_PNU", "empty pnu list");
assert(quantile([1, 2, 3, 4], 0.5) === 2.5, "median");
assert(
  buildLandAgnosticParcelKey("1171010100000190000") ===
    buildLandAgnosticParcelKey("1171010100100190000"),
  "land-agnostic alias",
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
assert(trailingLotAgreesPnu("서울특별시 송파구 잠실동 19", "1171010100100190000") === true, "jamsil lot agrees");
assert(trailingLotAgreesPnu("서울특별시 구로구 궁동 211-1", "1153010900102110000") === false, "stored ji 0000 disagrees");
assert(
  alignedCadastralPnuFromAddress("1153010900102110000", "서울특별시 구로구 궁동 211-1") ===
    "1153010900102110001",
  "align ji from same row address",
);
assert(
  alignedCadastralPnuFromAddress("1171010100100190000", "서울특별시 송파구 잠실동 19") === null,
  "no align when agree",
);

const hit = (pnu: string) => (query: string) => (query === pnu ? "UNIQUE_VALID" as const : "MISSING" as const);
assert(parseSameRowLot("서울특별시 구로구 궁동 211-1")?.ji === "0001", "sublot 1");
assert(parseSameRowLot("서울특별시 성북구 정릉동 산87-85")?.mountain === true, "mountain token");
assert(parseSameRowLot("서울특별시 강서구 마곡동 수명산 12")?.mountain === false, "dong syllable is not mountain");
assert(deriveSameRowCadastralPnu("1153010900102110000", "서울특별시 구로구 궁동 211-1").pnu === "1153010900102110001", "seonwoo derived");
assert(deriveSameRowCadastralPnu("1165010800114580000", "서울특별시 서초구 서초동 1458-6").pnu === "1165010800114580006", "seocho derived");
assert(deriveSameRowCadastralPnu("1129013300200870000", "서울특별시 성북구 정릉동 산87-85").pnu === "1129013300200870085", "mountain sublot");
assert(deriveSameRowCadastralPnu("1129013300100870000", "서울특별시 성북구 정릉동 산87-85").cause === "PLAT_MISMATCH", "plat mismatch");

const seonwoo = classifySameRowRepair(
  ["1153010900102110000"],
  ["서울특별시 구로구 궁동 211-1"],
  hit("1153010900102110001"),
);
assert(seonwoo.classification === "REPAIRED_FROM_SAME_ROW_LOT" && seonwoo.cause === "SUBLOT_0000_TO_NONEMPTY", "missing stored repaired");
const lotConflict = classifySameRowRepair(
  ["1153010900102110000"],
  ["서울특별시 구로구 궁동 211-1"],
  (pnu) => (pnu === "1153010900102110000" || pnu === "1153010900102110001" ? "UNIQUE_VALID" : "MISSING"),
);
assert(lotConflict.classification === "ORIGINAL_CONFLICT_REPAIRED", "conflict uses address parcel");
const jamsilExact = classifySameRowRepair(
  ["1171010100100190000"],
  ["서울특별시 송파구 잠실동 19"],
  hit("1171010100100190000"),
);
assert(jamsilExact.classification === "EXACT_ORIGINAL" && jamsilExact.derivedPnu === "1171010100100190000", "jamsil stays original");
assert(classifySameRowRepair([], ["서울 궁동 211-1"], hit("x")).classification === "NO_SOURCE_PARCEL", "no pnu no inference");
assert(
  classifySameRowRepair(["1153010900102110000"], ["서울특별시 구로구 궁동 211-1"], () => "MISSING").classification === "NOT_FOUND",
  "derived miss stays unresolved",
);
assert(
  classifySameRowRepair(
    ["1153010900102110000"],
    ["서울특별시 구로구 궁동 211-1", "서울특별시 구로구 궁동 211-2"],
    hit("1153010900102110001"),
  ).classification === "AMBIGUOUS",
  "two lots on same pnu are ambiguous",
);
assert(
  classifySameRowRepair(["1153010900102110000"], ["서울특별시 구로구 궁동 211-1"], () => "DUPLICATE").classification === "AMBIGUOUS",
  "duplicate geometry refused",
);

console.log("test-complex-coordinate-sources: PASS");
