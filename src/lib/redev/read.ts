/**
 * 서울 정비사업 (재개발·재건축) — 읽기 전용.
 * 원천: 서울시 UPIS 의제처리구역(redev_zones, 2026-09) · 서울시 정비사업 추진현황(redev_projects, 2026-06-30 기준)
 * · 연결(redev_links: 사업↔구역 = 구역명 정확 일치 또는 지번 좌표가 들어간 구역 1개, 단지↔구역 = 단지 좌표가 구역 안).
 * 값은 원천 그대로. 표가 없으면 빈 결과.
 */
import type { Client } from "@libsql/client";

/** 정비사업 성격의 구역만 (토지구획정리·택지개발 같은 옛 개발지구는 뺀다) */
export const REDEV_ZONE_CATEGORIES = [
  "UQ1206", // 주택재건축사업
  "UQ1211", // 주거환경개선사업
  "UQ1212", // 주거환경관리사업
  "UQ1220", // 재개발사업구역
  "UQ1221", // 주택정비형 재개발구역
  "UQ1222", // 도시정비형 재개발구역
  "UQ1231", // 주택정비형 재개발지구
  "UQ1232", // 도시정비형 재개발지구
  "UQ1240", // 재건축사업구역
  "UQ1250", // 결합정비구역
  "UQ5110", // 주거지형재정비촉진지구
  "UQ5120", // 중심지형재정비촉진지구
  "UQ5140", // 존치정비구역
  "UQ6400", // 시장정비구역
] as const;

/** 사업 단계 (추진현황 표의 순서) */
export const REDEV_STAGES = ["구역지정", "추진위", "조합설립", "건축심의", "사업시행", "관리처분", "이주", "착공"] as const;
export type RedevStage = (typeof REDEV_STAGES)[number];

export type RedevProject = {
  code: string;
  gu: string;
  zoneName: string;
  projectType: string | null;
  /** "재건축" | "재개발" | 원천 유형 */
  kind: "재건축" | "재개발" | "기타";
  stage: string | null;
  stageIndex: number;
  publicPrivate: string | null;
  districtType: string | null;
  householdsBefore: number | null;
  householdsTotal: number | null;
  householdsSale: number | null;
  householdsRent: number | null;
  /** 단계별 날짜 (가장 최근 값 — 변경이 있으면 변경일) */
  dates: Array<{ stage: RedevStage; date: string | null }>;
  baseDate: string;
};

export type RedevZone = {
  zoneId: string;
  name: string;
  category: string | null;
  gu: string | null;
  noticeDate: string | null;
  lat: number;
  lng: number;
};

export type ComplexRedev = { zone: RedevZone; project: RedevProject | null };

const str = (v: unknown) => (v == null || v === "" ? null : String(v));
const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function kindOf(projectType: string | null): RedevProject["kind"] {
  if (!projectType) return "기타";
  if (projectType.includes("재건축")) return "재건축";
  if (projectType.includes("재개발")) return "재개발";
  return "기타";
}

function toProject(r: Record<string, unknown>): RedevProject {
  const stage = str(r.stage);
  const d = (a: unknown, b?: unknown) => str(b) ?? str(a);
  return {
    code: String(r.code),
    gu: String(r.gu),
    zoneName: String(r.zone_name),
    projectType: str(r.project_type),
    kind: kindOf(str(r.project_type)),
    stage,
    stageIndex: stage ? REDEV_STAGES.indexOf(stage as RedevStage) : -1,
    publicPrivate: str(r.public_private),
    districtType: str(r.district_type),
    householdsBefore: num(r.households_before),
    householdsTotal: num(r.households_total),
    householdsSale: num(r.households_sale),
    householdsRent: num(r.households_rent),
    dates: [
      { stage: "구역지정", date: d(r.zone_designated_first, r.zone_designated_last) },
      { stage: "추진위", date: str(r.committee_approved) },
      { stage: "조합설립", date: str(r.association_approved) },
      { stage: "건축심의", date: str(r.building_review) },
      { stage: "사업시행", date: d(r.project_approved_first, r.project_approved_last) },
      { stage: "관리처분", date: d(r.disposal_approved_first, r.disposal_approved_last) },
      { stage: "이주", date: str(r.relocation_start) },
      { stage: "착공", date: str(r.construction_start) },
    ],
    baseDate: String(r.base_date),
  };
}

