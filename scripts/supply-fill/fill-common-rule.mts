/**
 * 공급면적 = 전유 + 주거공용, 공용 행 이름(기타용도 etcPurps)을 명시 목록으로 나눠 계산한다.
 * extract/plan 은 DB 읽기만. apply-plan/apply 는 사용승인 2010년 이후 단지만 쓴다 (아래 fillCommon).
 *
 * 왜: 기존 규칙(official-expos.ts)은 호의 주건축물 공용 행 중 허용 목록(계단·복도·홀…)에 없는 이름이
 * 하나라도 있으면 그 호를 계산하지 않았다. 최근 단지는 지하주차장·관리실·경비실·전기실 같은
 * 기타공용을 호마다 주건축물 공용으로 올려서 ~3,100 단지가 NO_DERIVABLE 로 묶였다.
 *
 * 새 규칙 (면적·비율 기준 없음, 이름만):
 *   - 부속건축물 공용 → 제외 (기존과 같음).
 *   - 주건축물 공용 행의 이름을 토큰으로 나눠(쉼표·슬래시·'및' 등) 토큰마다 분류:
 *       INCLUDE (주거공용: 지상층 계단·복도·현관·홀·승강기·벽체·전실·코어 …) → 공급면적에 더함
 *       EXCLUDE (기타공용: 주택공급규칙 제21조 ⑤의 "지하층, 관리사무소, 노인정 등" + 주차장·기계/전기실·경비실·커뮤니티 …) → 뺌
 *       UNKNOWN (공용·아파트·기타·피트·옥탑 등 뜻이 갈리는 이름) → 그 호는 계산하지 않음
 *     한 행에 INCLUDE와 EXCLUDE 토큰이 섞이면 면적을 나눌 수 없으므로 UNKNOWN.
 *     이름이 빈 행은 기존처럼 주거공용 (단, 전유가 '공유면적' 표시된 호는 계산 안 함).
 *   - 주용도코드(mainPurpsCd)는 쓰지 않는다: 같은 '계단실'이 02001(아파트)·02005(부대시설) 둘 다로 올라와 구분이 안 됨.
 *   - 그 뒤 단계는 fill-notrade-local.mts 와 같다: 같은 (전용, 공급) 3세대 이상, 비상식 비율 제거,
 *     공급/전용 > 1.7 이면 단지 보류, 계산된 세대가 아파트 세대의 50% 미만이면 보류.
 *     기존의 "단지 공용 행 90% 이상이 허용 이름" 비율 조건은 없앤다 (이름 분류로 대체).
 *
 * 단계:
 *   extract <sido2|g2>  로컬 전유공용 캐시 → 단지별 호 묶음(전유, 주건축물 공용 행 이름·면적) + 기존 규칙 결과
 *   plan                 새 규칙 계산, 청약홈 비교, 기존 값 회귀 비교, 보류 단지 채움 계획 (DB 읽기만)
 *
 *   ./node_modules/.bin/tsx scripts/supply-fill/fill-common-rule.mts extract 12
 *   ./node_modules/.bin/tsx scripts/supply-fill/fill-common-rule.mts extract g2
 *   ./node_modules/.bin/tsx scripts/supply-fill/fill-common-rule.mts plan
 *   ./node_modules/.bin/tsx scripts/supply-fill/fill-common-rule.mts apply-plan   (쓸 것 계산만)
 *   ./node_modules/.bin/tsx scripts/supply-fill/fill-common-rule.mts apply        (쓰기; 다시 apply-plan 하면 0)
 *
 * 출력: C:/data/fixes/supply-common-rule-2026-09-25 (SUPPLY_COMMON_OUT 로 바꿀 수 있음)
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { config } from "dotenv";
import { createClient, type InArgs } from "@libsql/client";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import { deriveOfficialSupplies, roundArea, type ExposRow } from "../../src/lib/unit-type/official-expos";

config({ path: ".env.local", quiet: true });

const OUT = process.env.SUPPLY_COMMON_OUT ?? "C:/data/fixes/supply-common-rule-2026-09-25";
const WORK = join(OUT, "work");
const NT_TARGETS = "data/poc/supply/nt-pnu-cadastre.jsonl";
const G2_TARGETS = "data/poc/supply/g2-pnu-cadastre.jsonl";
const G2_EXPOS = "data/poc/supply/g2-expos.jsonl";
const SUCCESSOR_CSV = "data/admin-codes/lawd-successor.csv";
const NT_RECOVERY = "supply_fill_local_nt_2026_09";
const G2_RECOVERY = "supply_fill_local_g2_2026_09";
const MIN_COVERAGE = 0.5;
const MAX_RATIO = 1.7;
const PARTIAL_RE = /공유면적|일부공유/;

// ───────────────────────── 분류 ─────────────────────────

export type CommonClass = "INCLUDE" | "EXCLUDE" | "UNKNOWN";

/**
 * 기타공용(EXCLUDE). 순서대로 보고 먼저 맞는 것. 부분 문자열 일치.
 * 지하: 주택공급에 관한 규칙 제21조 ⑤ — 주거공용은 "지상층에 있는 공용면적", 지하층은 그 밖의 공용면적.
 */
export const EXCLUDE_RULES: Array<[string, RegExp]> = [
  ["지하층(지하·지층)", /지하|자하|주하|^지층|^동지하|지하층/],
  ["주차장·연결통로 (지하주차장↔동 연결통로)", /주차|연결통로/],
  ["민방위 대피시설", /대피/],
  ["관리사무소", /관리/],
  ["노인정·경로당", /노인|노이정|경로/],
  ["경비실·수위실", /경비|수위|초소/],
  ["기계·전기·설비실", /기계|전기|수전|발전|펌프|보일|보이라|보이러|변전|공조|휀|팬룸|제연|MDF|엠디에프|통신|방재|감시|제어반|알람밸브|열교환|기전|중앙공급|공급실|공급소|굴뚝/],
  ["물·가스·오수", /물탱크|저수조|수조|정화조|오수|가스|까스|깨스|LPG|정압|가바나|기화기|소화약제|CO2/],
  ["창고·재활용·택배", /창고|재활용|폐기물|쓰레기|택배|자전거/],
  ["화장실", /화장실|변소/],
  ["주민공동·복리시설", /주민|커뮤니티|입주자|입주민|공동시설|복지|복리|부대|편익|편의|휴게|운동|체력|휘트니스|골프|독서|도서|문고|공부방|보육|어린이집|탁아|집회|회의|다목적|게스트|라운지|놀이터|공동작업장/],
  ["상가·근린생활", /상가|근린|점포|소매|사무|학원|음식|세탁|중개|판매/],
];

/** 주거공용(INCLUDE). EXCLUDE에 안 걸린 토큰만 본다. */
export const INCLUDE_RULES: Array<[string, RegExp]> = [
  ["계단", /계단|게단/],
  ["복도", /복도/],
  ["현관·출입구·로비", /현관|출입구|로비|방풍실/],
  ["홀", /홀|HALL/],
  ["승강기", /승강|엘리|엘레|에레|엘이|에리|^EV|^ELEV|^ELV|^ELE|^EL실?$|^EVEL|^L실$/],
  ["전실·부속실", /전실|부속실/],
  ["코어", /코아|코어|CORE/],
  ["벽체", /벽/],
  ["초과발코니 (기존 규칙과 같음)", /발코니초과|초과발코니/],
  ["주거공용", /^주거공용/],
];

function normalizeName(raw: string): string {
  return raw
    .replace(/\s+/g, "")
    .replace(/\([^)]*\)?/g, "")
    .replace(/(?<=[A-Za-z])[./·\-](?=[A-Za-z])/g, "")
    .toUpperCase();
}
export function nameTokens(raw: string): string[] {
  return normalizeName(raw)
    .split(/[,，/·、.+&;]|및/)
    .map((t) => t.replace(/^\d+층/, "").replace(/(등|면적|부분)+$/, ""))
    .filter(Boolean);
}
export function classifyToken(token: string): { cls: CommonClass; rule: string } {
  for (const [rule, re] of EXCLUDE_RULES) if (re.test(token)) return { cls: "EXCLUDE", rule };
  for (const [rule, re] of INCLUDE_RULES) if (re.test(token)) return { cls: "INCLUDE", rule };
  return { cls: "UNKNOWN", rule: "" };
}
const classCache = new Map<string, CommonClass>();
/** 행 하나의 분류. 빈 이름은 "BLANK" (호에 공유면적 표시가 없으면 주거공용으로 본다). */
export function classifyName(raw: string): CommonClass | "BLANK" {
  const key = raw.trim();
  if (!key) return "BLANK";
  const hit = classCache.get(key);
  if (hit) return hit;
  const toks = nameTokens(key);
  let cls: CommonClass;
  if (toks.length === 0) cls = "UNKNOWN";
  else {
    const set = new Set(toks.map((t) => classifyToken(t).cls));
    cls = set.size === 1 ? [...set][0]! : "UNKNOWN"; // 섞이면 면적을 나눌 수 없음
  }
  classCache.set(key, cls);
  return cls;
}

