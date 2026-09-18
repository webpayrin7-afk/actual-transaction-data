/**
 * Parse one portal fee response into the minimum fields the canonical model needs.
 * Does not keep the raw body.
 */
import type { OpState } from "./types";

export class RateLimitStop extends Error {
  constructor(message = "HTTP 429") {
    super(message);
    this.name = "RateLimitStop";
  }
}

export class SchemaStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaStop";
  }
}

export class MappingStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingStop";
  }
}

export type ParsedOp = {
  state: OpState;
  http: number;
  result_class: string;
  amount: number | null;
  numeric_fields: string[];
  explicit_zero_fields: string[];
  echoed_kapt: string | null;
  error: string | null;
};

const SUCCESS_CODES = new Set(["00", "000", "0", "0000"]);
const EMPTY_CODES = new Set(["03", "3"]);

export function scrub(text: string): string {
  return text
    .replace(/serviceKey=[^&\s"']+/gi, "serviceKey=REDACTED")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

function asRec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isExplicitNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

export function sumExplicitAmounts(item: Record<string, unknown> | null): {
  amount: number | null;
  numeric_fields: string[];
  explicit_zero_fields: string[];
} {
  if (!item) {
    return { amount: null, numeric_fields: [], explicit_zero_fields: [] };
  }
  let sum = 0;
  let any = false;
  const numeric_fields: string[] = [];
  const explicit_zero_fields: string[] = [];
  for (const [key, value] of Object.entries(item)) {
    if (key === "kaptCode" || /date|name|code/i.test(key)) continue;
    const n = isExplicitNumber(value);
    if (n == null) continue;
    any = true;
    numeric_fields.push(key);
    if (n === 0) explicit_zero_fields.push(key);
    sum += n;
  }
  return {
    amount: any ? sum : null,
    numeric_fields,
    explicit_zero_fields,
  };
}

function quotaText(value: string): boolean {
  return /429|too many requests|limited_number_of_service_requests|트래픽/i.test(value);
}

export function parseFeeResponse(args: {
  http: number;
  body: string;
  expectedKapt: string;
}): ParsedOp {
  if (args.http === 429 || quotaText(args.body.slice(0, 500))) {
    throw new RateLimitStop(args.http === 429 ? "HTTP 429" : "quota stop");
  }

  const trimmed = args.body.trim();
  const base = {
    http: args.http,
    numeric_fields: [] as string[],
    explicit_zero_fields: [] as string[],
    echoed_kapt: null as string | null,
    amount: null as number | null,
  };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new SchemaStop("non-json object prefix");
    }
    const root = asRec(json);
    if (!root) throw new SchemaStop("json root is not an object");

    const openApi = asRec(root.OpenAPI_ServiceResponse);
    if (openApi) {
      const header = asRec(openApi.cmmMsgHeader);
      const reason = String(header?.returnReasonCode ?? "");
      const msg = String(header?.returnAuthMsg ?? header?.errMsg ?? "");
      if (quotaText(`${reason} ${msg}`)) throw new RateLimitStop("quota stop");
      return {
        ...base,
        state: "failed",
        result_class: `openapi_${reason || "error"}`,
        error: scrub(msg || reason || "openapi error"),
      };
    }

    if (!asRec(root.response) && root.header == null && root.body == null) {
      throw new SchemaStop("missing response envelope");
    }
    const response = asRec(root.response) ?? root;
    const header = asRec(response.header);
    const body = asRec(response.body);
    if (!header) throw new SchemaStop("missing response.header");
    const resultCode = header.resultCode == null ? null : String(header.resultCode);
    const resultMsg = header.resultMsg == null ? "" : String(header.resultMsg);
    if (quotaText(`${resultCode ?? ""} ${resultMsg}`)) {
      throw new RateLimitStop("quota stop");
    }
    const item = asRec(body?.item) ?? null;
    const echoed = item?.kaptCode == null ? null : String(item.kaptCode);
    if (echoed && echoed !== args.expectedKapt) {
      throw new MappingStop(`kapt echo ${echoed} != ${args.expectedKapt}`);
    }
    const summed = sumExplicitAmounts(item);
    if (resultCode && SUCCESS_CODES.has(resultCode) && summed.amount != null) {
      return {
        ...base,
        ...summed,
        state: "success",
        result_class: `ok_${resultCode}`,
        echoed_kapt: echoed,
        error: null,
      };
    }
    if (
      !item ||
      summed.amount == null ||
      (resultCode != null && EMPTY_CODES.has(resultCode))
    ) {
      return {
        ...base,
        state: "missing",
        result_class: resultCode ? `empty_${resultCode}` : "empty",
        echoed_kapt: echoed,
        error: null,
      };
    }
    if (resultCode && !SUCCESS_CODES.has(resultCode)) {
      return {
        ...base,
        state: "failed",
        result_class: `result_${resultCode}`,
        echoed_kapt: echoed,
        error: scrub(resultMsg || resultCode),
      };
    }
    return {
      ...base,
      state: "missing",
      result_class: "empty",
      echoed_kapt: echoed,
      error: null,
    };
  }

  if (trimmed.startsWith("<")) {
    const resultCode = trimmed.match(/<resultCode>([^<]*)<\/resultCode>/)?.[1] ?? null;
    const resultMsg = trimmed.match(/<resultMsg>([^<]*)<\/resultMsg>/)?.[1] ?? "";
    if (quotaText(`${resultCode ?? ""} ${resultMsg}`)) throw new RateLimitStop("quota stop");
    if (!resultCode && !trimmed.includes("<item>")) {
      throw new SchemaStop("xml without resultCode");
    }
    const kapt = trimmed.match(/<kaptCode>([^<]*)<\/kaptCode>/)?.[1] ?? null;
    if (kapt && kapt !== args.expectedKapt) {
      throw new MappingStop(`kapt echo ${kapt} != ${args.expectedKapt}`);
    }
    const item: Record<string, unknown> = {};
    const tagRe = /<([a-zA-Z0-9_]+)>([^<]*)<\/\1>/g;
    let tag: RegExpExecArray | null;
    while ((tag = tagRe.exec(trimmed))) item[tag[1]!] = tag[2]!;
    const summed = sumExplicitAmounts(item);
    if (resultCode && SUCCESS_CODES.has(resultCode) && summed.amount != null) {
      return {
        ...base,
        ...summed,
        state: "success",
        result_class: `ok_${resultCode}`,
        echoed_kapt: kapt,
        error: null,
      };
    }
    if (!summed.amount || (resultCode && EMPTY_CODES.has(resultCode))) {
      return {
        ...base,
        state: "missing",
        result_class: resultCode ? `empty_${resultCode}` : "empty",
        echoed_kapt: kapt,
        error: null,
      };
    }
    return {
      ...base,
      state: "failed",
      result_class: `result_${resultCode ?? "xml"}`,
      error: scrub(resultMsg),
      echoed_kapt: kapt,
    };
  }

  throw new SchemaStop(`unexpected payload http ${args.http}`);
}