function toZone(r: Record<string, unknown>): RedevZone {
  return {
    zoneId: String(r.zone_id),
    name: String(r.name),
    category: str(r.category_name),
    gu: str(r.gu),
    noticeDate: str(r.notice_date),
    lat: Number(r.lat),
    lng: Number(r.lng),
  };
}

const CAT_SQL = REDEV_ZONE_CATEGORIES.map((c) => `'${c}'`).join(",");

/** 여러 동네를 한꺼번에 묶는 넓은 촉진지구 (한 단지의 사업이 아니다) */
const DISTRICT_CATEGORIES = new Set(["UQ5110", "UQ5120"]);

/** "19790830" · "1979-08-30" · "1979.08.30" → "1979-08-30" (못 읽으면 null) */
export function normDate(v: unknown): string | null {
  const s = String(v ?? "").replace(/[^0-9]/g, "");
  if (s.length < 8) return null;
  const y = Number(s.slice(0, 4));
  return y >= 1900 && y <= 2100 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

const yearOf = (d: string) => Number(d.slice(0, 4));

/** 구역 ID 의 등록일 ("11000UQ181PS201912150617" → 2019-12-15). 고시일은 이 날보다 늦을 수 없어 고시일이 빈 구역의 상한으로 쓴다. */
export function zoneRegisteredDate(zoneId: string): string | null {
  const m = /PS(\d{8})/.exec(zoneId);
  return m ? normDate(m[1]) : null;
}

/** 구역 이름의 뼈대 — "가락시영아파트주택재건축사업" 과 "가락시영아파트 주택재건축 정비구역" 을 같은 구역으로 본다 */
export function zoneBaseName(name: string): string {
  return name
    .replace(/[\s·.,_()\-]/g, "")
    .replace(/(주택)?(재건축|재개발)(정비)?(사업)?(정비)?(구역|지구)?/g, "")
    .replace(/(정비사업|정비구역|정비|사업구역|사업|구역|지구)$/g, "")
    .replace(/아파트/g, "");
}

export type ZoneStatus = "completed" | "active" | "unknown";

export type ZoneStatusInput = {
  zone: { zoneId: string; name: string; categoryCode: string | null; noticeDate: string | null };
  project: RedevProject | null;
  complex: { approvalDate: string | null; buildYear: number | null; households: number | null };
};

/**
 * 단지와 구역의 관계를 날짜로 가른다.
 * - completed: 이 단지가 그 구역 사업으로 새로 지은 단지 (또는 너무 새 단지라 그 구역의 정비 대상이 아니다)
 * - active: 지금 있는 옛 단지에 걸린 구역 (예: 은마, 잠실주공5단지)
 * - unknown: 날짜가 없어 가를 수 없다 → 보여 준다
 * 고시일이 비면 구역 ID 의 등록일(고시일의 상한)로 대신한다 — 상한이라 '끝남' 쪽으로는 덜 가른다.
 * 구역 고시일(notice_date)은 '가장 최근 고시'라 준공 뒤의 변경·이전 고시일 수 있다 (예: 가락시영 2019-01-03, 헬리오시티 사용승인 2018-12-28).
 */
export function classifyComplexZone({ zone, project, complex }: ZoneStatusInput): { status: ZoneStatus; reason: string } {
  const built = complex.approvalDate; // YYYY-MM-DD
  const builtYear = built ? yearOf(built) : complex.buildYear;
  const notice = zone.noticeDate ?? zoneRegisteredDate(zone.zoneId);
  const cat = zone.categoryCode ?? "";
  const bigEnough = (complex.households ?? 0) >= 100;
  if (builtYear == null) return { status: "unknown", reason: "no-build-date" };

  // 1) 구역 고시 뒤에 사용승인 → 그 구역 사업으로 새로 지은 단지 (예: 래미안원베일리, 올림픽파크포레온)
  //    같은 이름의 새 사업(예: 새 아현1구역)이 옛 구역에 이름으로 붙어 있어도 이 단지는 옛 사업의 결과다
  if (notice && (built ? built > notice : builtYear > yearOf(notice))) {
    return { status: "completed", reason: "built-after-notice" };
  }
  // 2) 사업 추진현황이 있으면 그 사업이 걸린 옛 단지다 — 새 단지는 착공 뒤에만 생긴다
  //    (사업 시작 뒤 지은 작은 빌라도 재개발 철거 대상이라 착공일 뒤 사용승인만 '끝남'으로 본다)
  if (project) {
    const construction = normDate(project.dates.find((d) => d.stage === "착공")?.date);
    if (construction && (built ? built > construction : builtYear > yearOf(construction))) {
      return { status: "completed", reason: "built-after-construction-start" };
    }
    return { status: "active", reason: "project-in-progress" };
  }
  if (!notice) return { status: "unknown", reason: "no-notice-date" };

  const gapYears = yearOf(notice) - builtYear;
  // 3) 사용승인 직후(3년 안) 고시 → 준공 뒤 변경·이전 고시. 넓은 촉진지구는 100세대 이상 단지만 (촉진지구 안 새 빌라는 철거 대상일 수 있다)
  if (gapYears <= 3 && (!DISTRICT_CATEGORIES.has(cat) || bigEnough)) {
    return { status: "completed", reason: "notice-right-after-completion" };
  }
  // 4) 고시 때 새 아파트(100세대 이상)는 정비 대상이 아니다 — 그 구역·촉진지구 안에서 이미 새로 지은 단지이거나 존치 단지.
  //    한 사업 구역은 준공 20년 미만, 여러 동네를 묶는 촉진지구는 재건축 연한인 30년 미만 (예: 길음뉴타운 2005년 단지 ↔ 길음촉진지구 2026 고시)
  if (bigEnough && gapYears < (DISTRICT_CATEGORIES.has(cat) ? 30 : 20)) {
    return { status: "completed", reason: "too-new-to-be-target" };
  }

  return { status: "active", reason: "built-before-notice" };
}

type ComplexFacts = ZoneStatusInput["complex"];

async function readComplexFacts(db: Client, complexId: string): Promise<ComplexFacts> {
  const r = await db
    .execute({
      sql: `SELECT p.approval_date, p.household_count, m.lawd_cd, m.apt_name_norm
            FROM apt_complex_master m LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
            WHERE m.complex_id = ?`,
      args: [complexId],
    })
    .catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const row = r.rows[0] as Record<string, unknown> | undefined;
  const facts: ComplexFacts = {
    approvalDate: normDate(row?.approval_date),
    buildYear: null,
    households: num(row?.household_count),
  };
  // 사용승인일이 없으면 최근 실거래 건축년도(최근 200건, 인덱스 범위만)로 대신한다
  if (!facts.approvalDate && row?.lawd_cd && row?.apt_name_norm) {
    const t = await db
      .execute({
        sql: `SELECT MIN(build_year) AS y FROM (
                SELECT build_year FROM transactions INDEXED BY idx_tx_lawd_apt_ym
                WHERE lawd_cd = ? AND apt_name_norm = ? ORDER BY year_month DESC LIMIT 200
              ) WHERE build_year > 1900`,
        args: [String(row.lawd_cd), String(row.apt_name_norm)],
      })
      .catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
    facts.buildYear = num(t.rows[0]?.y);
  }
  return facts;
}

/** 단지가 들어간 정비 구역과 (있으면) 사업 단계. 사업 단계가 있는 것이 앞. 이미 끝난(이 단지를 지은) 구역은 뺀다. */
export async function readComplexRedev(db: Client, complexId: string): Promise<ComplexRedev[]> {
  try {
    const res = await db.execute({
      sql: `SELECT z.zone_id, z.name, z.category_code, z.category_name, z.gu, z.notice_date, z.lat, z.lng, p.*
            FROM redev_links l
            JOIN redev_zones z ON z.zone_id = l.zone_id AND z.category_code IN (${CAT_SQL})
            LEFT JOIN redev_links pl ON pl.kind = 'project_zone' AND pl.zone_id = z.zone_id
            LEFT JOIN redev_projects p ON p.code = pl.ref_id
            WHERE l.kind = 'complex_zone' AND l.ref_id = ?`,
      args: [complexId],
    });
    if (res.rows.length === 0) return [];
    const rows = res.rows.map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return {
        item: { zone: toZone(row), project: row.code != null ? toProject(row) : null } as ComplexRedev,
        categoryCode: str(row.category_code),
      };
    });
    const complex = await readComplexFacts(db, complexId);
    return filterFinishedZones(rows, complex).sort((a, b) => Number(!!b.project) - Number(!!a.project));
  } catch {
    return [];
  }
}