// ───────────────────────── 공통 ─────────────────────────

type FileRow = ExposRow & { pnu: string; exposCd?: string; mainAtchCd?: string; mainPurpsCd?: string };
type Group = { ex: number; partial: boolean; rows: Array<[string, number]>; n: number };
type Supply = [number, number, number]; // exCents, supplyCents, households
type Extracted = {
  set: "nt" | "g2" | "ah";
  complexId: string;
  aptName: string;
  lawdCd: string;
  dong: string;
  sido: string;
  sigungu: string;
  pnu: string;
  gate: string;
  old?: { status: string; supplies: Supply[]; aptUnits: number };
  groups?: Group[];
};

const str = (v: unknown) => (v == null ? "" : String(v).trim());
const num = (v: unknown) => {
  const n = typeof v === "bigint" ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
function bump(m: Record<string, number>, k: string, by = 1) {
  m[k] = (m[k] ?? 0) + by;
}

function toExpos(row: FileRow): ExposRow {
  let expos = str(row.exposPubuseGbCdNm);
  if (!expos && row.exposCd === "1") expos = "전유";
  if (!expos && row.exposCd === "2") expos = "공용";
  let atch = str(row.mainAtchGbCdNm);
  if (!atch && row.mainAtchCd === "0") atch = "주건축물";
  if (!atch && row.mainAtchCd === "1") atch = "부속건축물";
  let purps = str(row.mainPurpsCdNm);
  if (!purps && row.mainPurpsCd === "02001") purps = "아파트";
  return {
    dongNm: str(row.dongNm),
    hoNm: str(row.hoNm),
    flrNo: str(row.flrNo),
    exposPubuseGbCdNm: expos,
    mainAtchGbCdNm: atch,
    mainPurpsCdNm: purps,
    etcPurps: str(row.etcPurps),
    area: row.area,
    bldNm: "",
  };
}

/** official-expos.ts unitIdentity 와 같음. */
function unitKey(row: ExposRow): string | null {
  let dong = (row.dongNm || "").trim();
  let ho = (row.hoNm || "").trim();
  if (!dong && ho.includes("-")) {
    const [head, ...rest] = ho.split("-");
    if (head && rest.length > 0 && rest.join("-")) {
      dong = head;
      ho = rest.join("-");
    }
  }
  const combined = !dong ? /^(\S+동)\s+(\S+)$/.exec(ho) : null;
  if (combined) {
    dong = combined[1]!;
    ho = combined[2]!;
  }
  if (!dong || !ho) return null;
  return `${dong}\t${ho}`;
}

/** 호 → (전유, 주건축물 공용 행) 묶음. 같은 모양의 호는 세대수로 합친다. */
function groupUnits(rows: ExposRow[]): Group[] {
  const byUnit = new Map<string, ExposRow[]>();
  for (const row of rows) {
    const key = unitKey(row);
    if (!key) continue;
    const list = byUnit.get(key);
    if (list) list.push(row);
    else byUnit.set(key, [row]);
  }
  const sig = new Map<string, Group>();
  for (const group of byUnit.values()) {
    const exRows = group.filter(
      (r) => r.exposPubuseGbCdNm === "전유" && r.mainAtchGbCdNm === "주건축물" && r.mainPurpsCdNm === "아파트",
    );
    if (exRows.length === 0) continue;
    const ex = roundArea(exRows.reduce((s, r) => s + Number(r.area ?? 0), 0));
    const partial = exRows.some((r) => PARTIAL_RE.test(r.etcPurps || ""));
    const common: Array<[string, number]> = group
      .filter((r) => r.exposPubuseGbCdNm === "공용" && r.mainAtchGbCdNm === "주건축물")
      .map((r) => [str(r.etcPurps), Number(r.area ?? 0)]);
    const key = JSON.stringify([ex, partial, common]);
    const g = sig.get(key);
    if (g) g.n += 1;
    else sig.set(key, { ex, partial, rows: common, n: 1 });
  }
  return [...sig.values()];
}

function isUnreasonable(exclusive: number, supply: number): boolean {
  if (!(exclusive > 0) || !(supply > exclusive)) return true;
  const ratio = supply / exclusive;
  if (ratio > 5) return true;
  if (exclusive < 10 && ratio > 3) return true;
  return false;
}

/** fill-notrade-local.mts 의 보류 순서 (DB 'ALREADY_HAS_TYPES' 확인 제외). */
function finishStatus(aptUnits: number, supplies: Supply[], distinguishable: boolean): { status: string; supplies: Supply[] } {
  if (aptUnits === 0) return { status: "NO_APT_EXCLUSIVE", supplies: [] };
  if (!distinguishable) return { status: supplies.length === 0 ? "NO_DERIVABLE" : "COMMON_SEMANTICS_UNCLEAR", supplies: [] };
  const kept = supplies.filter(([e, s]) => !isUnreasonable(e / 100, s / 100));
  if (kept.length === 0) return { status: "NO_DERIVABLE", supplies: [] };
  if (kept.some(([e, s]) => s / e > MAX_RATIO)) return { status: "IMPLAUSIBLE_RATIO", supplies: kept };
  const households = kept.reduce((n, v) => n + v[2], 0);
  if (households / aptUnits < MIN_COVERAGE) return { status: "LOW_COVERAGE", supplies: kept };
  return { status: "FILLED", supplies: kept };
}

function oldRule(rows: ExposRow[], aptName: string) {
  const d = deriveOfficialSupplies(rows, aptName);
  const supplies: Supply[] = d.supplies.map((v) => [v.exclusiveCents, v.supplyCents, v.householdCount]);
  return { ...finishStatus(d.units.length, supplies, d.distinguishable), aptUnits: d.units.length };
}

export type UnitVerdict = { derivable: boolean; reason: string; supply: number };
/** 새 규칙: 호 하나. */
export function newUnit(g: Group, classify: (raw: string) => CommonClass | "BLANK" = classifyName): UnitVerdict {
  if (!(g.ex > 0)) return { derivable: false, reason: "NO_EXCLUSIVE", supply: 0 };
  if (g.partial) return { derivable: false, reason: "PARTIAL", supply: 0 };
  let residential = 0;
  for (const [name, area] of g.rows) {
    const c = classify(name);
    if (c === "UNKNOWN") return { derivable: false, reason: "UNKNOWN_NAME", supply: 0 };
    if (c === "INCLUDE" || c === "BLANK") residential += area;
  }
  if (!(roundArea(residential) > 0)) return { derivable: false, reason: "NO_RESIDENTIAL_COMMON", supply: 0 };
  return { derivable: true, reason: "", supply: roundArea(g.ex + roundArea(residential)) };
}
export function newRule(groups: Group[], classify: (raw: string) => CommonClass | "BLANK" = classifyName) {
  const aptUnits = groups.reduce((n, g) => n + g.n, 0);
  const buckets = new Map<string, number>();
  const unitReasons: Record<string, number> = {};
  for (const g of groups) {
    const v = newUnit(g, classify);
    if (!v.derivable) {
      bump(unitReasons, v.reason, g.n);
      continue;
    }
    const e = exclusiveCents(g.ex);
    const s = exclusiveCents(v.supply);
    if (e < 0 || s < 0) continue;
    const k = `${e}|${s}`;
    buckets.set(k, (buckets.get(k) ?? 0) + g.n);
  }
  const supplies: Supply[] = [];
  for (const [k, n] of buckets) {
    if (n < 3) continue;
    const [e, s] = k.split("|").map(Number);
    supplies.push([e!, s!, n]);
  }
  supplies.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { ...finishStatus(aptUnits, supplies, supplies.length > 0), aptUnits, unitReasons };
}

// ───────────────────────── extract ─────────────────────────

async function streamRows(file: string, wanted: Set<string>): Promise<Map<string, ExposRow[]>> {
  const byPnu = new Map<string, ExposRow[]>();
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const pnu = line.slice(9, 28);
    if (!wanted.has(pnu)) {
      if (line.startsWith('{"pnu": "')) continue;
      const row = JSON.parse(line) as FileRow;
      if (!wanted.has(row.pnu)) continue;
    }
    const row = JSON.parse(line) as FileRow;
    const list = byPnu.get(row.pnu) ?? [];
    list.push(toExpos(row));
    byPnu.set(row.pnu, list);
  }
  return byPnu;
}

