/**
 * Deterministic Korean parcel identity (PNU-compatible) from Apartment Master.
 *
 * PNU (19 digits) = BJDONG(10) + LAND(1) + BUN(4) + JI(4)
 * LAND: 1 = 일반(대지), 2 = 산
 *
 * Never uses apt_name as the primary join key.
 */

export type ParcelKeyClass =
  | "PARCEL-KEY-READY"
  | "PARCEL-KEY-AMBIGUOUS"
  | "PARCEL-KEY-INVALID";

export type ParcelKeyParts = {
  bjdongCd10: string;
  landType: "1" | "2";
  bun: number;
  ji: number;
  pnu: string;
  jibunNorm: string;
};

export type ParcelKeyResult = {
  class: ParcelKeyClass;
  reasonCode: string | null;
  parts: ParcelKeyParts | null;
};

const JIBUN_RE = /^(산)?\s*(\d+)(?:\s*-\s*(\d+))?$/;

export function buildBjdongCd10(
  lawdCd: string | null | undefined,
  bjdongCd: string | null | undefined,
): string | null {
  const a = String(lawdCd ?? "").trim();
  const b = String(bjdongCd ?? "").trim();
  if (!/^\d{5}$/.test(a) || !/^\d{5}$/.test(b)) return null;
  return a + b;
}

export function parseJibun(jibun: string | null | undefined): {
  ok: boolean;
  san: boolean;
  bun: number;
  ji: number;
  reasonCode?: string;
} {
  const raw = String(jibun ?? "").trim();
  if (!raw) return { ok: false, san: false, bun: 0, ji: 0, reasonCode: "EMPTY_JIBUN" };
  const m = raw.match(JIBUN_RE);
  if (!m) return { ok: false, san: false, bun: 0, ji: 0, reasonCode: "MALFORMED_JIBUN" };
  const san = Boolean(m[1]);
  const bun = Number(m[2]);
  const ji = m[3] != null ? Number(m[3]) : 0;
  if (!Number.isInteger(bun) || bun < 0 || bun > 9999) {
    return { ok: false, san, bun, ji, reasonCode: "BUN_OUT_OF_RANGE" };
  }
  if (!Number.isInteger(ji) || ji < 0 || ji > 9999) {
    return { ok: false, san, bun, ji, reasonCode: "JI_OUT_OF_RANGE" };
  }
  return { ok: true, san, bun, ji };
}

/** Build 19-digit PNU used by MOLIT GIS건물통합정보 / continuous cadastre. */
export function buildPnu(parts: {
  bjdongCd10: string;
  landType: "1" | "2";
  bun: number;
  ji: number;
}): string {
  return (
    parts.bjdongCd10 +
    parts.landType +
    String(parts.bun).padStart(4, "0") +
    String(parts.ji).padStart(4, "0")
  );
}

export function classifyParcelKey(row: {
  lawdCd?: string | null;
  bjdongCd?: string | null;
  jibun?: string | null;
}): ParcelKeyResult {
  const bjdongCd10 = buildBjdongCd10(row.lawdCd, row.bjdongCd);
  if (!bjdongCd10) {
    return {
      class: "PARCEL-KEY-INVALID",
      reasonCode: "MISSING_ADMIN_CODES",
      parts: null,
    };
  }
  const parsed = parseJibun(row.jibun);
  if (!parsed.ok) {
    const cls =
      parsed.reasonCode === "MALFORMED_JIBUN"
        ? "PARCEL-KEY-AMBIGUOUS"
        : "PARCEL-KEY-INVALID";
    return { class: cls, reasonCode: parsed.reasonCode ?? "JIBUN_INVALID", parts: null };
  }
  const landType: "1" | "2" = parsed.san ? "2" : "1";
  const pnu = buildPnu({
    bjdongCd10,
    landType,
    bun: parsed.bun,
    ji: parsed.ji,
  });
  if (!/^\d{19}$/.test(pnu)) {
    return {
      class: "PARCEL-KEY-INVALID",
      reasonCode: "PNU_BUILD_FAILED",
      parts: null,
    };
  }
  return {
    class: "PARCEL-KEY-READY",
    reasonCode: null,
    parts: {
      bjdongCd10,
      landType,
      bun: parsed.bun,
      ji: parsed.ji,
      pnu,
      jibunNorm: `${parsed.san ? "산" : ""}${parsed.bun}${
        parsed.ji ? `-${parsed.ji}` : ""
      }`,
    },
  };
}
