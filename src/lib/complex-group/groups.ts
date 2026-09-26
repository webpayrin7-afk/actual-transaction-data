/**
 * 단지 묶음(complex group) 읽기 — 국토부 원자료가 지번별로 쪼갠 같은 단지("용산파크타워(24-0)", "(24-1)")를 한 단지로.
 * 표: complex_group / complex_group_member (src/lib/db/migrations/20261004_complex_group.sql).
 * 묶음은 몇 개뿐이라 한 번에 다 읽어 인스턴스 메모리에 둔다 (10분). 표가 없거나 읽기 실패면 빈 묶음 — 예전과 같이 동작.
 */
import type { Client } from "@libsql/client";

export type ComplexGroupMember = {
  complexId: string;
  role: "PRIMARY" | "MEMBER";
  aptName: string;
  aptNameNorm: string;
  lawdCd: string;
};

export type ComplexGroup = {
  groupId: string;
  primaryComplexId: string;
  displayName: string;
  lawdCd: string;
  householdCount: number | null;
  anchor: { lat: number; lng: number } | null;
  members: ComplexGroupMember[];
};

export type ComplexGroupIndex = {
  groups: ComplexGroup[];
  byComplexId: Map<string, ComplexGroup>;
  /** `${lawd_cd}|${apt_name_norm}` → 묶음 */
  byLawdNorm: Map<string, ComplexGroup>;
};

const TTL_MS = 10 * 60_000;
const EMPTY: ComplexGroupIndex = { groups: [], byComplexId: new Map(), byLawdNorm: new Map() };
let cached: { at: number; index: ComplexGroupIndex } | null = null;
let inflight: Promise<ComplexGroupIndex> | null = null;

async function load(db: Client): Promise<ComplexGroupIndex> {
  const r = await db.execute(
    `SELECT g.group_id, g.primary_complex_id, g.display_name, g.lawd_cd, g.household_count, g.anchor_lat, g.anchor_lng,
            gm.complex_id, gm.role, m.apt_name, m.apt_name_norm, m.lawd_cd AS m_lawd
     FROM complex_group g
     JOIN complex_group_member gm ON gm.group_id = g.group_id
     JOIN apt_complex_master m ON m.complex_id = gm.complex_id`,
  );
  const byId = new Map<string, ComplexGroup>();
  for (const row of r.rows) {
    const gid = String(row.group_id);
    let g = byId.get(gid);
    if (!g) {
      const lat = row.anchor_lat == null ? NaN : Number(row.anchor_lat);
      const lng = row.anchor_lng == null ? NaN : Number(row.anchor_lng);
      g = {
        groupId: gid,
        primaryComplexId: String(row.primary_complex_id),
        displayName: String(row.display_name),
        lawdCd: String(row.lawd_cd),
        householdCount: row.household_count == null ? null : Number(row.household_count),
        anchor: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
        members: [],
      };
      byId.set(gid, g);
    }
    g.members.push({
      complexId: String(row.complex_id),
      role: String(row.role) === "PRIMARY" ? "PRIMARY" : "MEMBER",
      aptName: String(row.apt_name),
      aptNameNorm: String(row.apt_name_norm),
      lawdCd: String(row.m_lawd),
    });
  }
  const index: ComplexGroupIndex = { groups: [...byId.values()], byComplexId: new Map(), byLawdNorm: new Map() };
  for (const g of index.groups) {
    // 대표가 먼저
    g.members.sort((a, b) => Number(b.role === "PRIMARY") - Number(a.role === "PRIMARY"));
    for (const m of g.members) {
      index.byComplexId.set(m.complexId, g);
      index.byLawdNorm.set(`${m.lawdCd}|${m.aptNameNorm}`, g);
    }
  }
  return index;
}

