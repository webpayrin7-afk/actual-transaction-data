#!/usr/bin/env npx tsx
/** Minimal path-variant probes. Masked. Distinguishes wrong-endpoint vs not-activated. */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "data/poc/phase71b");
mkdirSync(OUT, { recursive: true });

const raw = process.env.MOLIT_API_KEY?.trim();
if (!raw) throw new Error("MOLIT_API_KEY missing");
const key = raw.includes("%") ? raw : encodeURIComponent(raw);
const kaptCode = "A13822004";

function parse(text: string) {
  return {
    errMsg: text.match(/<errMsg>([^<]*)<\/errMsg>/)?.[1] ?? null,
    returnAuthMsg: text.match(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/)?.[1] ?? null,
    returnReasonCode: text.match(/<returnReasonCode>([^<]*)<\/returnReasonCode>/)?.[1] ?? null,
    resultCode: text.match(/<resultCode>([^<]*)<\/resultCode>/)?.[1] ?? null,
    resultMsg: text.match(/<resultMsg>([^<]*)<\/resultMsg>/)?.[1] ?? null,
  };
}

async function hit(label: string, url: string) {
  const res = await fetch(url, {
    headers: { "User-Agent": "ziplab-71b" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  const text = await res.text();
  const p = parse(text);
  return {
    label,
    status: res.status,
    path: new URL(url).pathname,
    host: new URL(url).host,
    ...p,
    body_prefix: text.slice(0, 200).replace(/\s+/g, " "),
  };
}

async function main() {
  const variants: Array<[string, string]> = [
    [
      "basic_1613000_getAphusBassInfo",
      `https://apis.data.go.kr/1613000/AptBasisInfoService1/getAphusBassInfo?serviceKey=${key}&kaptCode=${kaptCode}`,
    ],
    [
      "basic_1611000_legacy",
      `https://apis.data.go.kr/1611000/AptBasisInfoService/getAphusBassInfo?serviceKey=${key}&kaptCode=${kaptCode}`,
    ],
    [
      "basic_http_1613000",
      `http://apis.data.go.kr/1613000/AptBasisInfoService1/getAphusBassInfo?serviceKey=${key}&kaptCode=${kaptCode}`,
    ],
    [
      "list_getTotalAptList",
      `https://apis.data.go.kr/1613000/AptListService2/getTotalAptList?serviceKey=${key}&pageNo=1&numOfRows=1`,
    ],
    [
      "list_1611000_legacy_getSidoAptList",
      `https://apis.data.go.kr/1611000/AptListService/getSidoAptList?serviceKey=${key}&sidoCode=11&pageNo=1&numOfRows=1`,
    ],
    [
      "common_AptCmnuseManageCostService",
      `https://apis.data.go.kr/1613000/AptCmnuseManageCostService/getHsmpCleaningCostInfo?serviceKey=${key}&kaptCode=${kaptCode}&searchDate=202401`,
    ],
    [
      "indiv_AptIndivUseFeeService",
      `https://apis.data.go.kr/1613000/AptIndivUseFeeService/getHsmpElectricityCostInfo?serviceKey=${key}&kaptCode=${kaptCode}&searchDate=202401`,
    ],
    [
      "reserve_monthRetal_V2",
      `https://apis.data.go.kr/1613000/AptRepairsCostServiceV2/getHsmpMonthRetalFeeInfoV2?serviceKey=${key}&kaptCode=${kaptCode}&searchDate=202401`,
    ],
    [
      "energy_V2_related_family",
      `https://apis.data.go.kr/1613000/ApHusEnergyUseInfoOfferServiceV2/getHsmpApHusUsgQtyInfoSearchV2?serviceKey=${key}&kaptCode=${kaptCode}&reqDate=202401`,
    ],
  ];

  const results = [];
  for (const [label, url] of variants) {
    results.push(await hit(label, url));
  }

  writeFileSync(join(OUT, "api-path-variants.json"), JSON.stringify({ results }, null, 2));
  console.log(JSON.stringify({ request_count: results.length, results }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
