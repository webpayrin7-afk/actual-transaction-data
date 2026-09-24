/**
 * 청약홈 분양정보 → applyhome_notices / applyhome_models / applyhome_competition (새 테이블만).
 *
 *   npx tsx scripts/applyhome/sync-applyhome.ts            # dry-run: 수집 + insert/update/unchanged 건수, 쓰기 없음
 *   npx tsx scripts/applyhome/sync-applyhome.ts --apply    # 테이블 만들고 바뀐 행만 upsert
 *
 * 원천 사본이라 같은 키 행이 원천에서 바뀌면(payload_hash 다름) 갱신한다. 다시 돌리면 insert·update 0.
 * lawd_cd는 주소 이름 정확 일치만 (lawd-match.ts). 못 붙인 공고 수를 보고한다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { getDb } from "../../src/lib/db/client";
import { APPLYHOME_ENDPOINTS, fetchAllPages } from "../../src/lib/applyhome/fetch";
import { matchLawd, type DongIndex } from "../../src/lib/applyhome/lawd-match";

type Row = Record<string, unknown>;
type Cell = string | number | null;

const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v).trim());
const n = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const x = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(x) ? x : null;
};
const hash = (o: unknown) => createHash("sha1").update(JSON.stringify(o)).digest("hex");

async function tableExists(db: Client, t: string): Promise<boolean> {
  const r = await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", args: [t] });
  return r.rows.length > 0;
}

async function existingHashes(db: Client, table: string, keyCols: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!(await tableExists(db, table))) return m;
  const res = await db.execute(`SELECT ${keyCols.join(", ")}, payload_hash FROM ${table}`);
  for (const r of res.rows) m.set(keyCols.map((c) => String(r[c])).join("|"), String(r.payload_hash));
  return m;
}

function diff<T extends Record<string, Cell>>(rows: T[], keyCols: string[], have: Map<string, string>) {
  const seen = new Set<string>();
  const changed: T[] = [];
  const counts = { insert: 0, update: 0, unchanged: 0, duplicate_keys: 0 };
  for (const r of rows) {
    const k = keyCols.map((c) => String(r[c])).join("|");
    if (seen.has(k)) {
      counts.duplicate_keys++;
      continue;
    }
    seen.add(k);
    const h = have.get(k);
    if (h == null) {
      counts.insert++;
      changed.push(r);
    } else if (h !== r.payload_hash) {
      counts.update++;
      changed.push(r);
    } else counts.unchanged++;
  }
  return { changed, counts };
}

async function upsert(db: Client, table: string, rows: Array<Record<string, Cell>>, now: string): Promise<number> {
  let affected = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200).map((r) => {
      const cols = [...Object.keys(r), "fetched_at"];
      return {
        sql: `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        args: [...Object.values(r), now],
      };
    });
    const res = await db.batch(batch, "write");
    affected += res.reduce((a, x) => a + x.rowsAffected, 0);
  }
  return affected;
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const key = process.env.MOLIT_API_KEY;
  if (!key) throw new Error("MOLIT_API_KEY missing");
  const apply = process.argv.includes("--apply");
  const now = new Date().toISOString();

  const [rawNotices, rawModels, rawComp] = await Promise.all([
    fetchAllPages(APPLYHOME_ENDPOINTS.notices, key),
    fetchAllPages(APPLYHOME_ENDPOINTS.models, key),
    fetchAllPages(APPLYHOME_ENDPOINTS.competition, key),
  ]);
  console.log(`fetched notices=${rawNotices.length} models=${rawModels.length} competition=${rawComp.length}`);

  const dongIndex: DongIndex = new Map();
  const dongRows = await db.execute(
    "SELECT DISTINCT lawd_cd, legal_dong_name FROM apt_complex_master WHERE legal_dong_name IS NOT NULL",
  );
  for (const r of dongRows.rows) {
    const d = String(r.legal_dong_name);
    dongIndex.set(d, (dongIndex.get(d) ?? new Set<string>()).add(String(r.lawd_cd)));
  }

  const notices = rawNotices.map((r: Row) => {
    const v: Record<string, Cell> = {
      house_manage_no: String(r.HOUSE_MANAGE_NO),
      pblanc_no: s(r.PBLANC_NO),
      house_nm: s(r.HOUSE_NM) ?? "",
      house_secd_nm: s(r.HOUSE_SECD_NM),
      house_dtl_secd_nm: s(r.HOUSE_DTL_SECD_NM),
      rent_secd_nm: s(r.RENT_SECD_NM),
      area_name: s(r.SUBSCRPT_AREA_CODE_NM),
      address: s(r.HSSPLY_ADRES),
      lawd_cd: matchLawd(s(r.HSSPLY_ADRES), dongIndex),
      total_supply: n(r.TOT_SUPLY_HSHLDCO),
      notice_date: s(r.RCRIT_PBLANC_DE),
      special_rcept_begin: s(r.SPSPLY_RCEPT_BGNDE),
      rcept_begin: s(r.RCEPT_BGNDE),
      rcept_end: s(r.RCEPT_ENDDE),
      winner_date: s(r.PRZWNER_PRESNATN_DE),
      contract_begin: s(r.CNTRCT_CNCLS_BGNDE),
      contract_end: s(r.CNTRCT_CNCLS_ENDDE),
      move_in_ym: s(r.MVN_PREARNGE_YM),
      builder: s(r.CNSTRCT_ENTRPS_NM),
      developer: s(r.BSNS_MBY_NM),
      homepage: s(r.HMPG_ADRES),
      notice_url: s(r.PBLANC_URL),
      payload: JSON.stringify(r),
    };
    return { ...v, payload_hash: hash(v) };
  });
  const models = rawModels.map((r: Row) => {
    const v: Record<string, Cell> = {
      house_manage_no: String(r.HOUSE_MANAGE_NO),
      model_no: String(r.MODEL_NO),
      house_ty: s(r.HOUSE_TY),
      supply_area: n(r.SUPLY_AR),
      general_supply: n(r.SUPLY_HSHLDCO),
      special_supply: n(r.SPSPLY_HSHLDCO),
      top_amount: n(r.LTTOT_TOP_AMOUNT),
    };
    return { ...v, payload_hash: hash(v) };
  });
  const comps = rawComp.map((r: Row) => {
    const v: Record<string, Cell> = {
      house_manage_no: String(r.HOUSE_MANAGE_NO),
      model_no: String(r.MODEL_NO),
      rank_code: Number(r.SUBSCRPT_RANK_CODE),
      reside_code: String(r.RESIDE_SECD ?? ""),
      house_ty: s(r.HOUSE_TY),
      reside_name: s(r.RESIDE_SENM),
      supply_count: n(r.SUPLY_HSHLDCO),
      request_count: n(r.REQ_CNT),
      competition_rate: s(r.CMPET_RATE),
    };
    return { ...v, payload_hash: hash(v) };
  });

  const compKey = ["house_manage_no", "model_no", "rank_code", "reside_code"];
  const plan = {
    notices: diff(notices, ["house_manage_no"], await existingHashes(db, "applyhome_notices", ["house_manage_no"])),
    models: diff(
      models,
      ["house_manage_no", "model_no"],
      await existingHashes(db, "applyhome_models", ["house_manage_no", "model_no"]),
    ),
    competition: diff(comps, compKey, await existingHashes(db, "applyhome_competition", compKey)),
  };
  const unmatched = (notices as Array<Record<string, Cell>>).filter((x) => !x.lawd_cd);
  const rcept = (notices as Array<Record<string, Cell>>)
    .map((x) => x.rcept_begin)
    .filter((x): x is string => typeof x === "string")
    .sort();
  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        notices: plan.notices.counts,
        models: plan.models.counts,
        competition: plan.competition.counts,
        lawd_matched: notices.length - unmatched.length,
        lawd_unmatched: unmatched.length,
        unmatched_samples: unmatched.slice(0, 15).map((x) => x.address),
        rcept_range: [rcept[0], rcept.at(-1)],
      },
      null,
      2,
    ),
  );
  if (!apply) return;

  const ddl = readFileSync(join(process.cwd(), "src/lib/db/migrations/20260926_applyhome.sql"), "utf8");
  for (const stmt of ddl
    .split(/;\s*\n/)
    .map((x) => x.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean)) {
    await db.execute(stmt);
  }
  console.log(
    JSON.stringify({
      applied: {
        notices: await upsert(db, "applyhome_notices", plan.notices.changed, now),
        models: await upsert(db, "applyhome_models", plan.models.changed, now),
        competition: await upsert(db, "applyhome_competition", plan.competition.changed, now),
      },
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
