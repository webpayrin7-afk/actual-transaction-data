/**
 * STAGE 2 — Songpa NEIS ↔ SchoolInfo source-link readiness (read-only).
 * DB WRITE = 0. No school UI/route changes. No detail APIs.
 *
 * NEIS and SchoolInfo codes are separate namespaces.
 */
import { config } from "dotenv";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

config({ path: ".env.local" });
config();

const OUT_DIR = join(process.cwd(), "data/poc/school-source-links");
const OUT_FILE = join(OUT_DIR, "songpa-school-links.json");
const INV_CACHE = join(OUT_DIR, "_schoolinfo-songpa-inventory.json");

const SEOUL_SIDO = "11";
const SONGPA_SGG = "11710";
const SCOPE = "서울특별시 송파구";

const KIND = {
  elementary: { code: "02", label: "초등학교" },
  middle: { code: "03", label: "중학교" },
  high: { code: "04", label: "고등학교" },
} as const;

type Level = keyof typeof KIND;

/** Locked verified links from existing school-info identity contract (pilot). */
const KNOWN_LINKS = [
  {
    neisSchoolCode: "7130202",
    schoolInfoCode: "S010000888",
    schoolName: "잠실중학교",
    schoolLevel: "middle" as Level,
    addressNeedle: "올림픽로35길130",
  },
  {
    neisSchoolCode: "7130201",
    schoolInfoCode: "S010000887",
    schoolName: "잠신중학교",
    schoolLevel: "middle" as Level,
    addressNeedle: "잠실로12",
  },
] as const;

type SchoolInfoNorm = {
  schoolInfoCode: string;
  schoolName: string;
  schoolLevel: Level;
  roadAddress: string;
  jibunAddress: string | null;
  region: string;
  establishment: string | null;
};

type LinkRow = {
  neisSchoolCode: string | null;
  schoolInfoCode: string | null;
  schoolName: string;
  schoolLevel: Level;
  neisAddress: string | null;
  schoolInfoAddress: string | null;
  status: "MATCHED" | "AMBIGUOUS" | "UNRESOLVED";
  matchEvidence: string[];
  notes?: string;
};

function schoolInfoKey(): string {
  const k = process.env.SCHOOLINFO_API_KEY?.trim() || "";
  if (!k) throw new Error("SCHOOLINFO_API_KEY missing");
  return k;
}

function neisKey(): string | null {
  return (
    process.env.NEIS_API_KEY?.trim() ||
    process.env.NEIS_KEY?.trim() ||
    null
  );
}

function normName(s: string): string {
  return String(s).replace(/\s+/g, "").trim();
}

function normAddress(s: string): string {
  return String(s)
    .replace(/[()（）]/g, "")
    .replace(/\s+/g, "")
    .replace(/[.,·,]/g, "")
    .trim();
}

