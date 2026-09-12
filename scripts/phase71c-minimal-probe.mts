#!/usr/bin/env npx tsx
/**
 * Phase 7.1c — minimal live probe of CURRENT portal-documented endpoints.
 * Never prints the API key.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "data/poc/phase71c");
mkdirSync(OUT, { recursive: true });

const raw = process.env.MOLIT_API_KEY?.trim();
if (!raw) throw new Error("MOLIT_API_KEY missing");
const key = raw.includes("%") ? raw : encodeURIComponent(raw);

const KAPT = "A13822004"; // 잠실엘스
const SEARCH_DATE = "202401"; // YYYYMM

type Probe = {
  label: string;
  product: string;
  path: string;
  classification_note?: string;
  http_status: number | null;
  resultCode: string | null;
  resultMsg: string | null;
  errMsg: string | null;
  returnAuthMsg: string | null;
  returnReasonCode: string | null;
  ok: boolean;
  body_prefix: string;
  item_keys?: string[];
};

function parse(text: string) {
  // XML gateway errors
  const errMsg = text.match(/<errMsg>([^<]*)<\/errMsg>/)?.[1]
    ?? text.match(/"errMsg"\s*:\s*"([^"]+)"/)?.[1]
    ?? null;
  const returnAuthMsg = text.match(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/)?.[1]
    ?? text.match(/"returnAuthMsg"\s*:\s*"([^"]+)"/)?.[1]
    ?? null;
  const returnReasonCode = text.match(/<returnReasonCode>([^<]*)<\/returnReasonCode>/)?.[1]
    ?? text.match(/"returnReasonCode"\s*:\s*"([^"]+)"/)?.[1]
    ?? null;
  const resultCode = text.match(/<resultCode>([^<]*)<\/resultCode>/)?.[1]
    ?? text.match(/"resultCode"\s*:\s*"([^"]+)"/)?.[1]
    ?? null;
  const resultMsg = text.match(/<resultMsg>([^<]*)<\/resultMsg>/)?.[1]
    ?? text.match(/"resultMsg"\s*:\s*"([^"]+)"/)?.[1]
    ?? null;
  return { errMsg, returnAuthMsg, returnReasonCode, resultCode, resultMsg };
}

function itemKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/<([a-zA-Z][a-zA-Z0-9_]*)>/g)) {
    const t = m[1];
    if (!["response", "header", "body", "items", "item", "cmmMsgHeader"].includes(t)) {
      keys.add(t);
    }
  }
  // JSON item keys
  const jsonItem = text.match(/"item"\s*:\s*\{([^}]{0,2000})\}/);
  if (jsonItem) {
    for (const m of jsonItem[1].matchAll(/"([a-zA-Z][a-zA-Z0-9_]*)"\s*:/g)) keys.add(m[1]);
  }
  return [...keys].sort();
}

async function hit(
  label: string,
  product: string,
  path: string,
  qs: Record<string, string>,
  note?: string,
): Promise<Probe> {
  const params = new URLSearchParams(qs);
  // serviceKey already encoded — append manually to avoid double-encoding
  const url = `https://apis.data.go.kr${path}?serviceKey=${key}&${params.toString()}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/xml, application/json, */*", "User-Agent": "ziplab-phase71c" },
      signal: AbortSignal.timeout(25000),
      redirect: "follow",
    });
    const text = await res.text();
    const p = parse(text);
    const ok =
      res.ok &&
      !p.errMsg &&
      (p.resultCode === "00" || p.resultCode === "000" || p.resultCode === "0" ||
        text.includes("<item>") || text.includes('"item"'));
    return {
      label,
      product,
      path,
      classification_note: note,
      http_status: res.status,
      ...p,
      ok,
      body_prefix: text.slice(0, 320).replace(/\s+/g, " "),
      item_keys: ok ? itemKeys(text) : undefined,
    };
  } catch (e) {
    return {
      label,
      product,
      path,
      classification_note: note,
      http_status: null,
      resultCode: null,
      resultMsg: null,
      errMsg: String(e),
      returnAuthMsg: null,
      returnReasonCode: null,
      ok: false,
      body_prefix: "",
    };
  }
}