/** 끝난 구역 빼기 — 같은 이름 뼈대의 구역 하나가 끝났으면 (준공 뒤 변경 고시로 날짜만 늦은) 나머지도 끝난 것으로 본다 */
export function filterFinishedZones(
  rows: Array<{ item: ComplexRedev; categoryCode: string | null }>,
  complex: ComplexFacts,
): ComplexRedev[] {
  const status = rows.map(
    ({ item, categoryCode }) =>
      classifyComplexZone({
        zone: { zoneId: item.zone.zoneId, name: item.zone.name, categoryCode, noticeDate: normDate(item.zone.noticeDate) },
        project: item.project,
        complex,
      }).status,
  );
  const doneBases = new Set(
    rows.map((r, i) => (status[i] === "completed" ? zoneBaseName(r.item.zone.name) : "")).filter((b) => b.length >= 2),
  );
  return rows
    .filter((r, i) => status[i] !== "completed" && !(r.item.project == null && doneBases.has(zoneBaseName(r.item.zone.name))))
    .map((r) => r.item);
}

export type RedevZoneShape = RedevZone & {
  rings: Array<Array<[number, number]>>;
  project: Pick<RedevProject, "code" | "kind" | "stage" | "stageIndex" | "projectType" | "householdsTotal" | "zoneName"> | null;
};