async function fetchSchoolInfoList(level: Level): Promise<SchoolInfoNorm[]> {
  const key = schoolInfoKey();
  const params = new URLSearchParams({
    apiKey: key,
    apiType: "0",
    schulKndCode: KIND[level].code,
    sidoCode: SEOUL_SIDO,
    sggCode: SONGPA_SGG,
  });
  const url = `https://www.schoolinfo.go.kr/openApi.do?${params}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ziplab-stage2-school-links/1.0",
    },
  });
  if (!res.ok) throw new Error(`SchoolInfo HTTP ${res.status}`);
  const body = (await res.json()) as {
    resultCode?: string;
    list?: Record<string, unknown>[];
  };
  if (String(body.resultCode ?? "").toLowerCase() !== "success") {
    throw new Error(`SchoolInfo resultCode=${body.resultCode}`);
  }
  const list = Array.isArray(body.list) ? body.list : [];
  return list
    .filter((r) => String(r.CLOSE_YN ?? "N").toUpperCase() !== "Y")
    .map((r) => {
      const road = [String(r.SCHUL_RDNMA ?? "").trim(), String(r.SCHUL_RDNDA ?? "").trim()]
        .filter(Boolean)
        .join(" ");
      return {
        schoolInfoCode: String(r.SCHUL_CODE ?? "").trim(),
        schoolName: String(r.SCHUL_NM ?? "").trim(),
        schoolLevel: level,
        roadAddress: road,
        jibunAddress: String(r.ADRES_BRKDN ?? "").trim() || null,
        region: String(r.ADRCD_NM ?? "").trim(),
        establishment: String(r.FOND_SC_CODE ?? "").trim() || null,
      };
    })
    .filter((r) => r.schoolInfoCode && r.schoolName);
}

async function fetchNeisSongpa(): Promise<
  | { ok: true; rows: Array<{
      neisSchoolCode: string;
      schoolName: string;
      schoolLevel: Level | null;
      roadAddress: string;
      region: string;
      establishment: string | null;
    }> }
  | { ok: false; reason: string }
> {
  const key = neisKey();
  if (!key) {
    return {
      ok: false,
      reason:
        "NEIS_API_KEY / NEIS_KEY not present in environment; cannot fetch Songpa NEIS schoolInfo list this run",
    };
  }
  const rows: Array<{
    neisSchoolCode: string;
    schoolName: string;
    schoolLevel: Level | null;
    roadAddress: string;
    region: string;
    establishment: string | null;
  }> = [];
  for (let pIndex = 1; pIndex <= 20; pIndex++) {
    const params = new URLSearchParams({
      KEY: key,
      Type: "json",
      pIndex: String(pIndex),
      pSize: "100",
      ATPT_OFCDC_SC_CODE: "B10",
    });
    const url = `https://open.neis.go.kr/hub/schoolInfo?${params}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return { ok: false, reason: `NEIS HTTP ${res.status}` };
    }
    const json = (await res.json()) as {
      schoolInfo?: Array<{ row?: Record<string, unknown>[]; head?: unknown }>;
      RESULT?: { CODE?: string; MESSAGE?: string };
    };
    if (json.RESULT?.CODE && json.RESULT.CODE !== "INFO-000") {
      // INFO-200 = no more data
      if (json.RESULT.CODE === "INFO-200") break;
      return {
        ok: false,
        reason: `NEIS ${json.RESULT.CODE}: ${json.RESULT.MESSAGE ?? ""}`,
      };
    }
    const page =
      json.schoolInfo?.find((b) => Array.isArray(b.row))?.row ?? [];
    if (page.length === 0) break;
    for (const r of page) {
      const addr = [
        String(r.ORG_RDNMA ?? "").trim(),
        String(r.ORG_RDNDA ?? "").trim(),
      ]
        .filter(Boolean)
        .join(" ");
      const ju = String(r.JU_ORG_NM ?? "");
      const lctn = String(r.LCTN_SC_NM ?? "");
      const blob = `${addr} ${ju} ${lctn}`;
      if (!blob.includes("송파구")) continue;
      const kind = String(r.SCHUL_KND_SC_NM ?? "");
      let schoolLevel: Level | null = null;
      if (kind.includes("초등")) schoolLevel = "elementary";
      else if (kind.includes("중")) schoolLevel = "middle";
      else if (kind.includes("고등")) schoolLevel = "high";
      else continue;
      const code = String(r.SD_SCHUL_CODE ?? "").trim();
      const name = String(r.SCHUL_NM ?? "").trim();
      if (!code || !name) continue;
      rows.push({
        neisSchoolCode: code,
        schoolName: name,
        schoolLevel,
        roadAddress: addr,
        region: "서울특별시 송파구",
        establishment: String(r.FOND_SC_NM ?? "").trim() || null,
      });
    }
    if (page.length < 100) break;
  }
  return { ok: true, rows };
}

