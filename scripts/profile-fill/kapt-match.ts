/** Exact K-apt identity. No name similarity. */

export type ParcelKey = { bjd: string; plat: "0" | "1"; bun: string; ji: string };

export function parcelKeyString(k: ParcelKey): string {
  return `${k.bjd}|${k.plat}|${k.bun}|${k.ji}`;
}

export function normalizeAddress(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** 지번주소 안의 지번 토큰이 정확히 하나일 때만. */
export function jibunToken(address: string): { san: boolean; bun: string; ji: string } | null {
  const tokens = normalizeAddress(address).split(" ");
  const hits: Array<{ san: boolean; bun: string; ji: string }> = [];
  for (const token of tokens) {
    const m = /^(산)?(\d{1,4})(?:-(\d{1,4}))?$/.exec(token);
    if (!m) continue;
    hits.push({ san: Boolean(m[1]), bun: m[2]!.padStart(4, "0"), ji: (m[3] ?? "0").padStart(4, "0") });
  }
  return hits.length === 1 ? hits[0]! : null;
}

export function masterJibun(jibun: string): { san: boolean; bun: string; ji: string } | null {
  const text = jibun.replace(/\s+/g, "");
  const m = /^(산)?(\d{1,4})(?:-(\d{1,4}))?$/.exec(text);
  if (!m) return null;
  return { san: Boolean(m[1]), bun: m[2]!.padStart(4, "0"), ji: (m[3] ?? "0").padStart(4, "0") };
}

export function keyFromParts(bjd: string, san: boolean, bun: string, ji: string): ParcelKey | null {
  if (!/^\d{10}$/.test(bjd)) return null;
  return { bjd, plat: san ? "1" : "0", bun, ji };
}

export function keyFromPnu(pnu: string): ParcelKey | null {
  if (!/^\d{19}$/.test(pnu)) return null;
  const plat = pnu[10];
  if (plat !== "0" && plat !== "1") return null;
  return { bjd: pnu.slice(0, 10), plat, bun: pnu.slice(11, 15), ji: pnu.slice(15, 19) };
}
