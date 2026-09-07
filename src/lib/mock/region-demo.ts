import type { RegionDef } from "@/lib/constants/regions";
import type { Transaction } from "@/types/transaction";

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function pick<T>(arr: T[], n: number): T {
  return arr[n % arr.length];
}

const APT_PREFIX = ["래미안", "자이", "푸르지오", "힐스테이트", "더샵", "아이파크", "롯데캐슬", "e편한세상"];
const APT_SUFFIX = ["센트럴", "퍼스트", "파크", "타워", "헤리티지", "포레", "뷰", "시티"];

/** 지역별로 안정적인 데모 거래 생성 (API Key 없을 때) */
export function buildRegionDemoTransactions(
  region: RegionDef,
  yearMonth: string,
): Transaction[] {
  const y = yearMonth.slice(0, 4);
  const m = yearMonth.slice(4, 6);
  const base = hash(region.slug + yearMonth);
  const items: Transaction[] = [];

  const districts =
    region.districts.length > 0
      ? region.districts
      : [{ code: region.lawdCodes[0] ?? "00000", name: region.name }];

  for (let i = 0; i < 12; i += 1) {
    const seed = base + i * 97;
    const district = pick(districts, seed);
    const day = String((seed % 27) + 1).padStart(2, "0");
    const isRent = seed % 5 === 0;
    const area = [59.98, 74.52, 84.91, 84.99, 101.85, 114.2][seed % 6];
    const floor = (seed % 25) + 1;
    const aptName = `${pick(APT_PREFIX, seed)}${region.name.replace(/(시|군|구)$/, "")}${pick(APT_SUFFIX, seed + 3)}`;
    const dealAmount = isRent
      ? 15000 + (seed % 40) * 1000
      : 45000 + (seed % 80) * 2500 + (region.metro === "seoul" ? 40000 : 0);
    const monthlyRent = isRent && seed % 2 === 0 ? 50 + (seed % 20) * 10 : 0;

    items.push({
      id: `demo-${region.slug}-${yearMonth}-${i}`,
      dealType: isRent ? "rent" : "trade",
      dealDate: `${y}-${m}-${day}`,
      aptName,
      gu: district.name,
      dong: `${district.name.replace(/(시|군|구)$/, "")}${["동", "읍", "면"][seed % 3] === "동" ? `${(seed % 9) + 1}동` : "중앙동"}`,
      exclusiveArea: area,
      dealAmount,
      monthlyRent,
      floor,
      buildYear: 1995 + (seed % 28),
      jibun: String(100 + (seed % 900)),
      dealingGbn: isRent ? (monthlyRent > 0 ? "월세" : "전세") : "중개거래",
    });
  }

  return items.sort((a, b) => (a.dealDate < b.dealDate ? 1 : -1));
}
