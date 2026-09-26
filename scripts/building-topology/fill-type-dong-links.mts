/**
 * 타입·동 연결(unit_type_building_links) 빈 단지 채우기 — 건축물대장 전유공용면적(getBrExposPubuseAreaInfo) 기준.
 *
 * 대상: apt_canonical_unit_types 가 있고, 주거 동(complex_buildings residential_flag=1)이 있고,
 *       unit_type_building_links 가 한 줄도 없는 단지. (이미 연결이 있는 단지는 건드리지 않는다.)
 *
 * 정확 일치만:
 *  - 호 → 동: 전유부 dongNm 을 이 단지 주거 동 dong_label 과 같은 표기(101동=101)로만 맞춘다. 한 동에 둘 이상 걸리면 버림.
 *  - 동 검증: 그 동에 붙은 호 수 == 표제부 세대수(complex_buildings.household_count). 다르면 그 동 전체 보류.
 *  - 호 → 타입: 전용면적(0.01㎡) 일치 타입이 하나면 그 타입.
 *    같은 전용에 타입이 여럿이면 전용+주거공용(계단·승강기·복도 등) = 공급면적이 정확히 하나와 같을 때만,
 *    그리고 그 전용 묶음의 타입별 호 수가 Core household_count 와 모두 같을 때만. 아니면 묶음 전체 보류.
 *  - 추정·근사·이름 퍼지 매칭 없음. 기존 연결/타입 수정 없음 (INSERT … ON CONFLICT DO NOTHING).
 *
 *   npx tsx scripts/building-topology/fill-type-dong-links.mts --complex=cx_ec9a204afeaadf1b          # dry-run
 *   npx tsx scripts/building-topology/fill-type-dong-links.mts --complex=cx_… --apply
 *   npx tsx scripts/building-topology/fill-type-dong-links.mts --auto=200 --max-api=3000 [--sido=11] [--apply]
 *
 * 원천 응답은 --cache-dir(기본 data/poc/type-dong-links/cache, git 제외)에 지번별로 저장해 재호출하지 않는다.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient, type Client, type InStatement } from "@libsql/client";

const argv = process.argv.slice(2);
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const APPLY = argv.includes("--apply");
const COMPLEXES = (arg("complex") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const AUTO = Number(arg("auto") ?? 0);
const SIDO = arg("sido") ?? "";
const MAX_API = Number(arg("max-api") ?? 2000);
const CONCURRENCY = Math.max(1, Number(arg("concurrency") ?? 2));
const CACHE_DIR = resolve(arg("cache-dir") ?? "data/poc/type-dong-links/cache");
const REPORT = resolve(arg("report") ?? `data/poc/type-dong-links/run-${APPLY ? "apply" : "dry"}.json`);
const SOURCE = "BldRgstHubService.getBrExposPubuseAreaInfo+title";
const VERSION = "type-dong-links|expos-pubuse|exact-v1";
const PAGE = 100; // API max numOfRows

function loadEnv() {
  for (const file of [arg("env"), ".env.local", "C:/dev/ziplab/.env.local"].filter(Boolean) as string[]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
    return;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Turso 일시 오류(fetch failed 등) 재시도. 쓰기는 ON CONFLICT DO NOTHING 이라 다시 보내도 안전. */
async function retry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(2000 * i);
    }
  }
}
const cents = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round((n + 1e-9) * 100) : -1);
const round2 = (n: number) => Math.round((n + 1e-9) * 100) / 100;

export function dongMatchKey(label: string | null | undefined): string | null {
  if (!label) return null;
  const compact = label.replace(/\s+/g, "").replace(/동$/u, "");
  if (!compact) return null;
  if (/^\d+$/.test(compact)) return String(Number(compact));
  return compact;
}

type ExposRow = {
  dongNm: string;
  hoNm: string;
  flrNo: string;
  gb: string; // 전유/공용
  mainAtch: string; // 주건축물/부속건축물
  purps: string;
  etc: string;
  area: number;
  crtnDay: string;
};

type Unit = { dong: string; ho: string; floor: string; exclusive: number; resCommon: number; derivable: boolean; asOf: string };