function matchKnownAgainstSchoolInfo(
  inventory: Record<Level, SchoolInfoNorm[]>,
): LinkRow[] {
  const out: LinkRow[] = [];
  for (const known of KNOWN_LINKS) {
    const pool = inventory[known.schoolLevel] ?? [];
    const byCode = pool.filter((s) => s.schoolInfoCode === known.schoolInfoCode);
    const evidence: string[] = [];
    let status: LinkRow["status"] = "UNRESOLVED";
    let schoolInfoAddress: string | null = null;

    if (byCode.length === 1) {
      const s = byCode[0]!;
      schoolInfoAddress = s.roadAddress;
      if (normName(s.schoolName) === normName(known.schoolName)) {
        evidence.push("NAME_EXACT");
      }
      if (s.schoolLevel === known.schoolLevel) evidence.push("LEVEL_EXACT");
      if (s.region.includes("송파구")) evidence.push("REGION_EXACT");
      if (normAddress(s.roadAddress).includes(normAddress(known.addressNeedle))) {
        evidence.push("ADDRESS_EXACT");
      }
      evidence.push("KNOWN_LINK_REVALIDATED");
      evidence.push("NAMESPACE_SEPARATE");
      if (
        evidence.includes("NAME_EXACT") &&
        evidence.includes("LEVEL_EXACT") &&
        evidence.includes("REGION_EXACT") &&
        evidence.includes("ADDRESS_EXACT")
      ) {
        status = "MATCHED";
      } else {
        status = "AMBIGUOUS";
      }
    } else if (byCode.length > 1) {
      status = "AMBIGUOUS";
      evidence.push("MULTIPLE_SCHOOLINFO_CODE_HITS");
    } else {
      status = "UNRESOLVED";
      evidence.push("SCHOOLINFO_CODE_NOT_IN_SONGPA_LIST");
    }

    out.push({
      neisSchoolCode: known.neisSchoolCode,
      schoolInfoCode: known.schoolInfoCode,
      schoolName: known.schoolName,
      schoolLevel: known.schoolLevel,
      neisAddress: null,
      schoolInfoAddress,
      status,
      matchEvidence: evidence,
      notes:
        "NEIS row not live-fetched this run (key missing); SchoolInfo side revalidated live; link from existing identity contract",
    });
  }
  return out;
}

function attemptLiveMatch(
  neisRows: Array<{
    neisSchoolCode: string;
    schoolName: string;
    schoolLevel: Level | null;
    roadAddress: string;
    region: string;
    establishment: string | null;
  }>,
  inventory: Record<Level, SchoolInfoNorm[]>,
): LinkRow[] {
  const out: LinkRow[] = [];
  const usedSi = new Set<string>();
  for (const n of neisRows) {
    if (!n.schoolLevel) {
      out.push({
        neisSchoolCode: n.neisSchoolCode,
        schoolInfoCode: null,
        schoolName: n.schoolName,
        schoolLevel: "elementary",
        neisAddress: n.roadAddress,
        schoolInfoAddress: null,
        status: "UNRESOLVED",
        matchEvidence: ["LEVEL_UNCLASSIFIED"],
      });
      continue;
    }
    const pool = inventory[n.schoolLevel] ?? [];
    const hits = pool.filter(
      (s) =>
        normName(s.schoolName) === normName(n.schoolName) &&
        s.schoolLevel === n.schoolLevel &&
        s.region.includes("송파구") &&
        normAddress(s.roadAddress) === normAddress(n.roadAddress),
    );
    if (hits.length === 1) {
      const s = hits[0]!;
      usedSi.add(s.schoolInfoCode);
      out.push({
        neisSchoolCode: n.neisSchoolCode,
        schoolInfoCode: s.schoolInfoCode,
        schoolName: n.schoolName,
        schoolLevel: n.schoolLevel,
        neisAddress: n.roadAddress,
        schoolInfoAddress: s.roadAddress,
        status: "MATCHED",
        matchEvidence: [
          "NAME_EXACT",
          "LEVEL_EXACT",
          "REGION_EXACT",
          "ADDRESS_EXACT",
          "NAMESPACE_SEPARATE",
        ],
      });
    } else if (hits.length > 1) {
      out.push({
        neisSchoolCode: n.neisSchoolCode,
        schoolInfoCode: null,
        schoolName: n.schoolName,
        schoolLevel: n.schoolLevel,
        neisAddress: n.roadAddress,
        schoolInfoAddress: null,
        status: "AMBIGUOUS",
        matchEvidence: ["MULTIPLE_ADDRESS_EXACT_HITS"],
      });
    } else {
      // name+level+region but address mismatch → AMBIGUOUS if name unique collision risk
      const nameHits = pool.filter(
        (s) =>
          normName(s.schoolName) === normName(n.schoolName) &&
          s.schoolLevel === n.schoolLevel,
      );
      if (nameHits.length >= 1) {
        out.push({
          neisSchoolCode: n.neisSchoolCode,
          schoolInfoCode: nameHits.length === 1 ? nameHits[0]!.schoolInfoCode : null,
          schoolName: n.schoolName,
          schoolLevel: n.schoolLevel,
          neisAddress: n.roadAddress,
          schoolInfoAddress: nameHits.length === 1 ? nameHits[0]!.roadAddress : null,
          status: "AMBIGUOUS",
          matchEvidence:
            nameHits.length > 1
              ? ["NAME_LEVEL_MULTI_CANDIDATE"]
              : ["NAME_LEVEL_REGION_BUT_ADDRESS_MISMATCH"],
        });
      } else {
        out.push({
          neisSchoolCode: n.neisSchoolCode,
          schoolInfoCode: null,
          schoolName: n.schoolName,
          schoolLevel: n.schoolLevel,
          neisAddress: n.roadAddress,
          schoolInfoAddress: null,
          status: "UNRESOLVED",
          matchEvidence: ["NO_SCHOOLINFO_CANDIDATE"],
        });
      }
    }
  }
  return out;
}

