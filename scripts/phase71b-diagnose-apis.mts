#!/usr/bin/env npx tsx
/**
 * Phase 7.1b — minimal masked diagnosis of blocked OpenAPI sources.
 * Never prints the API key.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "data/poc/phase71b");
mkdirSync(OUT, { recursive: true });

function maskKey(raw: string) {
  const decoded = raw.includes("%") ? decodeURIComponent(raw) : raw;
  return {
    raw_len: raw.length,
    decoded_len: decoded.length,
    looks_encoded: raw.includes("%"),
    prefix: decoded.slice(0, 4),
    suffix: decoded.slice(-4),
  };
}

function extractOpenApiError(text: string) {
  const errMsg = text.match(/<errMsg>([^<]*)<\/errMsg>/)?.[1] ?? null;
  const returnAuthMsg =
    text.match(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/)?.[1] ?? null;
  const returnReasonCode =
    text.match(/<returnReasonCode>([^<]*)<\/returnReasonCode>/)?.[1] ?? null;
  const resultCode =
    text.match(/<resultCode>([^<]*)<\/resultCode>/)?.[1] ??
    text.match(/<resultcode>([^<]*)<\/resultcode>/i)?.[1] ??
    null;
  const resultMsg =
    text.match(/<resultMsg>([^<]*)<\/resultMsg>/)?.[1] ??
    text.match(/<resultmsg>([^<]*)<\/resultmsg>/i)?.[1] ??
    null;
  return { errMsg, returnAuthMsg, returnReasonCode, resultCode, resultMsg };
}

async function probe(
  label: string,
  urlBuilder: (serviceKeyForQuery: string) => string,
  serviceKeyForQuery: string,
) {
  const url = urlBuilder(serviceKeyForQuery);
  const loggedUrl = url.replaceAll(serviceKeyForQuery, "***MASKED***");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "ziplab-phase71b-diag",
        Accept: "application/xml, text/xml, */*",
      },
      signal: ac.signal,
      redirect: "follow",
    });
    const text = await res.text();
    const err = extractOpenApiError(text);
    const ok_like =
      res.ok &&
      !err.errMsg &&
      (err.resultCode === "00" ||
        err.resultCode === "000" ||
        err.resultCode === "0" ||
        text.includes("<item>") ||
        text.includes("<items>"));
    return {
      label,
      http_status: res.status,
      url_logged: loggedUrl,
      host: new URL(url).host,
      path: new URL(url).pathname,
      body_prefix: text.slice(0, 280).replace(/\s+/g, " "),
      ...err,
      ok_like,
    };
  } catch (e) {
    return {
      label,
      http_status: null,
      url_logged: loggedUrl,
      error: String(e),
      ok_like: false,
    };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const raw = process.env.MOLIT_API_KEY?.trim();
  if (!raw) throw new Error("MOLIT_API_KEY missing");

  const envRouting = {
    MOLIT_API_KEY: "present",
    DATA_GO_KR_API_KEY: process.env.DATA_GO_KR_API_KEY ? "present" : "absent",
    KAPT_API_KEY: process.env.KAPT_API_KEY ? "present" : "absent",
    SERVICE_KEY: process.env.SERVICE_KEY ? "present" : "absent",
    key_meta: maskKey(raw),
  };

  // Match molit/client.ts: encode if not already encoded
  const encodedStyle = raw.includes("%") ? raw : encodeURIComponent(raw);
  const decodedStyle = raw.includes("%") ? decodeURIComponent(raw) : raw;

  // 잠실엘스 sample kapt from cohort
  const kaptCode = "A13822004";
  const searchDate = "202401";

  type Case = {
    label: string;
    product: string;
    keyMode: string;
    key: string;
    build: (k: string) => string;
  };

  const cases: Case[] = [
    {
      label: "CONTROL_BUILDING_HUB_getBrTitleInfo",
      product: "건축물대장 표제부 (BldRgstHubService/getBrTitleInfo)",
      keyMode: "urlsearchparams-decoded",
      key: decodedStyle,
      build: (k) => {
        const qs = new URLSearchParams({
          serviceKey: k,
          sigunguCd: "11710",
          bjdongCd: "10800",
          platGbCd: "0",
          bun: "0010",
          ji: "0000",
          numOfRows: "1",
          pageNo: "1",
        });
        return `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?${qs}`;
      },
    },
    {
      label: "CONTROL_RTMS_TRADE",
      product: "아파트매매 실거래상세 (RTMSDataSvcAptTrade)",
      keyMode: "manual-encoded",
      key: encodedStyle,
      build: (k) => {
        const params = new URLSearchParams({
          LAWD_CD: "11710",
          DEAL_YMD: "202401",
          pageNo: "1",
          numOfRows: "1",
        });
        return `https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade?serviceKey=${k}&${params}`;
      },
    },
    {
      label: "A_BASIC_getAphusBassInfo",
      product: "공동주택 기본정보 (AptBasisInfoService1/getAphusBassInfo)",
      keyMode: "urlsearchparams-decoded",
      key: decodedStyle,
      build: (k) => {
        const qs = new URLSearchParams({ serviceKey: k, kaptCode });
        return `https://apis.data.go.kr/1613000/AptBasisInfoService1/getAphusBassInfo?${qs}`;
      },
    },
    {
      label: "B_LIST_getSidoAptList",
      product: "공동주택 단지목록 (AptListService2/getSidoAptList)",
      keyMode: "urlsearchparams-decoded",
      key: decodedStyle,
      build: (k) => {
        const qs = new URLSearchParams({
          serviceKey: k,
          sidoCode: "11",
          pageNo: "1",
          numOfRows: "1",
        });
        return `https://apis.data.go.kr/1613000/AptListService2/getSidoAptList?${qs}`;
      },
    },
    {
      label: "C_IDENTITY_getAphusDtlInfo",
      product: "공동주택 단지 식별/상세 (AptBasisInfoService1/getAphusDtlInfo)",
      keyMode: "urlsearchparams-decoded",
      key: decodedStyle,
      build: (k) => {
        const qs = new URLSearchParams({ serviceKey: k, kaptCode });
        return `https://apis.data.go.kr/1613000/AptBasisInfoService1/getAphusDtlInfo?${qs}`;
      },
    },
    {
      label: "D_COMMON_getHsmpCleaningCostInfo",
      product: "공동주택관리비 공용관리비 (AptCmnuseManageCostService/getHsmpCleaningCostInfo)",
      keyMode: "urlsearchparams-decoded",
      key: decodedStyle,
      build: (k) => {
        const qs = new URLSearchParams({
          serviceKey: k,
          kaptCode,
          searchDate,
        });
        return `https://apis.data.go.kr/1613000/AptCmnuseManageCostService/getHsmpCleaningCostInfo?${qs}`;
      },
    },
    {
      label: "E_INDIV_getHsmpElectricityCostInfo",
      product: "공동주택관리비 개별사용료 (AptIndivUseCostService/getHsmpElectricityCostInfo)",
      keyMode: "urlsearchparams-decoded",
      key: decodedStyle,
      build: (k) => {
        const qs = new URLSearchParams({
          serviceKey: k,
          kaptCode,
          searchDate,
        });
        return `https://apis.data.go.kr/1613000/AptIndivUseCostService/getHsmpElectricityCostInfo?${qs}`;
      },
    },
    {
      label: "F_RESERVE_getHsmpMonthFeeInfoV2",
      product: "공동주택관리비 장기수선충당금 (AptRepairsCostServiceV2/getHsmpMonthFeeInfoV2)",
      keyMode: "urlsearchparams-decoded",
      key: decodedStyle,
      build: (k) => {
        const qs = new URLSearchParams({
          serviceKey: k,
          kaptCode,
          searchDate,
        });
        return `https://apis.data.go.kr/1613000/AptRepairsCostServiceV2/getHsmpMonthFeeInfoV2?${qs}`;
      },
    },
  ];

  const results: Record<string, unknown>[] = [];

  for (const c of cases) {
    const r = await probe(c.label, c.build, c.key);
    results.push({ ...r, product: c.product, keyMode: c.keyMode });
  }

  // One encoding alternate for basic info if blocked
  const basic = results.find((r) => r.label === "A_BASIC_getAphusBassInfo") as any;
  if (basic && !basic.ok_like) {
    const alt = await probe(
      "A_BASIC_encoding_alt_manualEncoded",
      (k) =>
        `https://apis.data.go.kr/1613000/AptBasisInfoService1/getAphusBassInfo?serviceKey=${k}&kaptCode=${kaptCode}`,
      encodedStyle,
    );
    results.push({
      ...alt,
      product: "공동주택 기본정보 (encoding alt)",
      keyMode: "manual-encoded",
    });
  }

  // One endpoint-name alternate if still NO_OPENAPI — older AptBasisInfoService (no "1")
  if (basic && basic.errMsg === "NO_OPENAPI_SERVICE_ERROR") {
    const alt2 = await probe(
      "A_BASIC_endpoint_alt_AptBasisInfoService",
      (k) => {
        const qs = new URLSearchParams({ serviceKey: k, kaptCode });
        return `https://apis.data.go.kr/1613000/AptBasisInfoService/getAphusBassInfo?${qs}`;
      },
      decodedStyle,
    );
    results.push({
      ...alt2,
      product: "공동주택 기본정보 (legacy service path)",
      keyMode: "urlsearchparams-decoded",
    });
  }

  const controlOk = results.filter(
    (r: any) => String(r.label).startsWith("CONTROL_") && r.ok_like,
  );
  const blockedPrimary = results.filter(
    (r: any) =>
      /^[A-F]_/.test(String(r.label)) &&
      !String(r.label).includes("_alt") &&
      !r.ok_like,
  );

  let root_cause = "UNKNOWN";
  const allNoOpen = blockedPrimary.every(
    (r: any) =>
      r.errMsg === "NO_OPENAPI_SERVICE_ERROR" ||
      String(r.returnAuthMsg || "").includes("오픈API"),
  );
  if (controlOk.length > 0 && allNoOpen) {
    root_cause = "SERVICE-NOT-ACTIVATED";
  } else if (controlOk.length === 0) {
    root_cause = "KEY-PROBLEM";
  }

  // Detect wrong-endpoint if encoding alt differs meaningfully
  const encodingAlt = results.find(
    (r) => r.label === "A_BASIC_encoding_alt_manualEncoded",
  ) as any;
  if (
    encodingAlt?.ok_like &&
    basic &&
    !basic.ok_like
  ) {
    root_cause = "KEY-PROBLEM"; // encoding mishandling
  }

  const report = {
    phase: "7.1b-api-diagnosis",
    envRouting,
    request_count: results.length,
    root_cause_hypothesis: root_cause,
    code_fixable: root_cause === "KEY-PROBLEM" ? "YES" : "NO",
    manual_action_required: root_cause === "SERVICE-NOT-ACTIVATED" ? "YES" : "NO",
    results,
  };

  writeFileSync(join(OUT, "api-diagnosis.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        envRouting,
        request_count: results.length,
        root_cause_hypothesis: root_cause,
        code_fixable: report.code_fixable,
        manual_action_required: report.manual_action_required,
        summary: results.map((r: any) => ({
          label: r.label,
          http_status: r.http_status,
          errMsg: r.errMsg,
          returnAuthMsg: r.returnAuthMsg,
          returnReasonCode: r.returnReasonCode,
          resultCode: r.resultCode,
          resultMsg: r.resultMsg,
          ok_like: r.ok_like,
          path: r.path,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
