#!/usr/bin/env npx tsx
/**
 * Promote Seoul KAPT identities only when legal-dong + exact jibun + normalized
 * name agree, then NULL-fill HERO fields from already-approved KAPT basic/detail.
 *
 * FAR/BCR are not touched. Confirmed links are not overwritten.
 *
 *   npx tsx scripts/profile-seoul-kapt-identity-expand.mts --pilot
 *   npx tsx scripts/profile-seoul-kapt-identity-expand.mts --apply
 */
import { createClient, type Client } from "@libsql/client";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import readline from "node:readline";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "data/poc/profile-hero");
const CACHE = resolve(OUT, "cache");
const UNIVERSE = resolve(OUT, "kapt-seoul-universe.jsonl");
const APPLY = process.argv.includes("--apply");
const PILOT = process.argv.includes("--pilot") || !APPLY;
const PILOT_N = 50;
const SOURCE_VERSION = "profile-kapt-exact-multi-signal-v1";
mkdirSync(CACHE, { recursive: true });

type KaptRow = {
  kapt_code: string;
  apt_name: string;
  apt_name_norm: string;
  lawd_cd: string;
  bjdong_code: string;
  dongri: string;
  bjdong_name: string;
  parcel_address: string;
  road_address: string;
  quality: string;
};

type Master = {
  complex_id: string;
  apt_name: string;
  apt_name_norm: string;
  lawd_cd: string;
  bjdong_cd: string;
  jibun: string;
  legal_dong_name: string;
};

type Candidate = {
  complex_id: string;
  apt_name: string;
  kapt_code: string;
  kapt_name: string;
  lawd_cd: string;
  bjdong_cd: string;
  jibun: string;
  parcel_key: string;
  signals: string[];
};

function nowIso() {
  return new Date().toISOString();
}

function normJibun(j: string | null | undefined): string | null {
  if (!j) return null;
  const raw = String(j).trim();
  const san = raw.startsWith("산");
  const s = raw.replace(/^산\s*/, "");
  const [a, b] = s.split("-");
  if (!/^\d+$/.test(a || "")) return null;
  const ji = b && /^\d+$/.test(b) ? String(Number(b)) : "0";
  return `${san ? "산" : ""}${Number(a)}-${ji}`;
}

function normName(n: string | null | undefined): string {
  return String(n || "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/아파트단지$/u, "")
    .replace(/아파트$/u, "");
}

function parseParcelJibun(parcel: string, dong: string): string | null {
  if (!parcel) return null;
  const p = parcel.replace(/\s+/g, " ").trim();
  const idx = dong ? p.indexOf(dong) : -1;
  const rest = idx >= 0 ? p.slice(idx + dong.length).trim() : p;
  const m = rest.match(/^(산)?\s*(\d+)(?:-(\d+))?/);
  if (!m) return null;
  return `${m[1] ? "산" : ""}${Number(m[2])}-${m[3] ? Number(m[3]) : 0}`;
}

function jibunToken(jibun: string): string {
  const n = normJibun(jibun);
  if (!n) return jibun;
  const san = n.startsWith("산");
  const body = n.replace(/^산/, "");
  const [a, b] = body.split("-");
  const core = b === "0" ? a : `${a}-${b}`;
  return san ? `산${core}` : core;
}

async function loadUniverse(): Promise<KaptRow[]> {
  const rows: KaptRow[] = [];
  const rl = readline.createInterface({ input: createReadStream(UNIVERSE) });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t) as KaptRow);
  }
  return rows;
}

function cachePath(code: string) {
  return resolve(CACHE, `kapt_${code}.json`);
}