async function extract(which: string) {
  mkdirSync(WORK, { recursive: true });
  const out: Extracted[] = [];
  if (which === "g2") {
    type G2 = { complexId: string; aptName: string; lawdCd: string; dong: string; sido: string; sigungu: string; pnu: string; cadastre: string; identityStatus: string };
    const targets = readFileSync(G2_TARGETS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as G2);
    const owners = new Map<string, number>();
    for (const t of targets) if (t.pnu) owners.set(t.pnu, (owners.get(t.pnu) ?? 0) + 1);
    const byPnu = await streamRows(G2_EXPOS, new Set(targets.filter((t) => t.cadastre === "EXISTS" && t.pnu).map((t) => t.pnu)));
    for (const t of targets) {
      const base = { set: "g2" as const, complexId: t.complexId, aptName: t.aptName, lawdCd: t.lawdCd, dong: t.dong, sido: t.sido, sigungu: t.sigungu, pnu: t.pnu };
      let gate = "OK";
      if (!t.pnu || t.cadastre !== "EXISTS") gate = t.cadastre === "ABSENT" ? "CADASTRE_ABSENT" : t.identityStatus || "NO_PNU";
      else if ((owners.get(t.pnu) ?? 0) > 1) gate = "SHARED_PNU";
      else if ((byPnu.get(t.pnu)?.length ?? 0) === 0) gate = "NO_EXPOS_ROWS";
      if (gate !== "OK") {
        out.push({ ...base, gate });
        continue;
      }
      const rows = byPnu.get(t.pnu)!;
      out.push({ ...base, gate, old: oldRule(rows, t.aptName), groups: groupUnits(rows) });
    }
  } else {
    type NT = { complexId: string; aptName: string; lawdCd: string; dong: string; sido: string; sigungu: string; registryPnus: string[]; identityStatus: string; cadastre: string; pnuOwners: number };
    const ah = which === "ah";
    const targets = readFileSync(ah ? join(WORK, "ah-targets.jsonl") : NT_TARGETS, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as NT)
      .filter((t) => ah || t.lawdCd.startsWith(which));
    const file = ah ? join(WORK, "ah-expos.jsonl") : `data/poc/supply/nt-expos-${which}.jsonl`;
    if (!existsSync(file)) throw new Error(`${file} missing`);
    const byPnu = await streamRows(file, new Set(targets.flatMap((t) => t.registryPnus)));
    for (const t of targets) {
      const usedPnu = t.registryPnus.find((p) => (byPnu.get(p)?.length ?? 0) > 0) ?? "";
      const base = { set: (ah ? "ah" : "nt") as "nt" | "ah", complexId: t.complexId, aptName: t.aptName, lawdCd: t.lawdCd, dong: t.dong, sido: t.sido, sigungu: t.sigungu, pnu: usedPnu };
      let gate = "OK";
      if (t.identityStatus !== "AS_IS" && t.identityStatus !== "REMAPPED") gate = t.identityStatus;
      else if (t.cadastre !== "EXISTS") gate = "CADASTRE_ABSENT";
      else if (t.pnuOwners > 1) gate = "SHARED_PNU";
      else if (!usedPnu) gate = "NO_EXPOS_ROWS";
      if (gate !== "OK") {
        out.push({ ...base, gate });
        continue;
      }
      const rows = byPnu.get(usedPnu)!;
      out.push({ ...base, gate, old: oldRule(rows, t.aptName), groups: groupUnits(rows) });
    }
  }
  writeFileSync(join(WORK, `units-${which}.jsonl`), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const st: Record<string, number> = {};
  for (const r of out) bump(st, r.old?.status ?? r.gate);
  console.log(JSON.stringify({ which, complexes: out.length, status: st }));
}

// ───────────────────────── plan ─────────────────────────

function houseTyExclusiveCents(houseTy: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,4})/.exec(houseTy.trim());
  if (!m) return null;
  const t = Number(m[1]) * 10000 + Number(m[2]!.padEnd(4, "0"));
  return Math.floor((t + 50) / 100);
}
function areaCents(area: number): number {
  return Math.floor((Math.round(area * 10000) + 50) / 100);
}
const normName = (n: string) => n.replace(/\([^)]*\)/g, "").replace(/\s+/g, "");
const stripApt = (n: string) => (n.endsWith("아파트") && n.length > 3 ? n.slice(0, -3) : n);
function regionPrefixes(address: string): string[] {
  const out = new Set<string>();
  for (const t of address.replace(/[(),]/g, " ").split(/\s+/).filter(Boolean).slice(1, 6)) {
    if (/[시군구읍면동가]$/.test(t) && !/^\d/.test(t)) {
      out.add(t);
      if (t.length - 1 >= 2) out.add(t.slice(0, -1));
    }
  }
  return [...out];
}
function noticeNameForms(name: string, address: string): string[] {
  const n0 = normName(name);
  const forms = new Set([n0, stripApt(n0)]);
  for (const p of regionPrefixes(address)) {
    if (n0.startsWith(p) && n0.length > p.length) {
      const rest = n0.slice(p.length);
      forms.add(rest);
      forms.add(stripApt(rest));
    }
  }
  forms.delete("");
  return [...forms];
}
function loadSuccessor(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!existsSync(SUCCESSOR_CSV)) return out;
  const lines = readFileSync(SUCCESSOR_CSV, "utf8").split(/\r?\n/).filter(Boolean);
  const head = lines[0]!.split(",");
  const [iOld, iRes, iUmd] = ["old_lawd_cd", "resolved_lawd_cd", "umd_nm"].map((h) => head.indexOf(h));
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const key = `${c[iOld!]!.slice(0, 5)}|${c[iUmd!]}`;
    const set = out.get(key) ?? new Set<string>();
    set.add(c[iRes!]!.slice(0, 5));
    out.set(key, set);
  }
  return out;
}

type Diff = { exact: number; within05: number; n: number; hist: Record<string, number> };
function diffBucket(d: number): string {
  const a = Math.abs(d);
  if (a <= 1) return "0.00";
  if (a <= 10) return "≤0.10";
  if (a <= 50) return "≤0.50";
  if (a <= 100) return "≤1.00";
  if (a <= 300) return "≤3.00";
  if (a <= 1000) return "≤10.0";
  return ">10";
}
function addDiff(t: Diff, dCents: number) {
  t.n += 1;
  if (Math.abs(dCents) <= 1) t.exact += 1;
  if (Math.abs(dCents) <= 50) t.within05 += 1;
  bump(t.hist, diffBucket(dCents));
}
const newDiff = (): Diff => ({ exact: 0, within05: 0, n: 0, hist: {} });
const rate = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 10000) / 100);