/** 지도 영역 안 정비 구역 (대표점 기준, 최대 400) */
export async function readRedevZonesInBbox(
  db: Client,
  bbox: { swLat: number; swLng: number; neLat: number; neLng: number },
): Promise<RedevZoneShape[]> {
  try {
    const res = await db.execute({
      sql: `SELECT z.zone_id, z.name, z.category_name, z.gu, z.notice_date, z.lat, z.lng, z.rings,
                   p.code, p.zone_name, p.project_type, p.stage, p.households_total
            FROM redev_zones z
            LEFT JOIN redev_links pl ON pl.kind = 'project_zone' AND pl.zone_id = z.zone_id
            LEFT JOIN redev_projects p ON p.code = pl.ref_id
            WHERE z.category_code IN (${CAT_SQL})
              AND z.lat BETWEEN ? AND ? AND z.lng BETWEEN ? AND ?
            LIMIT 400`,
      args: [bbox.swLat - 0.01, bbox.neLat + 0.01, bbox.swLng - 0.01, bbox.neLng + 0.01],
    });
    const seen = new Set<string>();
    const out: RedevZoneShape[] = [];
    for (const r of res.rows) {
      const row = r as unknown as Record<string, unknown>;
      const id = String(row.zone_id);
      if (seen.has(id)) continue;
      seen.add(id);
      let rings: Array<Array<[number, number]>> = [];
      try {
        const parsed = JSON.parse(String(row.rings)) as unknown;
        // [[[lng,lat],…],…] 또는 멀티폴리곤 [[[[lng,lat]]]] 모두 받는다
        const flat = (x: unknown): Array<Array<[number, number]>> =>
          Array.isArray(x) && Array.isArray(x[0]) && typeof (x[0] as unknown[])[0] === "number"
            ? [x as Array<[number, number]>]
            : Array.isArray(x)
              ? (x as unknown[]).flatMap(flat)
              : [];
        rings = flat(parsed).filter((ring) => ring.length >= 3);
      } catch {
        rings = [];
      }
      const stage = str(row.stage);
      out.push({
        ...toZone(row),
        rings,
        project:
          row.code != null
            ? {
                code: String(row.code),
                zoneName: String(row.zone_name),
                projectType: str(row.project_type),
                kind: kindOf(str(row.project_type)),
                stage,
                stageIndex: stage ? REDEV_STAGES.indexOf(stage as RedevStage) : -1,
                householdsTotal: num(row.households_total),
              }
            : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}