function readKaptCache(code: string): { basic: Record<string, unknown> | null; detail: Record<string, unknown> | null } | null {
  const p = cachePath(code);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeKaptCache(code: string, data: unknown) {
  writeFileSync(cachePath(code), JSON.stringify(data));
}

async function getJson(path: string, kaptCode: string, key: string) {
  const u = new URL(`https://apis.data.go.kr/1613000${path}`);
  u.searchParams.set("serviceKey", key);
  u.searchParams.set("kaptCode", kaptCode);
  let status = 0;
  let text = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(u, { headers: { Accept: "application/json" } });
    status = res.status;
    text = await res.text();
    if (status !== 429 && status < 500) break;
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  let item: Record<string, unknown> | null = null;
  let resultCode: string | null = null;
  try {
    const j = JSON.parse(text);
    resultCode = j?.response?.header?.resultCode != null ? String(j.response.header.resultCode) : null;
    const raw = j?.response?.body?.item ?? null;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) item = raw as Record<string, unknown>;
  } catch {
    item = null;
  }
  const ok = status === 200 && (resultCode === "00" || resultCode === "000");
  return { ok, status, resultCode, item, kind: status === 429 ? "429" : status >= 500 ? "5xx" : "ok" };
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const d = s.replace(/[^0-9]/g, "");
  if (d.length !== 8) return null;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  if (iso < "1950-01-01" || iso > nowIso().slice(0, 10)) return null;
  return iso;
}

function materialNum(a: number, b: number): boolean {
  if (a === b) return false;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) > 2 && Math.abs(a - b) / denom > 0.01;
}