const RES_COMMON_RE = /계단|엘리베이터|승강기|복도|현관|홀|대피소|벽체|발코니초과/;
const PARTIAL_RE = /공유면적|일부공유/;

function field(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return (m?.[1] ?? "").trim();
}

let apiCalls = 0;
let quotaHit = false;

async function fetchPage(p: Parcel, page: number): Promise<{ total: number; items: ExposRow[] }> {
  const qs = new URLSearchParams({
    serviceKey: process.env.MOLIT_API_KEY ?? "",
    sigunguCd: p.sigungu,
    bjdongCd: p.bjdong,
    platGbCd: p.plat,
    bun: p.bun,
    ji: p.ji,
    numOfRows: String(PAGE),
    pageNo: String(page),
  });
  for (let attempt = 1; ; attempt += 1) {
    if (apiCalls >= MAX_API) throw new Error("MAX_API");
    apiCalls += 1;
    try {
      const res = await fetch(`https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo?${qs}`);
      const text = await res.text();
      if (/<returnReasonCode>23</.test(text) || res.status === 429) throw new Error("RATE_PER_SECOND");
      if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS|<returnReasonCode>22</.test(text)) {
        quotaHit = true;
        throw new Error("QUOTA");
      }
      const code = field(text, "resultCode");
      if (!text.includes("<totalCount>") || (code && code !== "00")) throw new Error(`api ${res.status} code=${code}`);
      const total = Number(field(text, "totalCount") || 0);
      const items = text.split("<item>").slice(1).map((b) => ({
        dongNm: field(b, "dongNm"),
        hoNm: field(b, "hoNm"),
        flrNo: field(b, "flrNo"),
        gb: field(b, "exposPubuseGbCdNm"),
        mainAtch: field(b, "mainAtchGbCdNm"),
        purps: field(b, "mainPurpsCdNm"),
        etc: field(b, "etcPurps"),
        area: Number(field(b, "area") || 0),
        crtnDay: field(b, "crtnDay"),
      }));
      return { total, items };
    } catch (e) {
      const rate = (e as Error).message === "RATE_PER_SECOND";
      if (quotaHit || (e as Error).message === "MAX_API" || attempt >= (rate ? 10 : 5)) throw e;
      await sleep((rate ? 1500 : 500) * attempt);
    }
  }
}

type Parcel = { key: string; sigungu: string; bjdong: string; plat: string; bun: string; ji: string };

function parcelFromKey(key: string): Parcel | null {
  const [sigungu, bjdong, plat, bun, ji] = key.split("|");
  if (!/^\d{5}$/.test(sigungu ?? "") || !/^\d{5}$/.test(bjdong ?? "") || !/^[01]$/.test(plat ?? "")) return null;
  if (!/^\d{4}$/.test(bun ?? "") || !/^\d{4}$/.test(ji ?? "")) return null;
  return { key, sigungu, bjdong, plat, bun, ji };
}

