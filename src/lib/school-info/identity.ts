/** NEIS ↔ SchoolInfo identity (runtime only). No DB mapping table. */

export const SEOUL_SIDO = "11";
export const SONGPA_SGG = "11710";

export const KIND = {
  elementary: "02",
  middle: "03",
  high: "04",
} as const;

export type Kind = keyof typeof KIND;

/**
 * Runtime source-link: NEIS SD_SCHUL_CODE → SchoolInfo SCHUL_CODE.
 * Namespaces differ (e.g. 7130202 ≠ S010000888). Verified Songpa middle schools.
 */
export type NeisSchoolInfoLink = {
  neisSdSchulCode: string;
  schoolInfoSchulCode: string;
  name: string;
  /** Substring that must appear in SchoolInfo road address after normalize. */
  addressNeedle: string;
  kind: Kind;
  sidoCode: string;
  sggCode: string;
};

/**
 * RETAINED — NEIS SD_SCHUL_CODE and SchoolInfo SCHUL_CODE are different
 * namespaces (e.g. 7130202 ≠ S010000888). Dynamic same-code resolution fails
 * without these verified Songpa source-links. Prefer retaining over wrong-school
 * fallback; do not expand via fuzzy name matching.
 */
export const NEIS_TO_SCHOOLINFO_LINKS: readonly NeisSchoolInfoLink[] = [
  {
    neisSdSchulCode: "7130153",
    schoolInfoSchulCode: "S010000944",
    name: "서울잠일초등학교",
    addressNeedle: "올림픽로95",
    kind: "elementary",
    sidoCode: SEOUL_SIDO,
    sggCode: SONGPA_SGG,
  },
  {
    neisSdSchulCode: "7130202",
    schoolInfoSchulCode: "S010000888",
    name: "잠실중학교",
    addressNeedle: "올림픽로35길130",
    kind: "middle",
    sidoCode: SEOUL_SIDO,
    sggCode: SONGPA_SGG,
  },
  {
    neisSdSchulCode: "7130201",
    schoolInfoSchulCode: "S010000887",
    name: "잠신중학교",
    addressNeedle: "잠실로12",
    kind: "middle",
    sidoCode: SEOUL_SIDO,
    sggCode: SONGPA_SGG,
  },
  {
    neisSdSchulCode: "7010107",
    schoolInfoSchulCode: "S010000523",
    name: "잠실고등학교",
    addressNeedle: "올림픽로33길71",
    kind: "high",
    sidoCode: SEOUL_SIDO,
    sggCode: SONGPA_SGG,
  },
  {
    neisSdSchulCode: "7010106",
    schoolInfoSchulCode: "S010000522",
    name: "잠신고등학교",
    addressNeedle: "잠실로24",
    kind: "high",
    sidoCode: SEOUL_SIDO,
    sggCode: SONGPA_SGG,
  },
  {
    neisSdSchulCode: "7010712",
    schoolInfoSchulCode: "S010000496",
    name: "영동일고등학교",
    addressNeedle: "석촌호수로93",
    kind: "high",
    sidoCode: SEOUL_SIDO,
    sggCode: SONGPA_SGG,
  },
] as const;

/** Kind label only — never used as permanent school identity. */
export function inferKindFromNameHint(nameHint: string | null | undefined): Kind | null {
  const n = (nameHint ?? "").replace(/\s+/g, "");
  if (!n) return null;
  if (n.includes("초등학교") || n.endsWith("초등") || n.endsWith("초")) {
    return "elementary";
  }
  if (n.includes("중학교") || n.endsWith("중")) return "middle";
  if (n.includes("고등학교") || n.endsWith("고등") || n.endsWith("고")) {
    return "high";
  }
  return null;
}

export function parseKindParam(raw: string | null | undefined): Kind | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "elementary" || v === "middle" || v === "high") return v;
  if (v === "element" || v === "e" || v === "02") return "elementary";
  if (v === "m" || v === "03") return "middle";
  if (v === "h" || v === "04") return "high";
  return null;
}

export type ResolveMethod =
  | "same_code"
  | "known_link"
  | "verified_fields"
  | "unresolved";

export type ResolveResult = {
  appSchoolId: string;
  schoolInfoCode: string | null;
  method: ResolveMethod;
  row: Record<string, unknown> | null;
};

export function years(now = new Date()): number[] {
  const y = now.getFullYear();
  return [y, y - 1, y - 2];
}

export function normName(name: string): string {
  return name.replace(/\s+/g, "").trim();
}

/** Strip spaces/punctuation so road addresses can be compared across sources. */
export function normAddress(address: string): string {
  return address
    .replace(/[()（）]/g, "")
    .replace(/\s+/g, "")
    .replace(/[.,·]/g, "")
    .trim();
}

