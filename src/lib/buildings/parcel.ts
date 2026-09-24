import type { ParcelRef } from "./types";

/** Building-hub platGbCd: 0 대지, 1 산. Cadastral PNU uses 1 대지, 2 산. */
export function parseJibun(jibun: string): { platGbCd: string; bun: string; ji: string } | null {
  const raw = (jibun ?? "").trim();
  if (!raw) return null;
  const mountain = raw.startsWith("산");
  const body = raw.replace(/^산\s*/, "").trim();
  if (!/^\d+(?:-\d+)?$/.test(body)) return null;
  const [a, b] = body.split("-");
  const bun = Number(a);
  const ji = Number(b || 0);
  if (!Number.isInteger(bun) || !Number.isInteger(ji) || bun < 0 || ji < 0 || bun > 9999 || ji > 9999) {
    return null;
  }
  return {
    platGbCd: mountain ? "1" : "0",
    bun: String(bun).padStart(4, "0"),
    ji: String(ji).padStart(4, "0"),
  };
}

export function parcelFromParts(
  lawdCd: string,
  bjdongCd: string,
  jibun: string,
): ParcelRef | null {
  if (!/^\d{5}$/.test(lawdCd) || !/^\d{5}$/.test(bjdongCd)) return null;
  const parsed = parseJibun(jibun);
  if (!parsed) return null;
  return {
    sigunguCd: lawdCd,
    bjdongCd,
    platGbCd: parsed.platGbCd,
    bun: parsed.bun,
    ji: parsed.ji,
  };
}

export function parcelFromCadastralPnu(pnu: string): ParcelRef | null {
  const raw = (pnu ?? "").trim();
  if (!/^\d{19}$/.test(raw)) return null;
  const plat = raw.slice(10, 11);
  const hubPlat = plat === "1" ? "0" : plat === "2" ? "1" : null;
  if (!hubPlat) return null;
  return {
    sigunguCd: raw.slice(0, 5),
    bjdongCd: raw.slice(5, 10),
    platGbCd: hubPlat,
    bun: raw.slice(11, 15),
    ji: raw.slice(15, 19),
  };
}

export function parcelFromHubPnu(pnu: string): ParcelRef | null {
  const raw = (pnu ?? "").trim();
  if (!/^\d{19}$/.test(raw)) return null;
  return {
    sigunguCd: raw.slice(0, 5),
    bjdongCd: raw.slice(5, 10),
    platGbCd: raw.slice(10, 11),
    bun: raw.slice(11, 15),
    ji: raw.slice(15, 19),
  };
}

export function hubPnu(parcel: ParcelRef): string {
  return `${parcel.sigunguCd}${parcel.bjdongCd}${parcel.platGbCd}${parcel.bun}${parcel.ji}`;
}

export function cadastralPnu(parcel: ParcelRef): string {
  const plat = parcel.platGbCd === "1" ? "2" : "1";
  return `${parcel.sigunguCd}${parcel.bjdongCd}${plat}${parcel.bun}${parcel.ji}`;
}

export function parcelKey(parcel: ParcelRef): string {
  return `${parcel.sigunguCd}|${parcel.bjdongCd}|${parcel.platGbCd}|${parcel.bun}|${parcel.ji}`;
}

export function priorityForSido(sidoCode: string | null | undefined): number {
  const prefix = (sidoCode ?? "").slice(0, 2);
  if (prefix === "11") return 0; // Seoul
  if (prefix === "41") return 1; // Gyeonggi
  if (["28", "26", "27", "30", "12", "29", "31"].includes(prefix)) return 2;
  return 3;
}

export function sidoBucket(sido: string | null, sidoCode: string | null): string {
  const name = (sido ?? "").trim();
  const code = (sidoCode ?? "").slice(0, 2);
  if (code === "11" || name.startsWith("서울")) return "SEOUL";
  if (code === "41" || name.startsWith("경기")) return "GYEONGGI";
  if (code === "28" || name.startsWith("인천")) return "INCHEON";
  if (code === "26" || name.startsWith("부산")) return "BUSAN";
  if (code === "27" || name.startsWith("대구")) return "DAEGU";
  if (code === "30" || name.startsWith("대전")) return "DAEJEON";
  if (code === "12" || code === "29" || name.includes("광주")) return "GWANGJU";
  if (code === "31" || name.startsWith("울산")) return "ULSAN";
  return "OTHER";
}