/** 모든 묶음 (인스턴스 캐시 10분). 표가 없거나 읽기 실패면 빈 묶음. */
export async function loadComplexGroupIndex(db: Client): Promise<ComplexGroupIndex> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.index;
  if (inflight) return inflight;
  inflight = load(db)
    .catch((error: unknown) => {
      if (!/no such table/i.test(String(error))) console.warn("[complex-group] read failed:", error);
      return EMPTY;
    })
    .then((index) => {
      cached = { at: Date.now(), index };
      return index;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 이 단지(lawd + 실거래 단지명)가 묶음에 들면 멤버 전체 실거래 단지명, 아니면 [aptNameNorm]. */
export function groupTxNorms(index: ComplexGroupIndex, lawdCodes: string[], aptNameNorm: string): string[] {
  for (const lawd of lawdCodes) {
    const g = index.byLawdNorm.get(`${lawd}|${aptNameNorm}`);
    if (g) return [...new Set([aptNameNorm, ...g.members.map((m) => m.aptNameNorm)])];
  }
  return [aptNameNorm];
}

/**
 * 묶음 멤버 단지 번호 하위 질의 — `complex_id IN (${groupIdsSql})`, 인자 [complexId, complexId].
 * 묶음이 없으면 자기 자신만. (complex_group_member PK·idx_cgm_group)
 */
export const GROUP_IDS_SQL = `SELECT ? UNION SELECT o.complex_id FROM complex_group_member me
  JOIN complex_group_member o ON o.group_id = me.group_id WHERE me.complex_id = ?`;

/** 묶음 멤버 단지 번호 (자기 포함, 대표 먼저). 표가 없으면 [complexId]. */
export async function groupMemberIds(db: Client, complexId: string): Promise<string[]> {
  const g = (await loadComplexGroupIndex(db)).byComplexId.get(complexId);
  return g ? g.members.map((m) => m.complexId) : [complexId];
}

/** 멤버(대표 아님) 단지면 대표 단지 번호, 아니면 null */
export async function groupPrimaryOf(db: Client, complexId: string): Promise<string | null> {
  const g = (await loadComplexGroupIndex(db)).byComplexId.get(complexId);
  return g && g.primaryComplexId !== complexId ? g.primaryComplexId : null;
}

/** 묶음 멤버의 실거래 단지명(마스터 이름 + MOLIT 연결) 읽기 문장 — txNameLinksStatement 와 같은 모양(source_key) */
export function groupTxNameLinksSql(): string {
  return `SELECT m.lawd_cd || '|' || m.apt_name_norm AS source_key
          FROM complex_group_member me
          JOIN complex_group_member o ON o.group_id = me.group_id AND o.complex_id <> me.complex_id
          JOIN apt_complex_master m ON m.complex_id = o.complex_id
          WHERE me.complex_id = ?
          UNION
          SELECT l.source_key FROM complex_group_member me
          JOIN complex_group_member o ON o.group_id = me.group_id AND o.complex_id <> me.complex_id
          JOIN apt_complex_source_links l ON l.complex_id = o.complex_id AND l.source = 'MOLIT'
          WHERE me.complex_id = ?`;
}

/**
 * 상세 URL 이름(/apt/[name])이 묶음 멤버(대표 아님)면 대표 단지 이름, 아니면 null — 멤버 URL 을 대표로 308 보낼 때.
 * 이름 비교는 transactions.apt_name_norm 과 같은 규칙(공백 제거 + 소문자).
 */
export async function groupPrimaryNameFor(db: Client, lawdCodes: string[], aptName: string): Promise<string | null> {
  const norm = aptName.replace(/\s+/g, "").toLowerCase();
  if (!norm) return null;
  const index = await loadComplexGroupIndex(db);
  for (const lawd of lawdCodes) {
    const g = index.byLawdNorm.get(`${lawd}|${norm}`);
    if (!g) continue;
    const self = g.members.find((m) => m.lawdCd === lawd && m.aptNameNorm === norm);
    if (!self || self.role === "PRIMARY") return null;
    return g.members.find((m) => m.role === "PRIMARY")?.aptName ?? null;
  }
  return null;
}

/** 멤버 상세 URL → 대표 상세 URL (쿼리 그대로). `suffix` 는 "/transactions" 같은 하위 경로 */
export function groupRedirectHref(
  primaryName: string,
  suffix: string,
  searchParams: Record<string, string | string[] | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (Array.isArray(v)) for (const x of v) qs.append(k, x);
    else if (v != null) qs.set(k, v);
  }
  const q = qs.toString();
  return `/apt/${encodeURIComponent(primaryName)}${suffix}${q ? `?${q}` : ""}`;
}

