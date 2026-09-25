/**
 * /api/apt-detail 응답의 items(거래 목록)를 무손실로 압축해 보내는 전송 형식.
 *
 * 대단지(헬리오시티 1.6만 건)는 거래마다 같은 키 이름·단지명·구·동·지번·준공연도를
 * 반복해 원본 JSON이 6MB를 넘는다. 여기서는 값을 버리거나 바꾸지 않고 모양만 바꾼다:
 * - 열(column) 단위로 담아 키 이름 반복을 없앤다
 * - 모든 거래가 같은 값(단지명·구·동 등)은 한 번만 보낸다
 * - 종류가 적은 값(거래일·면적·층·구분 등)은 사전(dict) + 번호로 보낸다
 * - id가 거래 값으로 다시 만들어지는 경우(parse.ts 규칙) id 문자열을 생략한다
 * 클라이언트는 unpackAptDetail로 원래 items를 키 순서까지 그대로 되살린다.
 * 모양이 예상과 다르면(키 집합이 거래마다 다르거나 객체 값이 섞임) 압축하지 않고 원본을 보낸다.
 *
 * 클라이언트 모듈에서 가져다 쓰므로 서버 전용 import 금지.
 */
import type { AptDetailResponse, AptHistoryItem } from "@/lib/molit/apt-client";

type Prim = string | number | boolean | null;

export interface PackedAptItems {
  /** 형식 버전 */
  f: 1;
  n: number;
  /** 원래 거래 객체의 키 순서 */
  keys: string[];
  /** 모든 거래가 같은 값 */
  consts: Record<string, Prim>;
  /** 거래별 값 */
  cols: Record<string, Prim[]>;
  /** 종류가 적은 값: values[idx[i]] */
  dicts: Record<string, { values: Prim[]; idx: number[] }>;
  /** id 복원용 법정동코드. ids 값의 뜻은 encodeId 참고 */
  idLawd?: string;
  ids?: (string | 0)[];
}

export type AptDetailWire = Omit<AptDetailResponse, "items"> & {
  items?: AptHistoryItem[];
  itemsPacked?: PackedAptItems;
};

function isPrim(v: unknown): v is Prim {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v))
  );
}

type IdSource = Record<string, unknown>;

/**
 * 거래 값으로 id 앞부분을 다시 만든다. 숫자가 유한수가 아니면 복원 불가(null).
 * - "a": src/lib/molit/parse.ts 규칙 (…-동-지번-층-금액-[월세-]면적)
 * - "b": 지번 없이 …-동-층-금액-[월세-]면적 (뒤에 "-번호"가 붙은 웨어하우스 id)
 * - "c": 규칙 a인데 매매도 월세(0) 자리가 있는 id
 */
type IdTemplate = "a" | "b" | "c";
const ID_TEMPLATES: readonly IdTemplate[] = ["a", "b", "c"];

function idBase(item: IdSource, lawdCd: string, template: IdTemplate): string | null {
  const nums = [item.floor, item.dealAmount, item.exclusiveArea];
  if (item.dealType === "rent") nums.push(item.monthlyRent);
  for (const v of nums) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
  }
  const { dealType, dealDate, aptName, dong, jibun } = item;
  for (const v of [dealDate, aptName, dong, jibun]) {
    if (typeof v !== "string") return null;
  }
  if (dealType !== "trade" && dealType !== "rent") return null;
  const head = `${dealType}-${lawdCd}-${dealDate}-${aptName}-${dong}-`;
  const place = template === "b" ? "" : `${jibun}-`;
  const rent =
    dealType === "rent" || template === "c" ? `${item.monthlyRent}-` : "";
  return `${head}${place}${item.floor}-${item.dealAmount}-${rent}${item.exclusiveArea}`;
}

/**
 * id 한 개의 전송 값: 0 = 규칙 a 그대로, "a…"/"b…"/"c…" = 규칙 앞부분 + 나머지 문자열,
 * "=…" = 원본 id 그대로.
 */
function encodeId(id: string, item: IdSource, lawdCd: string): string | 0 {
  if (lawdCd) {
    for (const template of ID_TEMPLATES) {
      const base = idBase(item, lawdCd, template);
      if (base == null || !id.startsWith(base)) continue;
      const rest = id.slice(base.length);
      if (template === "a" && rest === "") return 0;
      return `${template}${rest}`;
    }
  }
  return `=${id}`;
}