async function plan() {
  mkdirSync(OUT, { recursive: true });
  const files = readdirSync(WORK).filter((f) => /^units-.*\.jsonl$/.test(f));
  const all: Extracted[] = files.flatMap((f) =>
    readFileSync(join(WORK, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Extracted),
  );
  // 청약홈 검증용(ah) 단지가 nt/g2 에도 있으면 nt/g2 것만 쓴다.
  const inMain = new Set(all.filter((r) => r.set !== "ah").map((r) => r.complexId));
  const ready = all.filter((r) => r.groups && (r.set !== "ah" || !inMain.has(r.complexId)));

  // 1) 이름 목록: 모든 대상 단지의 아파트 호에 붙은 주건축물 공용 이름 (단지 수, 행 수)
  const nameStats = new Map<string, { cx: Set<string>; heldCx: Set<string>; rows: number; cls: string; tokens: string }>();
  for (const r of ready) {
    const held = r.old!.status === "NO_DERIVABLE";
    for (const g of r.groups!) {
      for (const [name] of g.rows) {
        const key = name.trim() || "(빈 이름)";
        let s = nameStats.get(key);
        if (!s) {
          const c = classifyName(name);
          s = {
            cx: new Set(),
            heldCx: new Set(),
            rows: 0,
            cls: c,
            tokens: nameTokens(name).map((t) => `${t}:${classifyToken(t).cls[0]}${classifyToken(t).rule ? `(${classifyToken(t).rule})` : ""}`).join(" "),
          };
          nameStats.set(key, s);
        }
        s.cx.add(r.complexId);
        if (held) s.heldCx.add(r.complexId);
        s.rows += g.n;
      }
    }
  }
  const tokenStats = new Map<string, { cx: Set<string>; heldCx: Set<string>; cls: string; rule: string }>();
  for (const [name, s] of nameStats) {
    if (name === "(빈 이름)") continue;
    for (const t of nameTokens(name)) {
      const c = classifyToken(t);
      const ts = tokenStats.get(t) ?? { cx: new Set<string>(), heldCx: new Set<string>(), cls: c.cls, rule: c.rule };
      for (const x of s.cx) ts.cx.add(x);
      for (const x of s.heldCx) ts.heldCx.add(x);
      tokenStats.set(t, ts);
    }
  }
  const tokenList = [...tokenStats.entries()]
    .map(([token, s]) => ({ token, cls: s.cls, rule: s.rule, complexes: s.cx.size, heldComplexes: s.heldCx.size }))
    .sort((a, b) => b.heldComplexes - a.heldComplexes || b.complexes - a.complexes);
  const nameList = [...nameStats.entries()]
    .map(([name, s]) => ({ name, cls: s.cls, complexes: s.cx.size, heldComplexes: s.heldCx.size, unitRows: s.rows, tokens: s.tokens }))
    .sort((a, b) => b.heldComplexes - a.heldComplexes || b.complexes - a.complexes);
  const byRule: Record<string, { cls: string; tokens: number; heldComplexes: Set<string>; examples: string[] }> = {};
  for (const t of tokenList) {
    const key = `${t.cls}:${t.rule || "(목록 밖)"}`;
    const b = (byRule[key] ??= { cls: t.cls, tokens: 0, heldComplexes: new Set(), examples: [] });
    b.tokens += 1;
    for (const x of tokenStats.get(t.token)!.heldCx) b.heldComplexes.add(x);
    if (b.examples.length < 25) b.examples.push(`${t.token}(${t.heldComplexes})`);
  }
  writeFileSync(join(OUT, "common-names.json"), JSON.stringify({ tokens: tokenList, names: nameList }, null, 1));
  writeFileSync(
    join(OUT, "common-classes.json"),
    JSON.stringify(
      {
        exclude: EXCLUDE_RULES.map(([k, re]) => ({ rule: k, pattern: re.source })),
        include: INCLUDE_RULES.map(([k, re]) => ({ rule: k, pattern: re.source })),
        byRule: Object.fromEntries(
          Object.entries(byRule)
            .sort((a, b) => b[1].heldComplexes.size - a[1].heldComplexes.size)
            .map(([k, v]) => [k, { tokens: v.tokens, heldComplexes: v.heldComplexes.size, examples: v.examples }]),
        ),
      },
      null,
      1,
    ),
  );

  // 2) 새 규칙
  const result = new Map<string, ReturnType<typeof newRule>>();
  for (const r of ready) result.set(r.complexId, newRule(r.groups!));

  // 3) 회귀: 기존 규칙으로 FILLED 였던 단지는 새 규칙에서도 (전용, 공급, 세대) 이 같아야 한다.
  const regression = { oldFilled: 0, identical: 0, newNotFilled: {} as Record<string, number>, changed: [] as unknown[] };
  for (const r of ready) {
    if (r.old!.status !== "FILLED" || r.set === "ah") continue;
    regression.oldFilled += 1;
    const n = result.get(r.complexId)!;
    if (n.status !== "FILLED") {
      bump(regression.newNotFilled, n.status);
      regression.changed.push({ complexId: r.complexId, name: r.aptName, set: r.set, newStatus: n.status, old: r.old!.supplies, new: n.supplies, unitReasons: n.unitReasons });
      continue;
    }
    if (JSON.stringify(n.supplies) === JSON.stringify(r.old!.supplies)) regression.identical += 1;
    else regression.changed.push({ complexId: r.complexId, name: r.aptName, set: r.set, newStatus: n.status, old: r.old!.supplies, new: n.supplies, examples: changedNames(r) });
  }

  // DB (읽기만)
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!.trim(), authToken: process.env.TURSO_AUTH_TOKEN!.trim() });
  const ids = ready.map((r) => r.complexId);
  type DbRow = { ex: number; su: number; source: string; recovery: string; status: string };
  const dbRows = new Map<string, DbRow[]>();
  for (const part of chunks(ids, 300)) {
    const res = await db.execute({
      sql: `SELECT complex_id, exclusive_cents, supply_cents, source, status, provenance_json FROM apt_canonical_unit_types
            WHERE complex_id IN (${part.map(() => "?").join(",")})`,
      args: part as InArgs,
    });
    for (const row of res.rows) {
      const p = str(row.provenance_json);
      const list = dbRows.get(str(row.complex_id)) ?? [];
      list.push({
        ex: num(row.exclusive_cents),
        su: num(row.supply_cents),
        source: str(row.source),
        status: str(row.status),
        recovery: p.includes(NT_RECOVERY) ? "nt" : p.includes(G2_RECOVERY) ? "g2" : "",
      });
      dbRows.set(str(row.complex_id), list);
    }
  }
  // 3b) DB에 기존 규칙으로 들어간 값과 비교
  const dbReg = {
    nt: { rows: 0, sameAsNew: 0, newMissing: 0, differs: [] as unknown[] },
    g2: { rows: 0, sameAsNew: 0, newMissing: 0, differs: [] as unknown[] },
    otherSource: { rows: 0, diff: newDiff(), bySource: {} as Record<string, Diff> },
  };
  for (const r of ready) {
    const n = result.get(r.complexId)!;
    const newSup = new Map<number, number[]>();
    for (const g of r.groups!) {
      const v = newUnit(g);
      if (!v.derivable) continue;
      const e = exclusiveCents(g.ex);
      const list = newSup.get(e) ?? [];
      list.push(exclusiveCents(v.supply));
      newSup.set(e, list);
    }
    const planSet = new Set(n.supplies.map(([e, s]) => `${e}|${s}`));
    for (const row of dbRows.get(r.complexId) ?? []) {
      if (row.su < 0) continue;
      if (row.recovery === "nt" || row.recovery === "g2") {
        const t = dbReg[row.recovery];
        t.rows += 1;
        const unitSet = newSup.get(row.ex) ?? [];
        if (row.recovery === "nt" ? planSet.has(`${row.ex}|${row.su}`) : unitSet.includes(row.su)) t.sameAsNew += 1;
        else if (unitSet.length === 0) t.newMissing += 1;
        else t.differs.push({ complexId: r.complexId, name: r.aptName, ex: row.ex, dbSupply: row.su, newSupplies: [...new Set(unitSet)] });
        continue;
      }
      const cands = [...new Set(newSup.get(row.ex) ?? [])];
      if (cands.length === 0) continue;
      const d = cands.map((c) => c - row.su).sort((a, b) => Math.abs(a) - Math.abs(b))[0]!;
      dbReg.otherSource.rows += 1;
      addDiff(dbReg.otherSource.diff, d);
      addDiff((dbReg.otherSource.bySource[row.source] ??= newDiff()), d);
    }
  }

  // 사용승인 연도 (단지 프로필) — 옛 단지는 분양 관행이 달라 따로 본다
  const approval = new Map<string, string>();
  for (const part of chunks(ids, 300)) {
    const res = await db.execute({
      sql: `SELECT complex_id, approval_date FROM apt_complex_profile WHERE complex_id IN (${part.map(() => "?").join(",")})`,
      args: part as InArgs,
    });
    for (const row of res.rows) approval.set(str(row.complex_id), str(row.approval_date));
  }
  const era = (id: string) => {
    const y = Number((approval.get(id) ?? "").slice(0, 4));
    if (!y) return "unknown";
    if (y < 1990) return "~1989";
    if (y < 2000) return "1990s";
    if (y < 2010) return "2000s";
    if (y < 2015) return "2010-14";
    return "2015~";
  };

  // 4) 청약홈 비교
  const notices = (await db.execute(`SELECT house_manage_no, house_nm, address, lawd_cd, notice_type FROM applyhome_notices`)).rows.map((r) => ({
    id: str(r.house_manage_no),
    name: str(r.house_nm),
    address: str(r.address),
    lawd: str(r.lawd_cd),
    remndr: str(r.notice_type) === "remndr",
  }));
  const models = new Map<string, Array<{ ex: number; su: number | null; houseTy: string }>>();
  for (const r of (await db.execute(`SELECT house_manage_no, house_ty, supply_area FROM applyhome_models`)).rows) {
    const ex = houseTyExclusiveCents(str(r.house_ty));
    if (ex == null) continue;
    const sa = r.supply_area == null ? null : num(r.supply_area);
    const list = models.get(str(r.house_manage_no)) ?? [];
    list.push({ ex, su: sa != null && sa > 0 ? areaCents(sa) : null, houseTy: str(r.house_ty) });
    models.set(str(r.house_manage_no), list);
  }
  const successor = loadSuccessor();
  const byName = new Map<string, Extracted[]>();
  for (const r of ready) {
    for (const f of new Set([normName(r.aptName), stripApt(normName(r.aptName))])) {
      const list = byName.get(f) ?? [];
      if (!list.includes(r)) list.push(r);
      byName.set(f, list);
    }
  }
  type Link = { r: Extracted; noticeIds: string[] };
  const linkMap = new Map<string, string[]>();
  const noticeCx = new Map<string, Set<string>>();
  const linkStage: Record<string, number> = {};
  for (const n of notices) {
    const seen = new Set<string>();
    for (const f of noticeNameForms(n.name, n.address)) {
      for (const r of byName.get(f) ?? []) {
        if (seen.has(r.complexId)) continue;
        seen.add(r.complexId);
        let ok = n.lawd && n.lawd === r.lawdCd;
        if (!ok && n.lawd) {
          const s = successor.get(`${n.lawd.slice(0, 5)}|${r.dong}`);
          ok = !!s && s.size === 1 && s.has(r.lawdCd);
        }
        if (!ok) {
          bump(linkStage, "LAWD");
          continue;
        }
        if (!r.dong || !n.address.includes(r.dong)) {
          bump(linkStage, "DONG");
          continue;
        }
        // 전용: 공고 주택형(공급 있는 것)의 전용이 모두 대장 아파트 호 전용에 있어야 한다.
        const regEx = new Set(r.groups!.map((g) => exclusiveCents(g.ex)));
        const nx = [...new Set((models.get(n.id) ?? []).filter((m) => m.su != null).map((m) => m.ex))];
        if (nx.length === 0 || nx.some((e) => !regEx.has(e))) {
          bump(linkStage, "EXCLUSIVE");
          continue;
        }
        bump(linkStage, "PASS");
        const l = linkMap.get(r.complexId) ?? [];
        l.push(n.id);
        linkMap.set(r.complexId, l);
        const c = noticeCx.get(n.id) ?? new Set<string>();
        c.add(r.complexId);
        noticeCx.set(n.id, c);
      }
    }
  }
  const noticeById = new Map(notices.map((n) => [n.id, n]));
  const links: Link[] = [];
  for (const [cid, nids] of linkMap) {
    if (nids.some((id) => (noticeCx.get(id)?.size ?? 0) > 1)) {
      bump(linkStage, "HOLD_NOTICE_MANY_COMPLEXES");
      continue;
    }
    const general = nids.filter((id) => !noticeById.get(id)!.remndr);
    links.push({ r: ready.find((x) => x.complexId === cid)!, noticeIds: general.length ? general : nids });
  }
  const val = {
    links: links.length,
    linkStage,
    newRule: newDiff(),
    newRuleFilledOnly: newDiff(),
    newRuleHeldSet: newDiff(),
    oldRuleFilledOnly: newDiff(),
    newRuleComplexes: { linked: 0, filled: 0, allExactFilled: 0 },
    rows: [] as unknown[],
  };
  for (const { r, noticeIds } of links) {
    const n = result.get(r.complexId)!;
    // 호 단위 새 규칙 공급 (세대 수 포함)
    const unitSup = new Map<number, Map<number, number>>();
    for (const g of r.groups!) {
      const v = newUnit(g);
      if (!v.derivable) continue;
      const e = exclusiveCents(g.ex);
      const m = unitSup.get(e) ?? new Map<number, number>();
      m.set(exclusiveCents(v.supply), (m.get(exclusiveCents(v.supply)) ?? 0) + g.n);
      unitSup.set(e, m);
    }
    const planned = new Map<number, number[]>();
    for (const [e, s] of n.supplies) planned.set(e, [...(planned.get(e) ?? []), s]);
    const oldPlanned = new Map<number, number[]>();
    for (const [e, s] of r.old!.supplies) if (r.old!.status === "FILLED") oldPlanned.set(e, [...(oldPlanned.get(e) ?? []), s]);
    val.newRuleComplexes.linked += 1;
    if (n.status === "FILLED") val.newRuleComplexes.filled += 1;
    let allExact = n.status === "FILLED";
    const seenPair = new Set<string>();
    for (const nid of noticeIds) {
      for (const m of models.get(nid) ?? []) {
        if (m.su == null) continue;
        const key = `${m.ex}|${m.su}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        const unitCands = [...(unitSup.get(m.ex)?.keys() ?? [])];
        const nearest = (c: number[]) => c.map((x) => x - m.su!).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
        const dUnit = unitCands.length ? nearest(unitCands) : undefined;
        if (dUnit !== undefined) addDiff(val.newRule, dUnit);
        const dPlan = planned.has(m.ex) && n.status === "FILLED" ? nearest(planned.get(m.ex)!) : undefined;
        if (dPlan !== undefined) {
          addDiff(val.newRuleFilledOnly, dPlan);
          if (r.old!.status === "NO_DERIVABLE") addDiff(val.newRuleHeldSet, dPlan);
          if (Math.abs(dPlan) > 1) allExact = false;
        } else if (n.status === "FILLED") allExact = false;
        const dOld = oldPlanned.has(m.ex) ? nearest(oldPlanned.get(m.ex)!) : undefined;
        if (dOld !== undefined) addDiff(val.oldRuleFilledOnly, dOld);
        val.rows.push({
          complexId: r.complexId,
          name: r.aptName,
          set: r.set,
          sido: r.sido,
          oldStatus: r.old!.status,
          newStatus: n.status,
          approval: approval.get(r.complexId) ?? "",
          notice: nid,
          houseTy: m.houseTy,
          noticeSupply: m.su / 100,
          newUnitSupplies: unitCands.map((c) => [c / 100, unitSup.get(m.ex)!.get(c)]),
          newPlanned: (planned.get(m.ex) ?? []).map((c) => c / 100),
          diffNew: dPlan === undefined ? (dUnit === undefined ? null : dUnit / 100) : dPlan / 100,
          oldPlanned: (oldPlanned.get(m.ex) ?? []).map((c) => c / 100),
        });
      }
    }
    if (allExact) val.newRuleComplexes.allExactFilled += 1;
  }

  // 5) 보류(NO_DERIVABLE 등) 단지 채움 계획
  const fill = {
    oldHeldNoDerivable: 0,
    oldHeldSemanticsUnclear: 0,
    nowFilled: { NO_DERIVABLE: 0, COMMON_SEMANTICS_UNCLEAR: 0 } as Record<string, number>,
    nowFilledTypes: 0,
    nowFilledHouseholds: 0,
    stillHeld: {} as Record<string, number>,
    stillHeldUnitReasons: {} as Record<string, number>,
    bySido: {} as Record<string, { held: number; filled: number; types: number }>,
    byEra: {} as Record<string, { held: number; filled: number; types: number; ratioLt110: number; excludesShelter: number }>,
    bySet: {} as Record<string, { held: number; filled: number }>,
    ratioHist: {} as Record<string, number>,
    oldFilledRatioHist: {} as Record<string, number>,
  };
  for (const r of ready) if (r.set !== "ah" && r.old!.status === "FILLED") for (const [e, su] of r.old!.supplies) bump(fill.oldFilledRatioHist, ratioBucket(su / e));
  const planRows: unknown[] = [];
  const blockingTokens = new Map<string, Set<string>>();
  for (const r of ready) {
    const os = r.old!.status;
    if (r.set === "ah" || (os !== "NO_DERIVABLE" && os !== "COMMON_SEMANTICS_UNCLEAR")) continue;
    if (os === "NO_DERIVABLE") fill.oldHeldNoDerivable += 1;
    else fill.oldHeldSemanticsUnclear += 1;
    const n = result.get(r.complexId)!;
    const s = (fill.bySido[r.sido || r.lawdCd.slice(0, 2)] ??= { held: 0, filled: 0, types: 0 });
    const er = (fill.byEra[era(r.complexId)] ??= { held: 0, filled: 0, types: 0, ratioLt110: 0, excludesShelter: 0 });
    er.held += 1;
    if (n.status === "FILLED") {
      er.filled += 1;
      er.types += n.supplies.length;
      if (n.supplies.some(([e, su]) => su / e < 1.1)) er.ratioLt110 += 1;
      if (r.groups!.some((g) => g.rows.some(([nm]) => classifyName(nm) === "EXCLUDE" && /대피|지하/.test(nm)))) er.excludesShelter += 1;
    }
    const b = (fill.bySet[`${r.set}:${os}`] ??= { held: 0, filled: 0 });
    s.held += 1;
    b.held += 1;
    if (n.status === "FILLED") {
      bump(fill.nowFilled, os);
      s.filled += 1;
      b.filled += 1;
      s.types += n.supplies.length;
      fill.nowFilledTypes += n.supplies.length;
      fill.nowFilledHouseholds += n.supplies.reduce((x, v) => x + v[2], 0);
      planRows.push({
        complexId: r.complexId,
        name: r.aptName,
        set: r.set,
        sido: r.sido,
        sigungu: r.sigungu,
        pnu: r.pnu,
        oldStatus: os,
        approval: approval.get(r.complexId) ?? "",
        aptUnits: n.aptUnits,
        types: n.supplies.map(([e, su, h]) => ({ exclusive: e / 100, supply: su / 100, households: h, ratio: Math.round((su / e) * 1000) / 1000 })),
        includedNames: namesByClass(r, "INCLUDE"),
        excludedNames: namesByClass(r, "EXCLUDE"),
      });
      for (const [e, su] of n.supplies) bump(fill.ratioHist, ratioBucket(su / e));
    } else {
      bump(fill.stillHeld, n.status);
      for (const [k, v] of Object.entries(n.unitReasons)) bump(fill.stillHeldUnitReasons, k, v);
      for (const g of r.groups!) {
        for (const [name] of g.rows) {
          if (classifyName(name) !== "UNKNOWN") continue;
          for (const t of nameTokens(name)) {
            if (classifyToken(t).cls !== "UNKNOWN") continue;
            const set = blockingTokens.get(t) ?? new Set<string>();
            set.add(r.complexId);
            blockingTokens.set(t, set);
          }
        }
      }
    }
  }
  const blocking = [...blockingTokens.entries()].map(([t, s]) => [t, s.size] as const).sort((a, b) => b[1] - a[1]);

  // 샘플 20: 청약홈 연결된 새 채움 단지 우선, 나머지는 시도 골고루
  const filledIds = new Set(planRows.map((p) => (p as { complexId: string }).complexId));
  const valByCx = new Map<string, unknown[]>();
  for (const row of val.rows as Array<{ complexId: string }>) valByCx.set(row.complexId, [...(valByCx.get(row.complexId) ?? []), row]);
  const samples: unknown[] = [];
  for (const p of planRows as Array<{ complexId: string; sido: string }>) {
    if (samples.length >= 10) break;
    if (valByCx.has(p.complexId)) samples.push({ ...p, applyhome: valByCx.get(p.complexId) });
  }
  const perSido = new Map<string, number>();
  for (const p of planRows as Array<{ complexId: string; sido: string }>) {
    if (samples.length >= 20) break;
    if (valByCx.has(p.complexId) || (perSido.get(p.sido) ?? 0) >= 1) continue;
    perSido.set(p.sido, 1);
    const dbr = (dbRows.get(p.complexId) ?? []).filter((x) => x.su >= 0).map((x) => ({ ex: x.ex / 100, su: x.su / 100, source: x.source }));
    samples.push({ ...p, applyhome: null, dbExisting: dbr.length ? dbr : null });
  }

  const summary = {
    at: new Date().toISOString(),
    extracted: all.length,
    ready: ready.length,
    oldStatus: countBy(ready, (r) => `${r.set}:${r.old!.status}`),
    newStatus: countBy(ready, (r) => `${r.set}:${result.get(r.complexId)!.status}`),
    regression: { ...regression, changed: regression.changed.length },
    regressionByEra: (() => {
      const out: Record<string, { oldFilled: number; changed: number }> = {};
      const changedIds = new Set((regression.changed as Array<{ complexId: string }>).map((c) => c.complexId));
      for (const r of ready) {
        if (r.old!.status !== "FILLED" || r.set === "ah") continue;
        const e = (out[era(r.complexId)] ??= { oldFilled: 0, changed: 0 });
        e.oldFilled += 1;
        if (changedIds.has(r.complexId)) e.changed += 1;
      }
      return out;
    })(),
    dbRegression: {
      nt: { ...dbReg.nt, differs: dbReg.nt.differs.length },
      g2: { ...dbReg.g2, differs: dbReg.g2.differs.length },
      otherSource: { rows: dbReg.otherSource.rows, ...withRates(dbReg.otherSource.diff), bySource: Object.fromEntries(Object.entries(dbReg.otherSource.bySource).map(([k, v]) => [k, withRates(v)])) },
    },
    applyhome: {
      links: val.links,
      linkStage: val.linkStage,
      complexes: val.newRuleComplexes,
      newRuleAllUnits: withRates(val.newRule),
      newRuleFilled: withRates(val.newRuleFilledOnly),
      newRuleHeldSetFilled: withRates(val.newRuleHeldSet),
      oldRuleFilled: withRates(val.oldRuleFilledOnly),
    },
    fill: { ...fill, filledIdsCount: filledIds.size },
    blockingUnknownTokens: blocking.slice(0, 60),
  };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
  writeFileSync(join(OUT, "regression-changed.json"), JSON.stringify({ rule: regression.changed, db: { nt: dbReg.nt.differs, g2: dbReg.g2.differs } }, null, 1));
  writeFileSync(join(OUT, "applyhome-compare.json"), JSON.stringify(val.rows, null, 1));
  writeFileSync(join(OUT, "plan-rows.jsonl"), planRows.map((p) => JSON.stringify(p)).join("\n") + "\n");
  writeFileSync(join(OUT, "samples.json"), JSON.stringify(samples, null, 1));
  console.log(JSON.stringify(summary, null, 1));
}

function ratioBucket(x: number): string {
  const b = Math.floor(x * 20) / 20;
  return b.toFixed(2);
}
function namesByClass(r: Extracted, cls: string): string[] {
  const out = new Map<string, number>();
  for (const g of r.groups!) for (const [name] of g.rows) if (classifyName(name) === cls) out.set(name, (out.get(name) ?? 0) + g.n);
  return [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
}
function withRates(d: Diff) {
  return { n: d.n, exact: d.exact, exactRate: rate(d.exact, d.n), within05: d.within05, within05Rate: rate(d.within05, d.n), hist: d.hist };
}
function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of items) bump(out, key(t));
  return out;
}
function changedNames(r: Extracted): string[] {
  const out = new Set<string>();
  for (const g of r.groups!) for (const [name] of g.rows) {
    const c = classifyName(name);
    const oldRes = /계단|엘리베이터|승강기|복도|현관|홀|대피소|벽체|발코니초과/.test(name) || !name.trim();
    if ((c === "INCLUDE" || c === "BLANK") !== oldRes) out.add(`${name}→${c}`);
  }
  return [...out].slice(0, 10);
}

/**
 * 검증 넓히기: 청약홈 공고와 (시군구·이름·법정동)이 정확히 맞는 모든 단지(유형 행 유무 무관)의 PNU 목록.
 * scan-buildinghub-pnus.py 로 로컬 전유공용 대장에서 그 PNU 행만 뽑아 work/ah-expos.jsonl 로 둔다.
 * PNU = master lawd_cd + bjdong_cd + 지번 (지번 못 읽으면 제외). 같은 PNU 단지가 둘 이상이면 제외.
 */
async function applyhomeTargets() {
  mkdirSync(WORK, { recursive: true });
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!.trim(), authToken: process.env.TURSO_AUTH_TOKEN!.trim() });
  const { parseParcelJibun, parcelPnu } = await import("../../src/lib/unit-type/official-expos");
  const masters = (await db.execute(`SELECT complex_id, apt_name, lawd_cd, bjdong_cd, jibun, legal_dong_name, sido, sigungu FROM apt_complex_master`)).rows.map((r) => ({
    complexId: str(r.complex_id),
    aptName: str(r.apt_name),
    lawdCd: str(r.lawd_cd),
    bjdongCd: str(r.bjdong_cd),
    jibun: str(r.jibun),
    dong: str(r.legal_dong_name),
    sido: str(r.sido),
    sigungu: str(r.sigungu),
  }));
  const notices = (await db.execute(`SELECT house_manage_no, house_nm, address, lawd_cd FROM applyhome_notices`)).rows;
  const byName = new Map<string, typeof masters>();
  for (const m of masters) for (const f of new Set([normName(m.aptName), stripApt(normName(m.aptName))])) byName.set(f, [...(byName.get(f) ?? []), m]);
  const successor = loadSuccessor();
  const hit = new Set<string>();
  for (const n of notices) {
    const address = str(n.address);
    const lawd = str(n.lawd_cd);
    for (const f of noticeNameForms(str(n.house_nm), address)) {
      for (const m of byName.get(f) ?? []) {
        let ok = !!lawd && lawd === m.lawdCd;
        if (!ok && lawd) {
          const s = successor.get(`${lawd.slice(0, 5)}|${m.dong}`);
          ok = !!s && s.size === 1 && s.has(m.lawdCd);
        }
        if (ok && m.dong && address.includes(m.dong)) hit.add(m.complexId);
      }
    }
  }
  // 지번이 비었으면 K-apt 법정동주소 → PNU (PNU_EXACT만; 연속지적 1=일반/2=산 → 대장 0=일반/1=산)
  const kapt = new Map<string, string>();
  for (const line of readFileSync("data/poc/supply/kapt-pnu-resolution.jsonl", "utf8").split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line) as { complex_id: string; pnu: string | null; resolution_status: string };
    if (r.resolution_status !== "PNU_EXACT" || !r.pnu || r.pnu.length !== 19) continue;
    kapt.set(r.complex_id, r.pnu.slice(0, 10) + (r.pnu[10] === "2" ? "1" : "0") + r.pnu.slice(11));
  }
  const pnuOf = (m: (typeof masters)[number]) => {
    const p = parseParcelJibun(m.jibun);
    if (p && m.bjdongCd.length === 5) return parcelPnu(m.lawdCd, m.bjdongCd, p.platGbCd, p.bun, p.ji);
    return kapt.get(m.complexId) ?? "";
  };
  const owners = new Map<string, number>();
  for (const m of masters) {
    const p = pnuOf(m);
    if (p) owners.set(p, (owners.get(p) ?? 0) + 1);
  }
  const out = masters
    .filter((m) => hit.has(m.complexId))
    .map((m) => {
      const pnu = pnuOf(m);
      return {
        ...m,
        registryPnus: pnu ? [pnu] : [],
        identityStatus: pnu ? "AS_IS" : "HOLD_LOT_PARSE_FAILED",
        cadastre: pnu ? "EXISTS" : "NO_PNU",
        pnuOwners: pnu ? owners.get(pnu) ?? 0 : 0,
      };
    });
  writeFileSync(join(WORK, "ah-targets.jsonl"), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(JSON.stringify({ linkedByNameLawdDong: hit.size, withPnu: out.filter((r) => r.registryPnus.length).length }));
}

// ───────────────────────── fill (apply-plan | apply) ─────────────────────────

/**
 * 새 규칙 채움을 DB에 쓴다. 사용승인 연도 >= MIN_APPROVAL_YEAR 단지만 (apt_complex_profile, 날짜 없으면 제외).
 * 옛 단지는 지하대피소 등 관행 차이로 공급이 작게 나와 이번엔 뺀다 (소유자 결정 2026-09-25).
 *
 *   nt: fill-notrade-local.mts apply 와 같은 INSERT (단지에 다른 경로 유형 행이 하나라도 있으면 쓰지 않음).
 *       전용 하나에 공급 둘 이상 → AMBIGUOUS_MULTI + apt_unit_supply_representative (세대 많은 것, 같으면 작은 것).
 *   g2: fill-g2-local.mts 와 같은 NULL 전용 UPDATE (supply_cents = -1 AND status = 'NO_SOURCE' AND supply_area IS NULL).
 *       전용 하나에 공급 둘 이상이면 g2 처럼 보류.
 * 덮어쓰기·삭제 없음. 새로 계산한 값이 plan-rows.jsonl 과 다르거나 PNU 대상 파일이 바뀐 단지는 보류.
 * 다시 돌리면 쓸 것이 0 이어야 한다.
 */
const CR_RECOVERY = "supply_fill_common_rule_2026_09";
const CR_RULE_VERSION = "named_common_v1_2026-09-25";
const MIN_APPROVAL_YEAR = 2010;
const REP_RULE = "max_household_then_smaller_supply";

async function fillCommon(apply: boolean) {
  const { areaFromCents, canonicalSupplyPyeong, canonicalUnitTypeId, resolutionStatus, NO_SUPPLY_CENTS } = await import("../../src/lib/unit-type/canonical");
  const { supplyPyeongDisplayLabel } = await import("../../src/lib/unit-type/supply-label");
  const { pickRepresentativeSupply } = await import("../../src/lib/unit-type/supply-representative");

  const files = readdirSync(WORK).filter((f) => /^units-.*\.jsonl$/.test(f) && f !== "units-ah.jsonl");
  const all: Extracted[] = files.flatMap((f) =>
    readFileSync(join(WORK, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Extracted),
  );
  const planned = new Map<string, { set: string; types: Array<{ exclusive: number; supply: number; households: number }> }>();
  for (const l of readFileSync(join(OUT, "plan-rows.jsonl"), "utf8").split("\n")) {
    if (!l) continue;
    const p = JSON.parse(l) as { complexId: string; set: string; types: Array<{ exclusive: number; supply: number; households: number }> };
    planned.set(p.complexId, p);
  }
  // 대상 파일 현재 상태 (다른 작업이 PNU를 다시 잇는 중일 수 있음)
  const ntNow = new Map<string, { registryPnus: string[]; identityStatus: string; cadastre: string; pnuOwners: number }>();
  for (const l of readFileSync(NT_TARGETS, "utf8").split("\n")) if (l) { const t = JSON.parse(l); ntNow.set(t.complexId, t); }
  const g2Now = new Map<string, { pnu: string; cadastre: string }>();
  for (const l of readFileSync(G2_TARGETS, "utf8").split("\n")) if (l) { const t = JSON.parse(l); g2Now.set(t.complexId, t); }

  const cands = all.filter((r) => r.groups && r.old && (r.old.status === "NO_DERIVABLE" || r.old.status === "COMMON_SEMANTICS_UNCLEAR"));
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!.trim(), authToken: process.env.TURSO_AUTH_TOKEN!.trim() });
  const ids = cands.map((r) => r.complexId);
  const approval = new Map<string, string>();
  const dbRows = new Map<string, Array<{ ex: number; su: number; status: string; supplyNull: boolean; ours: boolean }>>();
  for (const part of chunks(ids, 300)) {
    const q = part.map(() => "?").join(",");
    const a = await db.execute({ sql: `SELECT complex_id, approval_date FROM apt_complex_profile WHERE complex_id IN (${q})`, args: part as InArgs });
    for (const row of a.rows) approval.set(str(row.complex_id), str(row.approval_date));
    const u = await db.execute({
      sql: `SELECT complex_id, exclusive_cents, supply_cents, supply_area IS NULL sn, status, provenance_json FROM apt_canonical_unit_types WHERE complex_id IN (${q})`,
      args: part as InArgs,
    });
    for (const row of u.rows) {
      const list = dbRows.get(str(row.complex_id)) ?? [];
      list.push({ ex: num(row.exclusive_cents), su: num(row.supply_cents), status: str(row.status), supplyNull: num(row.sn) === 1, ours: str(row.provenance_json).includes(CR_RECOVERY) });
      dbRows.set(str(row.complex_id), list);
    }
  }

  const now = new Date().toISOString();
  const statements: { sql: string; args: InArgs }[] = [];
  const held: Record<string, number> = {};
  const bySido: Record<string, { complexes: number; types: number; households: number }> = {};
  const lawd: Record<string, number> = {};
  const rowsOut: unknown[] = [];
  const t = { candidates: 0, excludedOld: 0, excludedNoApproval: 0, newRuleNotFilled: 0, eligible: 0, write: 0, types: 0, ambiguousExclusives: 0, alreadyDone: 0, minApproval: "", maxApproval: "" };
  for (const r of cands) {
    const n = newRule(r.groups!);
    if (n.status !== "FILLED") {
      t.newRuleNotFilled += 1;
      continue;
    }
    t.candidates += 1;
    const ap = approval.get(r.complexId) ?? "";
    const year = Number(ap.slice(0, 4));
    if (!year) {
      t.excludedNoApproval += 1;
      continue;
    }
    if (year < MIN_APPROVAL_YEAR) {
      t.excludedOld += 1;
      continue;
    }
    t.eligible += 1;
    const hold = (k: string) => bump(held, k);
    const p = planned.get(r.complexId);
    const key = (xs: Array<[number, number, number]>) => JSON.stringify(xs);
    if (!p || p.set !== r.set || key(p.types.map((x) => [exclusiveCents(x.exclusive), exclusiveCents(x.supply), x.households])) !== key(n.supplies)) {
      hold("PLAN_MISMATCH");
      continue;
    }
    if (r.set === "nt") {
      const cur = ntNow.get(r.complexId);
      if (!cur || !cur.registryPnus.includes(r.pnu) || cur.pnuOwners > 1 || cur.cadastre !== "EXISTS" || (cur.identityStatus !== "AS_IS" && cur.identityStatus !== "REMAPPED")) {
        hold("PNU_CHANGED");
        continue;
      }
    } else {
      const cur = g2Now.get(r.complexId);
      if (!cur || cur.pnu !== r.pnu || cur.cadastre !== "EXISTS") {
        hold("PNU_CHANGED");
        continue;
      }
    }
    const existing = dbRows.get(r.complexId) ?? [];
    const byEx = new Map<number, Supply[]>();
    for (const v of n.supplies) byEx.set(v[0], [...(byEx.get(v[0]) ?? []), v]);
    const provenance = (v: Supply) =>
      JSON.stringify({
        recovery: CR_RECOVERY,
        common_rule: CR_RULE_VERSION,
        formula: "exclusive_plus_residential_common",
        residential_common_area: roundArea((v[1] - v[0]) / 100),
        household_count: v[2],
        registry_pnu: r.pnu,
        min_approval_year: MIN_APPROVAL_YEAR,
        approval_date: ap,
        bulk_source_month: "2026-08",
      });
    let wrote = 0;
    if (r.set === "nt") {
      if (existing.some((x) => !x.ours)) {
        hold("ALREADY_HAS_TYPES");
        continue;
      }
      // 이 채움이 이미 넣은 행만 있으면: 모두 있으면 끝난 것, 빠진 게 있으면 (중간 실패) 같은 문장을 다시 낸다.
      const have = new Set(existing.map((x) => `${x.ex}|${x.su}`));
      if (existing.length > 0 && n.supplies.every(([e, su]) => have.has(`${e}|${su}`))) {
        t.alreadyDone += 1;
        continue;
      }
      const guard = `NOT EXISTS (SELECT 1 FROM apt_canonical_unit_types g WHERE g.complex_id = ? AND g.provenance_json NOT LIKE '%${CR_RECOVERY}%')`;
      for (const [ex, variants] of byEx) {
        const status = resolutionStatus(variants.length, false);
        if (variants.length > 1) t.ambiguousExclusives += 1;
        for (const v of variants) {
          const supplyArea = areaFromCents(v[1]);
          statements.push({
            sql: `INSERT INTO apt_canonical_unit_types (
                    unit_type_id, complex_id, exclusive_area, exclusive_cents, supply_area, supply_cents,
                    supply_pyeong, display_pyeong_label, type_name, household_count, source, source_key,
                    source_as_of, confidence, status, formula, provenance_json, created_at, updated_at
                  )
                  SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'BldRgstHubBulk', ?, '2026-08', 'building_registry_expos', ?, 'exclusive_plus_residential_common', ?, ?, ?
                  WHERE ${guard}
                  ON CONFLICT DO NOTHING`,
            args: [
              canonicalUnitTypeId(r.complexId, ex, v[1]),
              r.complexId,
              areaFromCents(ex),
              ex,
              supplyArea,
              v[1],
              canonicalSupplyPyeong(supplyArea),
              supplyPyeongDisplayLabel(supplyArea),
              v[2],
              `${r.pnu}:${ex}:${v[1]}`,
              status,
              provenance(v),
              now,
              now,
              r.complexId,
            ],
          });
          wrote += 1;
        }
        statements.push({
          sql: `INSERT INTO apt_unit_exclusive_pairs (
                  complex_id, exclusive_cents, exclusive_area, trade_count, trade_count_12m, trade_count_3y,
                  latest_trade_date, resolution_status, supply_variant_count, observed_from
                ) SELECT ?, ?, ?, 0, 0, 0, '', ?, ?, 'official_expos_local'
                WHERE ${guard}
                ON CONFLICT(complex_id, exclusive_cents) DO NOTHING`,
          args: [r.complexId, ex, areaFromCents(ex), status, variants.length, r.complexId],
        });
        if (variants.length > 1) {
          const pick = pickRepresentativeSupply(variants.map((v) => ({ supplyCents: v[1], householdCount: v[2] })));
          if (pick) {
            statements.push({
              sql: `INSERT INTO apt_unit_supply_representative (
                      complex_id, exclusive_cents, representative_supply_cents, representative_household_count,
                      variant_count, variants_json, rule, updated_at
                    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?
                    WHERE ${guard}
                    ON CONFLICT(complex_id, exclusive_cents) DO NOTHING`,
              args: [r.complexId, ex, pick.representativeSupplyCents, pick.representativeHouseholdCount, pick.variants.length, JSON.stringify(pick.variants), REP_RULE, now, r.complexId],
            });
          }
        }
      }
    } else {
      const empty = existing.filter((x) => x.su === NO_SUPPLY_CENTS && x.status === "NO_SOURCE" && x.supplyNull);
      if (empty.length === 0) {
        if (existing.some((x) => x.ours)) t.alreadyDone += 1;
        else hold("NO_EMPTY_ROWS");
        continue;
      }
      for (const row of empty) {
        const variants = byEx.get(row.ex) ?? [];
        if (variants.length !== 1) {
          if (variants.length > 1) hold("G2_EXCLUSIVE_MULTI");
          continue;
        }
        const v = variants[0]!;
        const supplyArea = areaFromCents(v[1]);
        statements.push({
          sql: `UPDATE apt_canonical_unit_types
                SET supply_area = ?, supply_cents = ?, supply_pyeong = ?, display_pyeong_label = ?,
                    household_count = ?, source = 'BldRgstHubService', source_key = ?, source_as_of = '',
                    confidence = 'building_registry_expos', status = 'EXACT_SINGLE', formula = 'exclusive_plus_residential_common',
                    provenance_json = ?, updated_at = ?
                WHERE complex_id = ? AND exclusive_cents = ? AND supply_cents = ? AND status = 'NO_SOURCE' AND supply_area IS NULL`,
          args: [supplyArea, v[1], canonicalSupplyPyeong(supplyArea), supplyPyeongDisplayLabel(supplyArea), v[2], `${r.pnu}:${row.ex}:${v[1]}`, provenance(v), now, r.complexId, row.ex, NO_SUPPLY_CENTS],
        });
        statements.push({
          sql: `UPDATE apt_unit_exclusive_pairs
                SET resolution_status = 'EXACT_SINGLE', supply_variant_count = 1,
                    observed_from = CASE WHEN observed_from LIKE '%official_expos%' THEN observed_from ELSE observed_from || '+official_expos' END
                WHERE complex_id = ? AND exclusive_cents = ? AND resolution_status = 'NO_SOURCE'`,
          args: [r.complexId, row.ex],
        });
        wrote += 1;
      }
      if (wrote === 0) {
        hold("EXCLUSIVE_NOT_MATCHED");
        continue;
      }
    }
    t.write += 1;
    t.types += wrote;
    if (!t.minApproval || ap < t.minApproval) t.minApproval = ap;
    if (!t.maxApproval || ap > t.maxApproval) t.maxApproval = ap;
    const s = (bySido[r.sido || r.lawdCd.slice(0, 2)] ??= { complexes: 0, types: 0, households: 0 });
    s.complexes += 1;
    s.types += wrote;
    s.households += n.supplies.reduce((x, v) => x + v[2], 0);
    bump(lawd, r.lawdCd);
    rowsOut.push({ complexId: r.complexId, name: r.aptName, set: r.set, sido: r.sido, sigungu: r.sigungu, lawdCd: r.lawdCd, approval: ap, pnu: r.pnu, types: n.supplies.map(([e, su, h]) => [e / 100, su / 100, h]) });
  }
  const summary = { at: now, apply, minApprovalYear: MIN_APPROVAL_YEAR, recovery: CR_RECOVERY, statements: statements.length, ...t, held, bySido, lawdCodes: Object.fromEntries(Object.entries(lawd).sort()) };
  if (!apply) {
    writeFileSync(join(OUT, "apply-plan-rows.jsonl"), rowsOut.map((x) => JSON.stringify(x)).join("\n") + (rowsOut.length ? "\n" : ""));
    writeFileSync("data/poc/supply/common-rule-apply-plan.json", JSON.stringify(summary, null, 1));
    console.log(JSON.stringify({ ...summary, lawdCodes: Object.keys(lawd).length }, null, 1));
    return;
  }
  let affected = 0;
  for (const part of chunks(statements, 100)) {
    const results = await db.batch(part, "write");
    affected += results.reduce((x, res) => x + res.rowsAffected, 0);
  }
  writeFileSync(join(OUT, "apply-rows.jsonl"), rowsOut.map((x) => JSON.stringify(x)).join("\n") + (rowsOut.length ? "\n" : ""));
  writeFileSync("data/poc/supply/common-rule-apply.json", JSON.stringify({ affected, ...summary }, null, 1));
  console.log(JSON.stringify({ affected, ...summary, lawdCodes: Object.keys(lawd).length }, null, 1));
}

const [mode, arg] = process.argv.slice(2);
if (mode === "ah-targets") await applyhomeTargets();
else if (mode === "extract" && arg) await extract(arg);
else if (mode === "plan") await plan();
else if (mode === "apply-plan") await fillCommon(false);
else if (mode === "apply") await fillCommon(true);
else {
  console.error("usage: fill-common-rule.mts extract <sido2|g2> | plan | apply-plan | apply   (apply: 사용승인 2010년 이후만)");
  process.exit(1);
}