async function main() {
  if (!process.env.MOLIT_API_KEY?.trim()) throw new Error("Missing MOLIT_API_KEY");
  if (!process.env.TURSO_DATABASE_URL) throw new Error("Missing TURSO_DATABASE_URL");
  const apiKey = process.env.MOLIT_API_KEY.trim();
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const universe = await loadUniverse();
  const masters = (
    await db.execute(
      `SELECT complex_id, apt_name, apt_name_norm, lawd_cd, bjdong_cd, jibun, legal_dong_name
       FROM apt_complex_master WHERE lawd_cd LIKE '11%'`,
    )
  ).rows as unknown as Master[];
  const linkRows = (
    await db.execute(
      `SELECT l.complex_id, l.source_key FROM apt_complex_source_links l
       JOIN apt_complex_master m ON m.complex_id=l.complex_id
       WHERE l.source='KAPT' AND m.lawd_cd LIKE '11%'`,
    )
  ).rows;
  const allCodes = (
    await db.execute(`SELECT source_key, complex_id FROM apt_complex_source_links WHERE source='KAPT'`)
  ).rows;
  const linkedComplex = new Set(linkRows.map((r) => String(r.complex_id)));
  const linkedCode = new Set(allCodes.map((r) => String(r.source_key)));
  const codeOwner = new Map(allCodes.map((r) => [String(r.source_key), String(r.complex_id)]));

  const byParcel = new Map<string, Master[]>();
  for (const m of masters) {
    const j = normJibun(m.jibun);
    if (!j || !m.bjdong_cd) continue;
    const key = `${m.lawd_cd}|${m.bjdong_cd}|${j}`;
    const arr = byParcel.get(key) ?? [];
    arr.push(m);
    byParcel.set(key, arr);
  }

  const cls = {
    EXACT_MULTI_SIGNAL: 0,
    STRONG_BUT_NOT_EXACT: 0,
    CONFLICT: 0,
    INSUFFICIENT: 0,
    STALE_INVALID: 0,
    ALREADY_CONFIRMED: 0,
  };
  const exact: Candidate[] = [];
  const staged: Array<{ row: KaptRow; key: string | null; hits: Master[] }> = [];
  for (const row of universe) {
    if (linkedCode.has(row.kapt_code)) {
      cls.ALREADY_CONFIRMED++;
      continue;
    }
    if (row.quality !== "READY" || !/^A\d{8}$/.test(row.kapt_code || "")) {
      cls.STALE_INVALID++;
      continue;
    }
    const jj = parseParcelJibun(row.parcel_address, row.dongri || row.bjdong_name);
    const key = jj ? `${row.lawd_cd}|${row.bjdong_code}|${jj}` : null;
    const hits = key ? (byParcel.get(key) ?? []) : [];
    staged.push({ row, key, hits });
  }
  const codesOnParcel = new Map<string, string[]>();
  for (const s of staged) {
    if (s.key && s.hits.length === 1) {
      const arr = codesOnParcel.get(s.key) ?? [];
      arr.push(s.row.kapt_code);
      codesOnParcel.set(s.key, arr);
    }
  }
  for (const s of staged) {
    if (!s.key || s.hits.length !== 1) {
      cls.INSUFFICIENT++;
      continue;
    }
    const m = s.hits[0]!;
    const codes = codesOnParcel.get(s.key) ?? [];
    if (codes.length > 1) {
      cls.CONFLICT++;
      continue;
    }
    if (linkedComplex.has(m.complex_id)) {
      cls.CONFLICT++;
      continue;
    }
    const same = normName(m.apt_name) === normName(s.row.apt_name);
    if (!same) {
      cls.CONFLICT++;
      continue;
    }
    cls.EXACT_MULTI_SIGNAL++;
    exact.push({
      complex_id: m.complex_id,
      apt_name: m.apt_name,
      kapt_code: s.row.kapt_code,
      kapt_name: s.row.apt_name,
      lawd_cd: m.lawd_cd,
      bjdong_cd: m.bjdong_cd,
      jibun: m.jibun,
      parcel_key: s.key,
      signals: ["exact_bjdong", "exact_jibun", "exact_normalized_name"],
    });
  }
  exact.sort((a, b) => a.complex_id.localeCompare(b.complex_id));

  const ids = exact.map((e) => e.complex_id);
  let benefit = {
    household: 0,
    building_count: 0,
    approval_date: 0,
    max_floor: 0,
    heating_type: 0,
    parking_per_household: 0,
  };
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const b = await db.execute({
      sql: `SELECT
        SUM(p.household_count IS NULL) household,
        SUM(p.building_count IS NULL) building_count,
        SUM(p.approval_date IS NULL) approval_date,
        SUM(p.max_floor IS NULL) max_floor,
        SUM(p.heating_type IS NULL) heating_type,
        SUM(p.parking_per_household IS NULL) parking_per_household
      FROM apt_complex_profile p WHERE p.complex_id IN (${ph})`,
      args: ids,
    });
    benefit = b.rows[0] as typeof benefit;
  }

  const audit = {
    seoul_master: masters.length,
    universe_rows: universe.length,
    confirmed_before: linkedComplex.size,
    classification: cls,
    exact_candidates: exact.length,
    estimated_nulls_among_exact: benefit,
  };
  writeFileSync(resolve(OUT, "kapt-identity-audit.json"), JSON.stringify(audit, null, 2));
  console.log(JSON.stringify(audit));

  const targets = PILOT && !APPLY ? exact.slice(0, PILOT_N) : exact;
  const api = { calls: 0, http429: 0, http5xx: 0, timeout: 0, basic_ok: 0, detail_ok: 0 };
  const pilotRows: Array<Record<string, unknown>> = [];
  let promoted = 0;
  let fills = 0;
  let complexesChanged = 0;
  const fieldFills = {
    household: 0,
    building_count: 0,
    approval: 0,
    max_floor: 0,
    heating: 0,
    parking: 0,
  };
  let material = 0;
  let invalid = 0;
  let heldIdentity = 0;

  for (const c of targets) {
    let cached = readKaptCache(c.kapt_code);
    if (!cached?.basic || !cached?.detail) {
      const basic = await getJson("/AptBasisInfoServiceV5/getAphusBassInfoV5", c.kapt_code, apiKey);
      api.calls++;
      if (basic.kind === "429") api.http429++;
      if (basic.kind === "5xx") api.http5xx++;
      await new Promise((r) => setTimeout(r, 50));
      const detail = await getJson("/AptBasisInfoServiceV5/getAphusDtlInfoV5", c.kapt_code, apiKey);
      api.calls++;
      if (detail.kind === "429") api.http429++;
      if (detail.kind === "5xx") api.http5xx++;
      await new Promise((r) => setTimeout(r, 50));
      cached = { basic: basic.ok ? basic.item : null, detail: detail.ok ? detail.item : null };
      writeKaptCache(c.kapt_code, cached);
    }
    if (cached.basic) api.basic_ok++;
    if (cached.detail) api.detail_ok++;
    const b = cached.basic;
    const expectedBjd = `${c.lawd_cd}${c.bjdong_cd}`;
    const token = jibunToken(c.jibun);
    const addr = String(b?.kaptAddr ?? "");
    const bjdOk = String(b?.bjdCode ?? "") === expectedBjd;
    const addrOk = addr.includes(token);
    const nameOk = b ? normName(String(b.kaptName ?? "")) === normName(c.apt_name) : false;
    const promote = !!(b && bjdOk && addrOk && nameOk);
    pilotRows.push({
      complex_id: c.complex_id,
      apt_name: c.apt_name,
      kapt_code: c.kapt_code,
      signals: c.signals,
      conflicts: [
        b && !bjdOk ? "bjdCode" : null,
        b && !addrOk ? "kaptAddr_jibun" : null,
        b && !nameOk ? "kaptName" : null,
      ].filter(Boolean),
      promote: promote ? "YES" : "NO",
      basic: b ? "YES" : "NO",
      detail: cached.detail ? "YES" : "NO",
    });
    if (!promote) {
      heldIdentity++;
      continue;
    }
    if (!APPLY) continue;

    const owner = codeOwner.get(c.kapt_code);
    if (owner && owner !== c.complex_id) {
      heldIdentity++;
      continue;
    }
    if (!owner) {
      const ts = nowIso();
      await db.execute({
        sql: `INSERT INTO apt_complex_source_links
                (source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at)
              VALUES ('KAPT', ?, ?, ?, ?, ?, ?)
              ON CONFLICT(source, source_key) DO NOTHING`,
        args: [
          c.kapt_code,
          c.complex_id,
          JSON.stringify({
            match_tier: "EXACT_MULTI_SIGNAL",
            signals: c.signals,
            kaptName: b?.kaptName ?? null,
            bjdCode: b?.bjdCode ?? null,
            parcel_key: c.parcel_key,
          }),
          SOURCE_VERSION,
          ts,
          ts,
        ],
      });
      codeOwner.set(c.kapt_code, c.complex_id);
      promoted++;
    }

    const prof = (
      await db.execute({
        sql: `SELECT * FROM apt_complex_profile WHERE complex_id=?`,
        args: [c.complex_id],
      })
    ).rows[0] as Record<string, unknown> | undefined;

    const hh = num(b?.kaptdaCnt);
    const dong = num(b?.kaptDongCnt);
    const appr = normDate(b?.kaptUsedate);
    const floor = num(b?.kaptTopFloor);
    const heat = String(b?.codeHeatNm ?? "").trim();
    const heatOk = !!heat && !["-", "null", "없음", "미상", "n/a"].includes(heat.toLowerCase());
    const p1 = num(cached.detail?.kaptdPcnt);
    const p2 = num(cached.detail?.kaptdPcntu);
    const park =
      cached.detail && (cached.detail.kaptdPcnt != null || cached.detail.kaptdPcntu != null)
        ? Math.round((p1 ?? 0) + (p2 ?? 0))
        : null;

    const parcelKey = c.parcel_key.split("|");
    const recapFile = resolve(
      CACHE,
      `recap_${c.lawd_cd}${c.bjdong_cd}0${String(Number(parcelKey[2]?.split("-")[0] || 0)).padStart(4, "0")}${String(Number((parcelKey[2]?.split("-")[1] || "0"))).padStart(4, "0")}.json`.replace(/산/g, ""),
    );
    let recap: Record<string, unknown> | null = null;
    const san = String(c.jibun).trim().startsWith("산");
    const [ba, bb] = String(c.jibun).replace(/^산\s*/, "").split("-");
    const recapKey = `${c.lawd_cd}${c.bjdong_cd}${san ? "1" : "0"}${String(Number(ba || 0)).padStart(4, "0")}${String(Number(bb || 0)).padStart(4, "0")}`;
    const recapPath = resolve(CACHE, `recap_${recapKey}.json`);
    if (existsSync(recapPath)) {
      try {
        const parsed = JSON.parse(readFileSync(recapPath, "utf8")) as { status?: string; item?: Record<string, unknown> };
        if (parsed.status === "OK" && parsed.item) recap = parsed.item;
      } catch {
        recap = null;
      }
    }
    void recapFile;

    const decisions: Record<string, "FILL" | "SAME" | "CONFLICT" | "INVALID" | "MISSING" | "KEEP"> = {};
    const set: Record<string, string | number | null> = {};

    function consider(
      field: string,
      column: string,
      value: number | string | null,
      valid: boolean,
      recapValue: number | string | null,
    ) {
      const existing = prof ? (prof[column] as string | number | null) : null;
      if (!valid || value == null) {
        decisions[field] = value == null ? "MISSING" : "INVALID";
        if (value != null && !valid) invalid++;
        return;
      }
      if (recapValue != null && typeof value === "number" && typeof recapValue === "number" && materialNum(value, recapValue)) {
        decisions[field] = "CONFLICT";
        material++;
        return;
      }
      if (recapValue != null && typeof value === "string" && typeof recapValue === "string" && normDate(value) !== normDate(recapValue)) {
        decisions[field] = "CONFLICT";
        material++;
        return;
      }
      if (existing == null) {
        decisions[field] = "FILL";
        set[column] = value;
        return;
      }
      if (typeof existing === "number" && typeof value === "number" && !materialNum(existing, value) || String(existing) === String(value) || (typeof existing !== "number" && normDate(existing) && normDate(existing) === normDate(value))) {
        decisions[field] = "SAME";
        return;
      }
      decisions[field] = "CONFLICT";
      material++;
    }

    consider("household", "household_count", hh, hh != null && hh > 0, recap ? num(recap.hhldCnt) : null);
    consider("building_count", "building_count", dong != null ? Math.round(dong) : null, dong != null && dong > 0, recap ? num(recap.mainBldCnt) : null);
    consider("approval", "approval_date", appr, appr != null, recap ? normDate(recap.useAprDay) : null);
    const bldMax = (
      await db.execute({
        sql: `SELECT MAX(floor_count) mx FROM complex_buildings
              WHERE complex_id=? AND status='EXACT' AND main_atch_type='주건축물' AND residential_flag=1 AND floor_count>0`,
        args: [c.complex_id],
      })
    ).rows[0]?.mx;
    consider(
      "max_floor",
      "max_floor",
      floor != null ? Math.round(floor) : null,
      floor != null && floor > 0 && floor <= 150,
      bldMax == null ? null : Number(bldMax),
    );
    consider("heating", "heating_type", heatOk ? heat : null, heatOk, null);

    const recapPark = recap ? num(recap.totPkngCnt) : null;
    const parkConflict = park != null && recapPark != null && recapPark >= 0 && materialNum(park, Math.round(recapPark));
    const hhForPark = (set.household_count as number | undefined) ?? (prof?.household_count as number | null) ?? null;
    if (park == null || park <= 0) {
      decisions.parking = park == null ? "MISSING" : "INVALID";
      if (park != null && park <= 0) invalid++;
    } else if (parkConflict) {
      decisions.parking = "CONFLICT";
      material++;
    } else if (prof?.parking_per_household == null && hhForPark != null && Number(hhForPark) > 0) {
      decisions.parking = "FILL";
      set.parking_total = park;
      set.parking_per_household = Number((park / Number(hhForPark)).toFixed(4));
    } else if (prof?.parking_per_household != null) {
      decisions.parking = "KEEP";
    } else {
      decisions.parking = "MISSING";
    }

    const heroCols = ["household_count", "building_count", "approval_date", "max_floor", "heating_type", "parking_per_household"] as const;
    const changing = heroCols.filter((col) => set[col] != null);
    if (!changing.length) continue;

    let meta: Record<string, unknown> = {};
    if (prof?.raw_meta_json) {
      try {
        meta = JSON.parse(String(prof.raw_meta_json)) as Record<string, unknown>;
      } catch {
        meta = { prior_raw_meta: prof.raw_meta_json };
      }
    }
    const prev = meta.field_provenance && typeof meta.field_provenance === "object" ? { ...(meta.field_provenance as Record<string, unknown>) } : {};
    for (const col of changing) {
      prev[col] = {
        source: col === "parking_per_household" ? "DERIVED_PARKING_PER_HOUSEHOLD" : "KAPT_BASIC_V5",
        source_key: c.kapt_code,
        match_tier: "EXACT_MULTI_SIGNAL",
      };
    }
    meta.field_provenance = prev;
    const ts = nowIso();
    if (!prof) {
      await db.execute({
        sql: `INSERT INTO apt_complex_profile (
                complex_id, household_count, building_count, approval_date, heating_type,
                management_type, parking_total, parking_per_household, far_ratio, bcr_ratio,
                max_floor, source, source_version, raw_meta_json, updated_at
              ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, 'KAPT_BASIC_V5', ?, ?, ?)`,
        args: [
          c.complex_id,
          set.household_count ?? null,
          set.building_count ?? null,
          set.approval_date ?? null,
          set.heating_type ?? null,
          set.parking_total ?? null,
          set.parking_per_household ?? null,
          set.max_floor ?? null,
          SOURCE_VERSION,
          JSON.stringify(meta),
          ts,
        ],
      });
    } else {
      await db.execute({
        sql: `UPDATE apt_complex_profile SET
                household_count = COALESCE(household_count, ?),
                building_count = COALESCE(building_count, ?),
                approval_date = COALESCE(approval_date, ?),
                max_floor = COALESCE(max_floor, ?),
                heating_type = COALESCE(heating_type, ?),
                parking_total = COALESCE(parking_total, ?),
                parking_per_household = COALESCE(parking_per_household, ?),
                raw_meta_json = ?,
                updated_at = ?
              WHERE complex_id = ?`,
        args: [
          set.household_count ?? null,
          set.building_count ?? null,
          set.approval_date ?? null,
          set.max_floor ?? null,
          set.heating_type ?? null,
          set.parking_total ?? null,
          set.parking_per_household ?? null,
          JSON.stringify(meta),
          ts,
          c.complex_id,
        ],
      });
    }
    complexesChanged++;
    for (const col of changing) {
      fills++;
      if (col === "household_count") fieldFills.household++;
      if (col === "building_count") fieldFills.building_count++;
      if (col === "approval_date") fieldFills.approval++;
      if (col === "max_floor") fieldFills.max_floor++;
      if (col === "heating_type") fieldFills.heating++;
      if (col === "parking_per_household") fieldFills.parking++;
    }
  }

  const pilotPass = pilotRows.filter((r) => r.promote === "YES").length;
  const pilotFail = pilotRows.filter((r) => r.promote === "NO").length;
  const report = {
    mode: APPLY ? "APPLY" : "PILOT",
    audit,
    pilot_tested: pilotRows.length,
    pilot_passed: pilotPass,
    pilot_failed: pilotFail,
    pilot: APPLY ? pilotRows.slice(0, 50) : pilotRows,
    api,
    promoted,
    heldIdentity,
    complexesChanged,
    fieldFills,
    fills,
    material,
    invalid,
  };
  writeFileSync(resolve(OUT, APPLY ? "kapt-identity-apply.json" : "kapt-identity-pilot.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ mode: report.mode, pilotPass, pilotFail, promoted, complexesChanged, fills, fieldFills, api, heldIdentity, material, invalid }));
  if (!APPLY && pilotFail > 0) process.exitCode = 2;
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