async function main() {
  const results: Probe[] = [];

  // --- CURRENT portal contracts (from data.go.kr product pages) ---
  results.push(await hit(
    "COMMON_V3_cleaning",
    "국토교통부_공동주택관리비(공용관리비)정보제공서비스",
    "/1613000/AptCmnuseManageCostServiceV3/getHsmpCleaningCostInfoV3",
    { kaptCode: KAPT, searchDate: SEARCH_DATE },
    "CURRENT portal base AptCmnuseManageCostServiceV3",
  ));

  results.push(await hit(
    "INDIV_V3_electricity",
    "국토교통부_공동주택관리비(개별사용료)정보제공서비스",
    "/1613000/AptIndvdlzManageCostServiceV3/getHsmpElectricityCostInfoV3",
    { kaptCode: KAPT, searchDate: SEARCH_DATE },
    "CURRENT portal base AptIndvdlzManageCostServiceV3",
  ));

  results.push(await hit(
    "RESERVE_V3_monthFee",
    "국토교통부_공동주택관리비(장기수선충당금)정보서비스",
    "/1613000/AptRepairsCostServiceV3/getHsmpMonthFeeInfoV3",
    { kaptCode: KAPT, searchDate: SEARCH_DATE },
    "CURRENT portal base AptRepairsCostServiceV3",
  ));

  results.push(await hit(
    "BASIC_V5",
    "국토교통부_공동주택 기본 정보제공 서비스",
    "/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5",
    { kaptCode: KAPT },
    "CURRENT portal base AptBasisInfoServiceV5",
  ));

  results.push(await hit(
    "LIST_V4_sido",
    "국토교통부_공동주택 단지 목록제공 서비스",
    "/1613000/AptListService4/getSidoAptList4",
    { sidoCode: "11", pageNo: "1", numOfRows: "1" },
    "CURRENT portal base AptListService4",
  ));

  // Control: known-working same key
  results.push(await hit(
    "CONTROL_BUILDING_HUB",
    "건축물대장 표제부",
    "/1613000/BldRgstHubService/getBrTitleInfo",
    {
      sigunguCd: "11710",
      bjdongCd: "10800",
      platGbCd: "0",
      bun: "0010",
      ji: "0000",
      numOfRows: "1",
      pageNo: "1",
    },
  ));

  // Contrast: OLD wrong endpoints from Phase 7.1b (1 each) to classify mismatch
  results.push(await hit(
    "OLD_COMMON_V2",
    "PREVIOUS wrong common endpoint",
    "/1613000/AptCmnuseManageCostServiceV2/getHsmpCleaningCostInfoV2",
    { kaptCode: KAPT, searchDate: SEARCH_DATE },
    "Phase7.1b guessed V2 path — expect mismatch vs portal V3",
  ));

  results.push(await hit(
    "OLD_BASIC_V1",
    "PREVIOUS wrong basic endpoint",
    "/1613000/AptBasisInfoService1/getAphusBassInfo",
    { kaptCode: KAPT },
    "Phase7.1b used AptBasisInfoService1 — portal now V5",
  ));

  // Identity (odcloud) — separate product/host
  const idUrl =
    `https://api.odcloud.kr/api/AptIdInfoSvc/v1/getAptInfo?page=1&perPage=1&serviceKey=${key}`;
  try {
    const res = await fetch(idUrl, {
      headers: { Accept: "application/json", "User-Agent": "ziplab-phase71c" },
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    results.push({
      label: "IDENTITY_ODCLOUD",
      product: "한국부동산원_공동주택 단지 식별정보 조회 서비스",
      path: "/api/AptIdInfoSvc/v1/getAptInfo",
      classification_note: "CURRENT odcloud host api.odcloud.kr (not apis.data.go.kr/1613000)",
      http_status: res.status,
      resultCode: text.match(/"code"\s*:\s*"?([^",}]+)/)?.[1] ?? null,
      resultMsg: text.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? null,
      errMsg: text.includes("SERVICE_KEY") ? "KEY_OR_AUTH" : null,
      returnAuthMsg: null,
      returnReasonCode: null,
      ok: res.ok && (text.includes('"data"') || text.includes('"currentCount"')),
      body_prefix: text.slice(0, 320).replace(/\s+/g, " "),
    });
  } catch (e) {
    results.push({
      label: "IDENTITY_ODCLOUD",
      product: "한국부동산원_공동주택 단지 식별정보 조회 서비스",
      path: "/api/AptIdInfoSvc/v1/getAptInfo",
      http_status: null,
      resultCode: null,
      resultMsg: null,
      errMsg: String(e),
      returnAuthMsg: null,
      returnReasonCode: null,
      ok: false,
      body_prefix: "",
    });
  }

  const report = {
    phase: "7.1c-minimal-probe",
    kaptCode: KAPT,
    searchDate: SEARCH_DATE,
    request_count: results.length,
    results,
    summary: results.map((r) => ({
      label: r.label,
      ok: r.ok,
      http_status: r.http_status,
      resultCode: r.resultCode,
      resultMsg: r.resultMsg,
      errMsg: r.errMsg,
      returnAuthMsg: r.returnAuthMsg,
      returnReasonCode: r.returnReasonCode,
      path: r.path,
      item_keys: r.item_keys,
    })),
  };

  writeFileSync(join(OUT, "minimal-probe.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
