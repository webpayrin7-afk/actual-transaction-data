import {
  ALL_REGIONS,
  METRO_LABELS,
  type RegionDef,
} from "@/lib/constants/regions";

export type RegionSuggestion = {
  slug: string;
  name: string;
  fullName: string;
  metroLabel: string;
  matchLabel: string;
  score: number;
};

function normalize(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

function scoreRegion(query: string, region: RegionDef): RegionSuggestion | null {
  const q = normalize(query);
  if (!q) return null;

  const candidates: Array<{ label: string; weight: number }> = [
    { label: region.name, weight: 100 },
    { label: region.fullName, weight: 80 },
    ...region.districts.map((d) => ({ label: d.name, weight: 70 })),
  ];

  let best: RegionSuggestion | null = null;
  for (const candidate of candidates) {
    const key = normalize(candidate.label);
    let score = 0;
    if (key === q) score = 1000 + candidate.weight;
    else if (key.startsWith(q)) score = 500 + candidate.weight + q.length;
    else if (key.includes(q)) score = 200 + candidate.weight + q.length;
    else continue;

    const next: RegionSuggestion = {
      slug: region.slug,
      name: region.name,
      fullName: region.fullName,
      metroLabel: METRO_LABELS[region.metro] ?? region.metro,
      matchLabel:
        candidate.label === region.name ? region.fullName : candidate.label,
      score,
    };
    if (!best || next.score > best.score) best = next;
  }
  return best;
}

/** 지역 목록(ALL_REGIONS) 기반 클라이언트 제안 — RegionsPage와 동일 로직 */
export function suggestRegions(query: string, limit = 8): RegionSuggestion[] {
  const q = query.trim();
  if (!q) return [];

  const ranked = ALL_REGIONS.map((region) => scoreRegion(q, region))
    .filter((v): v is RegionSuggestion => Boolean(v))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ko"));

  const seen = new Set<string>();
  const unique: RegionSuggestion[] = [];
  for (const item of ranked) {
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);
    unique.push(item);
    if (unique.length >= limit) break;
  }
  return unique;
}