async function loadParcelRows(p: Parcel): Promise<ExposRow[] | null> {
  const file = join(CACHE_DIR, `${p.key.replaceAll("|", "_")}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).items as ExposRow[];
  const first = await fetchPage(p, 1);
  const pages = Math.ceil(first.total / PAGE);
  if (pages > 0 && apiCalls + pages - 1 > MAX_API) throw new Error("MAX_API");
  const byPage = new Map<number, ExposRow[]>([[1, first.items]]);
  let next = 2;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(0, pages - 1)) }, async () => {
      while (next <= pages) {
        const page = next++;
        byPage.set(page, (await fetchPage(p, page)).items);
      }
    }),
  );
  const items: ExposRow[] = [];
  for (let i = 1; i <= Math.max(1, pages); i += 1) items.push(...(byPage.get(i) ?? []));
  if (items.length !== first.total) throw new Error(`row count ${items.length} != total ${first.total}`);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ parcel: p.key, fetchedAt: new Date().toISOString(), total: first.total, items }));
  return items;
}

function unitIdentity(r: ExposRow): { dong: string; ho: string } | null {
  let dong = r.dongNm.trim();
  let ho = r.hoNm.trim();
  const combined = !dong ? /^(\S+동)\s+(\S+)$/.exec(ho) : null;
  if (combined) {
    dong = combined[1];
    ho = combined[2];
  }
  if (!dong || !ho) return null;
  return { dong, ho };
}

function buildUnits(rows: ExposRow[]): Unit[] {
  const byUnit = new Map<string, ExposRow[]>();
  for (const r of rows) {
    const id = unitIdentity(r);
    if (!id) continue;
    const k = `${id.dong}\t${id.ho}`;
    const list = byUnit.get(k);
    if (list) list.push(r);
    else byUnit.set(k, [r]);
  }
  const units: Unit[] = [];
  for (const [k, g] of byUnit) {
    const [dong, ho] = k.split("\t");
    const exAll = g.filter((r) => r.gb === "전유" && r.mainAtch === "주건축물" && r.purps === "아파트");
    if (!exAll.length) continue;
    // 같은 층·같은 면적 전유 행이 반복되면 같은 행의 중복으로 보고 하나만 쓴다.
    // 면적이나 층이 다른 전유 행이 여럿(복층 등)이면 합산하지 않고 이 호를 판정 불가로 둔다.
    const exKeys = new Set(exAll.map((r) => `${r.flrNo}	${cents(r.area)}`));
    if (exKeys.size > 1) {
      units.push({ dong, ho, floor: exAll[0].flrNo, exclusive: -1, resCommon: 0, derivable: false, asOf: "" });
      continue;
    }
    const ex = [exAll[0]];
    const partial = ex.some((r) => PARTIAL_RE.test(r.etc));
    const dupCommon = exAll.length > 1;
    const seenCommon = new Set<string>();
    const mainCommon = g.filter((r) => {
      if (r.gb !== "공용" || r.mainAtch !== "주건축물") return false;
      if (!dupCommon) return true;
      const k = `${r.etc}	${cents(r.area)}`;
      if (seenCommon.has(k)) return false;
      seenCommon.add(k);
      return true;
    });
    const res = mainCommon.filter((r) => RES_COMMON_RE.test(r.etc) || (!partial && r.etc.trim() === ""));
    const unknown = mainCommon.length - res.length;
    const exclusive = round2(ex.reduce((s, r) => s + r.area, 0));
    const resCommon = round2(res.reduce((s, r) => s + r.area, 0));
    units.push({
      dong,
      ho,
      floor: ex[0].flrNo,
      exclusive,
      resCommon,
      derivable: exclusive > 0 && !partial && resCommon > 0 && unknown === 0,
      asOf: g.map((r) => r.crtnDay).sort().at(-1) ?? "",
    });
  }
  return units;
}

type Type = { id: string; ex: number; su: number; hh: number | null };
type Building = { id: string; label: string; hh: number | null };
type Link = { complexId: string; unitTypeId: string; buildingId: string; household: number; asOf: string; resolution: string };

type Outcome = {
  complexId: string;
  name: string;
  status: string;
  units?: number;
  buildingsOk?: number;
  buildingsHeld?: number;
  unitsLinked?: number;
  typesLinked?: number;
  types?: number;
  links?: Link[];
  holds?: Record<string, number>;
  detail?: string;
};

function resolveComplex(complexId: string, name: string, units: Unit[], types: Type[], buildings: Building[]): Outcome {
  const holds: Record<string, number> = {};
  const hold = (k: string, n = 1) => (holds[k] = (holds[k] ?? 0) + n);
  const byDong = new Map<string, Building[]>();
  for (const b of buildings) {
    const k = dongMatchKey(b.label);
    if (!k) continue;
    byDong.set(k, [...(byDong.get(k) ?? []), b]);
  }
  // 호 → 동
  const unitsByBuilding = new Map<string, Unit[]>();
  for (const u of units) {
    const k = dongMatchKey(u.dong);
    const hits = k ? byDong.get(k) ?? [] : [];
    if (hits.length !== 1) {
      hold(hits.length ? "AMBIGUOUS_BUILDING" : "NO_BUILDING");
      continue;
    }
    unitsByBuilding.set(hits[0].id, [...(unitsByBuilding.get(hits[0].id) ?? []), u]);
  }
  // 동 검증: 호 수 == 표제부 세대수
  const okUnits: Array<{ u: Unit; b: string }> = [];
  let buildingsOk = 0;
  let buildingsHeld = 0;
  for (const b of buildings) {
    const list = unitsByBuilding.get(b.id) ?? [];
    if (!list.length) continue;
    if (b.hh == null || b.hh <= 0 || list.length !== b.hh) {
      buildingsHeld += 1;
      hold("BUILDING_COUNT_MISMATCH", list.length);
      continue;
    }
    buildingsOk += 1;
    for (const u of list) okUnits.push({ u, b: b.id });
  }
  // 단지 단위 완결성: 동 하나라도 보류되거나 동을 못 찾은 호가 있으면 타입별 동 목록이 빠진다 — 단지 전체 보류
  const multi = units.filter((u) => u.exclusive < 0).length;
  if (multi) hold("MULTI_EXCLUSIVE_ROWS", multi);
  const unmapped = (holds.NO_BUILDING ?? 0) + (holds.AMBIGUOUS_BUILDING ?? 0) + multi;
  if (buildingsHeld > 0 || unmapped > 0) {
    return {
      complexId, name, status: "HELD_INCOMPLETE", units: units.length, buildingsOk, buildingsHeld,
      unitsLinked: 0, typesLinked: 0, types: types.length, links: [], holds,
    };
  }
  // 호 → 타입
  const typesByEx = new Map<number, Type[]>();
  for (const t of types) typesByEx.set(t.ex, [...(typesByEx.get(t.ex) ?? []), t]);
  const assigned: Array<{ t: string; b: string; ex: number; asOf: string; resolution: string }> = [];
  for (const { u, b } of okUnits) {
    const ex = cents(u.exclusive);
    const cand = typesByEx.get(ex) ?? [];
    if (cand.length === 0) {
      hold("NO_CANONICAL_TYPE");
      continue;
    }
    if (cand.length === 1) {
      assigned.push({ t: cand[0].id, b, ex, asOf: u.asOf, resolution: "EXCLUSIVE_UNIQUE" });
      continue;
    }
    if (!u.derivable) {
      hold("VARIANT_NOT_DERIVABLE");
      assigned.push({ t: "", b, ex, asOf: u.asOf, resolution: "HOLD" });
      continue;
    }
    const su = cents(u.exclusive + u.resCommon);
    const m = cand.filter((t) => t.su === su);
    if (m.length !== 1) {
      hold("VARIANT_SUPPLY_NO_MATCH");
      assigned.push({ t: "", b, ex, asOf: u.asOf, resolution: "HOLD" });
      continue;
    }
    assigned.push({ t: m[0].id, b, ex, asOf: u.asOf, resolution: "EXCLUSIVE_PLUS_SUPPLY" });
  }
  // 변형 묶음 검증: 같은 전용의 모든 호가 풀리고, 타입별 호 수 == Core 세대수일 때만
  const badEx = new Set<number>();
  for (const [ex, cand] of typesByEx) {
    if (cand.length < 2) continue;
    const rows = assigned.filter((a) => a.ex === ex);
    if (!rows.length) continue;
    const unresolved = rows.some((a) => !a.t);
    const countOk = cand.every((t) => t.hh != null && rows.filter((a) => a.t === t.id).length === t.hh);
    if (unresolved || !countOk || buildingsHeld > 0) {
      badEx.add(ex);
      hold("VARIANT_GROUP_HELD", rows.filter((a) => a.t).length);
    }
  }
  const agg = new Map<string, Link>();
  for (const a of assigned) {
    if (!a.t || badEx.has(a.ex)) continue;
    const k = `${a.t}\t${a.b}`;
    const cur = agg.get(k);
    if (cur) {
      cur.household += 1;
      if (a.asOf > cur.asOf) cur.asOf = a.asOf;
    } else agg.set(k, { complexId, unitTypeId: a.t, buildingId: a.b, household: 1, asOf: a.asOf, resolution: a.resolution });
  }
  const links = [...agg.values()];
  return {
    complexId,
    name,
    status: links.length ? "LINKS" : "NO_EXACT_LINKS",
    units: units.length,
    buildingsOk,
    buildingsHeld,
    unitsLinked: links.reduce((s, l) => s + l.household, 0),
    typesLinked: new Set(links.map((l) => l.unitTypeId)).size,
    types: types.length,
    links,
    holds,
  };
}

function cachedCount(): number {
  return existsSync(CACHE_DIR) ? readdirSync(CACHE_DIR).length : 0;
}

async function pickTargets(db: Client): Promise<string[]> {
  if (COMPLEXES.length) return COMPLEXES;
  const res = await db.execute({
    sql: `SELECT t.complex_id, c.parcel_key FROM (SELECT DISTINCT complex_id FROM apt_canonical_unit_types) t
          JOIN apt_complex_master m ON m.complex_id = t.complex_id
          JOIN complex_building_checkpoint c ON c.complex_id = t.complex_id AND c.parcel_key <> ''
          WHERE NOT EXISTS (SELECT 1 FROM unit_type_building_links l WHERE l.complex_id = t.complex_id)
            AND EXISTS (SELECT 1 FROM complex_buildings b WHERE b.complex_id = t.complex_id AND b.residential_flag = 1
                        AND COALESCE(TRIM(b.dong_label), '') <> '')
            AND (? = '' OR m.sido_code = ?)
          ORDER BY t.complex_id LIMIT ?`,
    args: [SIDO, SIDO, AUTO * 4 + cachedCount()],
  });
  // --auto: 이미 원천을 받아 판정한 지번(캐시 있음)은 건너뛴다 — 보류 단지를 매 배치 다시 읽지 않게.
  return res.rows
    .filter((r) => !existsSync(join(CACHE_DIR, `${String(r.parcel_key).replaceAll("|", "_")}.json`)))
    .map((r) => String(r.complex_id));
}

async function main() {
  loadEnv();
  if (!process.env.MOLIT_API_KEY) throw new Error("MOLIT_API_KEY missing");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const targets = await retry(() => pickTargets(db));
  const outcomes: Outcome[] = [];
  let processed = 0;
  for (const complexId of targets) {
    if (AUTO && processed >= AUTO) break;
    if (quotaHit || apiCalls >= MAX_API) break;
    const [meta, typesRes, bRes, linkRes, mineRes] = await retry(() => db.batch(
      [
        {
          sql: `SELECT m.apt_name, c.parcel_key FROM apt_complex_master m
                LEFT JOIN complex_building_checkpoint c ON c.complex_id = m.complex_id WHERE m.complex_id = ?`,
          args: [complexId],
        },
        {
          sql: `SELECT unit_type_id, exclusive_cents, supply_cents, household_count FROM apt_canonical_unit_types WHERE complex_id = ?`,
          args: [complexId],
        },
        {
          sql: `SELECT building_id, dong_label, household_count FROM complex_buildings WHERE complex_id = ? AND residential_flag = 1`,
          args: [complexId],
        },
        {
          // 다른 원천 연결이 있는 단지만 건너뛴다. 이 스크립트가 넣은 단지는 다시 계산해 빠진 줄만 넣는다(재실행 검증).
          sql: `SELECT COUNT(*) n FROM unit_type_building_links WHERE complex_id = ? AND source <> ?`,
          args: [complexId, SOURCE],
        },
        {
          sql: `SELECT unit_type_id, building_id FROM unit_type_building_links WHERE complex_id = ? AND source = ?`,
          args: [complexId, SOURCE],
        },
      ],
      "read",
    ));
    const name = String(meta.rows[0]?.apt_name ?? "");
    if (Number(linkRes.rows[0]?.n ?? 0) > 0) {
      outcomes.push({ complexId, name, status: "SKIP_HAS_LINKS" });
      continue;
    }
    // 동 이름이 있는 주거 동이 없으면 화면에 보일 타입·동이 없다 — API 쓰지 않음
    if (!bRes.rows.some((r) => String(r.dong_label ?? "").trim() !== "")) {
      outcomes.push({ complexId, name, status: "SKIP_NO_DONG_LABEL" });
      continue;
    }
    const parcel = parcelFromKey(String(meta.rows[0]?.parcel_key ?? ""));
    if (!parcel) {
      outcomes.push({ complexId, name, status: "NO_PARCEL" });
      continue;
    }
    let rows: ExposRow[] | null;
    try {
      rows = await loadParcelRows(parcel);
    } catch (e) {
      outcomes.push({ complexId, name, status: "API_STOP", detail: (e as Error).message });
      if (quotaHit || (e as Error).message === "MAX_API") break;
      continue;
    }
    processed += 1;
    const units = buildUnits(rows ?? []);
    if (!units.length) {
      outcomes.push({ complexId, name, status: "NO_UNIT_ROWS" });
      continue;
    }
    const types: Type[] = typesRes.rows.map((r) => ({
      id: String(r.unit_type_id),
      ex: Number(r.exclusive_cents),
      su: Number(r.supply_cents),
      hh: r.household_count == null ? null : Number(r.household_count),
    }));
    const buildings: Building[] = bRes.rows.map((r) => ({
      id: String(r.building_id),
      label: String(r.dong_label ?? ""),
      hh: r.household_count == null ? null : Number(r.household_count),
    }));
    const o = resolveComplex(complexId, name, units, types, buildings);
    const mine = new Set(mineRes.rows.map((r) => `${r.unit_type_id}	${r.building_id}`));
    if (mine.size) {
      const before = o.links?.length ?? 0;
      o.links = (o.links ?? []).filter((l) => !mine.has(`${l.unitTypeId}	${l.buildingId}`));
      o.status = o.links.length ? "LINKS_MISSING_ROWS" : before ? "COMPLETE" : o.status;
    }
    outcomes.push(o);
    console.error(
      `${complexId} ${name} ${o.status} units=${o.units} bOk=${o.buildingsOk} bHeld=${o.buildingsHeld} linked=${o.unitsLinked} types=${o.typesLinked}/${o.types} links=${o.links?.length} api=${apiCalls}`,
    );
  }

  const links = outcomes.flatMap((o) => o.links ?? []);
  let inserted = 0;
  if (APPLY && links.length) {
    const ts = new Date().toISOString();
    const stmts: InStatement[] = links.map((l) => ({
      sql: `INSERT INTO unit_type_building_links (
              complex_id, unit_type_id, building_id, household_count, source, source_key,
              confidence, status, source_as_of, provenance_json, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, 'exact', 'EXACT', ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM unit_type_building_links x WHERE x.complex_id = ? AND x.source <> ?)
            ON CONFLICT DO NOTHING`,
      args: [
        l.complexId,
        l.unitTypeId,
        l.buildingId,
        l.household,
        SOURCE,
        `${l.buildingId}:${l.unitTypeId}`,
        l.asOf,
        JSON.stringify({ resolutionStatus: l.resolution, version: VERSION }),
        ts,
        ts,
        l.complexId,
        SOURCE,
      ],
    }));
    for (let i = 0; i < stmts.length; i += 100) {
      const res = await retry(() => db.batch(stmts.slice(i, i + 100), "write"));
      inserted += res.reduce((s, r) => s + r.rowsAffected, 0);
    }
  }

  const byStatus: Record<string, number> = {};
  const holds: Record<string, number> = {};
  for (const o of outcomes) {
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    for (const [k, v] of Object.entries(o.holds ?? {})) holds[k] = (holds[k] ?? 0) + v;
  }
  const report = {
    apply: APPLY,
    at: new Date().toISOString(),
    apiCalls,
    quotaHit,
    targets: outcomes.length,
    byStatus,
    holds,
    complexesWithLinks: outcomes.filter((o) => o.links?.length).length,
    links: links.length,
    households: links.reduce((s, l) => s + l.household, 0),
    inserted,
    complexes: outcomes.map(({ links: ls, ...rest }) => ({ ...rest, links: ls?.length ?? 0 })),
    linkRows: links,
  };
  mkdirSync(resolve(REPORT, ".."), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 1));
  const { complexes: _c, linkRows: _l, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
