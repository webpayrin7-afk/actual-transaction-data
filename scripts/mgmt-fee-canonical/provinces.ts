export type Province = { slug: string; sido_code: string; sido: string };

// Driver order: remaining metropolitan cities first, then provinces.
// Gwangju and Jeonnam are one sido (12) in apt_complex_master.
export const PROVINCES: readonly Province[] = [
  { slug: "incheon", sido_code: "28", sido: "인천광역시" },
  { slug: "busan", sido_code: "26", sido: "부산광역시" },
  { slug: "daegu", sido_code: "27", sido: "대구광역시" },
  { slug: "gwangju-jeonnam", sido_code: "12", sido: "전남광주통합특별시" },
  { slug: "daejeon", sido_code: "30", sido: "대전광역시" },
  { slug: "ulsan", sido_code: "31", sido: "울산광역시" },
  { slug: "sejong", sido_code: "36", sido: "세종특별자치시" },
  { slug: "gangwon", sido_code: "51", sido: "강원특별자치도" },
  { slug: "chungbuk", sido_code: "43", sido: "충청북도" },
  { slug: "chungnam", sido_code: "44", sido: "충청남도" },
  { slug: "jeonbuk", sido_code: "52", sido: "전북특별자치도" },
  { slug: "gyeongbuk", sido_code: "47", sido: "경상북도" },
  { slug: "gyeongnam", sido_code: "48", sido: "경상남도" },
  { slug: "jeju", sido_code: "50", sido: "제주특별자치도" },
];

export function provinceFromArgv(argv: readonly string[]): Province {
  const arg = argv.find((value) => value.startsWith("--province="));
  const slug = arg?.slice("--province=".length) ?? "";
  if (slug === "seoul" || slug === "gyeonggi") throw new Error(`${slug} is closed; use its own final scripts`);
  const province = PROVINCES.find((row) => row.slug === slug);
  if (!province) throw new Error(`unknown --province=${slug}`);
  return province;
}

export function provinceArtifactPrefix(province: Province): string {
  return `province-${province.slug}-final`;
}