export function schoolInfoAddressOf(row: Record<string, unknown>): string {
  const parts = [
    String(row.SCHUL_RDNMA ?? "").trim(),
    String(row.SCHUL_RDNDA ?? "").trim(),
    String(row.DTLAD_BRKDN ?? "").trim(),
    String(row.ADRES_BRKDN ?? "").trim(),
  ].filter(Boolean);
  return parts.join(" ");
}

export function pickByCode(
  rows: Record<string, unknown>[],
  schoolCode: string,
): Record<string, unknown> | null {
  const code = schoolCode.trim();
  if (!code) return null;
  for (const row of rows) {
    const c = String(row.SCHUL_CODE ?? row.SD_SCHUL_CODE ?? "").trim();
    if (c === code) return row;
  }
  return null;
}

/**
 * Verified multi-field match — never name-only permanent identity.
 * Requires: exact name + address needle + region list already scoped by kind.
 */
export function pickByVerifiedFields(
  rows: Record<string, unknown>[],
  opts: {
    name: string;
    addressNeedle: string;
  },
): Record<string, unknown> | null {
  const targetName = normName(opts.name);
  const needle = normAddress(opts.addressNeedle);
  if (!targetName || !needle) return null;

  const hits = rows.filter((row) => {
    if (normName(String(row.SCHUL_NM ?? "")) !== targetName) return false;
    const addr = normAddress(schoolInfoAddressOf(row));
    return addr.includes(needle);
  });

  return hits.length === 1 ? hits[0]! : null;
}

/** @deprecated Do not use as permanent identity — kept for non-identity utilities only. */
export function pickByName(
  rows: Record<string, unknown>[],
  name: string,
): Record<string, unknown> | null {
  const target = normName(name);
  if (!target) return null;
  const hits = rows.filter((r) => normName(String(r.SCHUL_NM ?? "")) === target);
  return hits.length === 1 ? hits[0]! : null;
}

export function codeOf(row: Record<string, unknown> | null): string | null {
  if (!row) return null;
  const c = String(row.SCHUL_CODE ?? row.SD_SCHUL_CODE ?? "").trim();
  return c || null;
}

export function findKnownLink(
  appSchoolId: string,
): NeisSchoolInfoLink | undefined {
  const id = appSchoolId.trim();
  return NEIS_TO_SCHOOLINFO_LINKS.find((l) => l.neisSdSchulCode === id);
}

/**
 * Resolve app school id (usually NEIS SD_SCHUL_CODE) → SchoolInfo SCHUL_CODE.
 * Order: same official code → known source-link → verified fields. Never name-only.
 */
export function resolveSchoolInfoCode(opts: {
  appSchoolId: string;
  rows: Record<string, unknown>[];
  nameHint?: string | null;
  addressHint?: string | null;
  kind?: Kind;
}): ResolveResult {
  const appSchoolId = opts.appSchoolId.trim();
  const empty: ResolveResult = {
    appSchoolId,
    schoolInfoCode: null,
    method: "unresolved",
    row: null,
  };
  if (!appSchoolId) return empty;

  // CASE A path: identifiers already share the same official code string.
  const same = pickByCode(opts.rows, appSchoolId);
  if (same) {
    return {
      appSchoolId,
      schoolInfoCode: codeOf(same),
      method: "same_code",
      row: same,
    };
  }

  // CASE B: known NEIS → SchoolInfo link, then verify against list row.
  const link = findKnownLink(appSchoolId);
  if (link) {
    if (opts.kind && opts.kind !== link.kind) {
      return empty;
    }
    const byLinkCode = pickByCode(opts.rows, link.schoolInfoSchulCode);
    const verified =
      byLinkCode &&
      normName(String(byLinkCode.SCHUL_NM ?? "")) === normName(link.name) &&
      normAddress(schoolInfoAddressOf(byLinkCode)).includes(
        normAddress(link.addressNeedle),
      )
        ? byLinkCode
        : pickByVerifiedFields(opts.rows, {
            name: link.name,
            addressNeedle: link.addressNeedle,
          });

    if (verified && codeOf(verified) === link.schoolInfoSchulCode) {
      return {
        appSchoolId,
        schoolInfoCode: link.schoolInfoSchulCode,
        method: "known_link",
        row: verified,
      };
    }
    return empty;
  }

  // Ad-hoc verified fields when both name + address hints exist (still not name-only).
  const name = opts.nameHint?.trim();
  const address = opts.addressHint?.trim();
  if (name && address) {
    const verified = pickByVerifiedFields(opts.rows, {
      name,
      addressNeedle: address,
    });
    const code = codeOf(verified);
    if (verified && code) {
      return {
        appSchoolId,
        schoolInfoCode: code,
        method: "verified_fields",
        row: verified,
      };
    }
  }

  return empty;
}