function decodeId(code: string | 0, item: IdSource, lawdCd: string): string | null {
  if (code === 0) return idBase(item, lawdCd, "a");
  const tag = code[0];
  if (tag === "a" || tag === "b" || tag === "c") {
    const base = idBase(item, lawdCd, tag);
    return base == null ? null : base + code.slice(1);
  }
  return code.slice(1);
}

/** JSON 배열로 보낼 때 대략의 바이트 수 */
function jsonBytes(values: Prim[]): number {
  let total = 0;
  for (const v of values) {
    total += (typeof v === "string" ? v.length * 3 + 2 : String(v).length) + 1;
  }
  return total;
}

function packItems(items: AptHistoryItem[]): PackedAptItems | null {
  const n = items.length;
  if (n === 0) return null;
  const rows = items as unknown as IdSource[];
  const keys = Object.keys(rows[0]);
  const keySig = keys.join("\u0000");
  for (const row of rows) {
    if (Object.keys(row).join("\u0000") !== keySig) return null;
  }

  const consts: Record<string, Prim> = {};
  const cols: Record<string, Prim[]> = {};
  const dicts: Record<string, { values: Prim[]; idx: number[] }> = {};
  const out: PackedAptItems = { f: 1, n, keys, consts, cols, dicts };

  for (const key of keys) {
    if (key === "id") continue;
    const col: Prim[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = rows[i][key];
      if (!isPrim(v)) return null;
      col[i] = v;
    }
    const first = col[0];
    if (col.every((v) => v === first)) {
      consts[key] = first;
      continue;
    }
    const index = new Map<Prim, number>();
    const values: Prim[] = [];
    for (const v of col) {
      if (!index.has(v)) {
        index.set(v, values.length);
        values.push(v);
      }
    }
    const dictBytes = jsonBytes(values) + n * (String(values.length).length + 1);
    if (dictBytes < jsonBytes(col)) {
      dicts[key] = { values, idx: col.map((v) => index.get(v)!) };
    } else {
      cols[key] = col;
    }
  }

  if (keys.includes("id")) {
    const firstId = rows[0].id;
    if (typeof firstId !== "string") return null;
    const lawd = firstId.split("-")[1] ?? "";
    const ids: (string | 0)[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const id = rows[i].id;
      if (typeof id !== "string") return null;
      ids[i] = encodeId(id, rows[i], lawd);
    }
    out.idLawd = lawd;
    out.ids = ids;
  }
  return out;
}

function unpackItems(p: PackedAptItems): AptHistoryItem[] {
  const items: AptHistoryItem[] = new Array(p.n);
  for (let i = 0; i < p.n; i++) {
    const row: IdSource = {};
    for (const key of p.keys) {
      if (key === "id") {
        row.id = null;
        continue;
      }
      if (key in p.consts) row[key] = p.consts[key];
      else if (key in p.dicts) row[key] = p.dicts[key].values[p.dicts[key].idx[i]];
      else row[key] = p.cols[key]?.[i] ?? null;
    }
    if (p.ids) {
      row.id = decodeId(p.ids[i], row, p.idLawd ?? "");
    }
    items[i] = row as unknown as AptHistoryItem;
  }
  return items;
}

/** 서버: items를 압축 형식으로 바꾼다. 압축할 수 없으면 원본 그대로. */
export function packAptDetail(detail: AptDetailResponse): AptDetailWire {
  const packed = packItems(detail.items);
  if (!packed) return detail;
  // 키 순서를 유지한 채 items 자리에 itemsPacked를 둔다
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (key === "items") out.itemsPacked = packed;
    else out[key] = value;
  }
  return out as AptDetailWire;
}

/** 클라이언트: 압축 형식이면 items를 되살린다. 예전 형식(items)은 그대로 통과. */
export function unpackAptDetail(wire: AptDetailWire): AptDetailResponse {
  if (!wire.itemsPacked) return wire as AptDetailResponse;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wire)) {
    if (key === "itemsPacked") out.items = unpackItems(wire.itemsPacked);
    else out[key] = value;
  }
  return out as unknown as AptDetailResponse;
}