function rate(matched: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((matched / total) * 1000) / 10;
}

function gate(ratePct: number | null): "PASS" | "PARTIAL" | "HOLD" {
  if (ratePct == null) return "HOLD";
  if (ratePct >= 95) return "PASS";
  if (ratePct >= 90) return "PARTIAL";
  return "HOLD";
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  let inventory: Record<Level, SchoolInfoNorm[]>;
  if (existsSync(INV_CACHE)) {
    inventory = JSON.parse(readFileSync(INV_CACHE, "utf8")) as Record<
      Level,
      SchoolInfoNorm[]
    >;
    // refresh live to be safe (3 list calls only)
  }
  inventory = {
    elementary: await fetchSchoolInfoList("elementary"),
    middle: await fetchSchoolInfoList("middle"),
    high: await fetchSchoolInfoList("high"),
  };
  writeFileSync(INV_CACHE, JSON.stringify(inventory, null, 2));

  const schoolInfoTotal =
    inventory.elementary.length +
    inventory.middle.length +
    inventory.high.length;

  const neis = await fetchNeisSongpa();
  let schools: LinkRow[] = [];
  let neisTotal = 0;
  let neisFetchStatus: string;

  if (neis.ok) {
    neisTotal = neis.rows.length;
    neisFetchStatus = "OK";
    schools = attemptLiveMatch(neis.rows, inventory);
    // ensure known links appear / override with revalidation if present
    const known = matchKnownAgainstSchoolInfo(inventory);
    for (const k of known) {
      const idx = schools.findIndex(
        (s) => s.neisSchoolCode === k.neisSchoolCode,
      );
      if (idx >= 0) schools[idx] = k;
      else schools.push(k);
    }
  } else {
    neisFetchStatus = neis.ok === false ? neis.reason : "unknown";
    schools = matchKnownAgainstSchoolInfo(inventory);
    // SchoolInfo-only rows remain identity inventory, not MATCHED
    for (const level of Object.keys(KIND) as Level[]) {
      for (const s of inventory[level]) {
        if (schools.some((x) => x.schoolInfoCode === s.schoolInfoCode)) continue;
        schools.push({
          neisSchoolCode: null,
          schoolInfoCode: s.schoolInfoCode,
          schoolName: s.schoolName,
          schoolLevel: level,
          neisAddress: null,
          schoolInfoAddress: s.roadAddress,
          status: "UNRESOLVED",
          matchEvidence: ["NEIS_SIDE_UNAVAILABLE"],
          notes: "SchoolInfo inventory only; NEIS counterpart not fetched",
        });
      }
    }
  }

  const matched = schools.filter((s) => s.status === "MATCHED");
  const ambiguous = schools.filter((s) => s.status === "AMBIGUOUS");
  const unresolved = schools.filter((s) => s.status === "UNRESOLVED");

  const byLevel = (level: Level) => {
    const subset = schools.filter(
      (s) => s.schoolLevel === level && s.neisSchoolCode != null,
    );
    const m = subset.filter((s) => s.status === "MATCHED").length;
    const total = subset.length;
    return {
      total,
      matched: m,
      ambiguous: subset.filter((s) => s.status === "AMBIGUOUS").length,
      unresolved: subset.filter((s) => s.status === "UNRESOLVED").length,
      matchRatePct: rate(m, total),
    };
  };

  // Match rate over NEIS-keyed rows only
  const neisKeyed = schools.filter((s) => s.neisSchoolCode != null);
  const matchRatePct = rate(
    neisKeyed.filter((s) => s.status === "MATCHED").length,
    neisKeyed.length,
  );
  const decision = neis.ok ? gate(matchRatePct) : "HOLD";

  const jamsil = schools.find(
    (s) =>
      s.neisSchoolCode === "7130202" ||
      s.schoolInfoCode === "S010000888" ||
      s.schoolName === "잠실중학교",
  );

  const artifact = {
    generatedAt: new Date().toISOString(),
    scope: SCOPE,
    namespaces: {
      neis: "SD_SCHUL_CODE",
      schoolInfo: "SCHUL_CODE",
      note: "NEIS CODE != SchoolInfo CODE; never treat as same namespace",
    },
    sources: {
      schoolInfo: {
        endpoint: "https://www.schoolinfo.go.kr/openApi.do",
        apiType: "0",
        calls: 3,
        sidoCode: SEOUL_SIDO,
        sggCode: SONGPA_SGG,
      },
      neis: {
        endpoint: "https://open.neis.go.kr/hub/schoolInfo",
        fetchStatus: neisFetchStatus,
        calls: neis.ok ? "paginated B10 then filter 송파구" : 0,
      },
    },
    summary: {
      neisTotal,
      schoolInfoTotal,
      schoolInfoByLevel: {
        elementary: inventory.elementary.length,
        middle: inventory.middle.length,
        high: inventory.high.length,
      },
      MATCHED: matched.length,
      AMBIGUOUS: ambiguous.length,
      UNRESOLVED: unresolved.length,
      matchRatePct,
      matchRateBasis: "NEIS-keyed rows only",
      decision,
      decisionReason: neis.ok
        ? `matchRate=${matchRatePct}%`
        : "NEIS list unavailable — cannot compute Songpa NEIS→SchoolInfo coverage; known links revalidated on SchoolInfo side only",
    },
    byLevel: {
      elementary: byLevel("elementary"),
      middle: byLevel("middle"),
      high: byLevel("high"),
    },
    representative: {
      잠실중학교: jamsil ?? null,
    },
    ambiguousExamples: ambiguous.slice(0, 3),
    futureProduction: {
      runtimeResolverReplaceable:
        decision === "PASS"
          ? "YES — artifact can seed runtime source-link table later"
          : "NOT_YET — complete NEIS-side Songpa fetch + match first",
      dbMappingRequiredNow: false,
      recommendedFutureIdentityModel:
        "Keep /school/[NEIS SD_SCHUL_CODE] route; resolve SchoolInfo SCHUL_CODE via source-link layer (name+level+region+normalized address). Never merge code namespaces.",
    },
    schools,
  };

  writeFileSync(OUT_FILE, JSON.stringify(artifact, null, 2));
  console.log(
    JSON.stringify(
      {
        out: OUT_FILE,
        summary: artifact.summary,
        jamsil: artifact.representative.잠실중학교,
        byLevel: artifact.byLevel,
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
