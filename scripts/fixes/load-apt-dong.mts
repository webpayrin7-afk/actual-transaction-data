/**
 * 매매 거래동(aptDong)·등기일(rgstDate) 채우기 — 한 단지만 (시험 적재).
 * 국토부 아파트 매매 실거래(RTMSDataSvcAptTrade)는 2023년 거래부터, 등기가 되면 aptDong(거래 동)을 준다.
 * 우리 transactions 행과 계약일·전용면적·층·거래금액이 모두 같은 거래만 1:1로 잇는다 (같은 값이 여러 건이면 보류).
 * 빈 칸만: apt_dong / rgst_date가 비어 있을 때만 쓴다.
 *
 *   npx tsx scripts/fixes/load-apt-dong.mts --lawd=11710 --apt=잠실엘스            # 계획만
 *   npx tsx scripts/fixes/load-apt-dong.mts --lawd=11710 --apt=잠실엘스 --apply    # 쓰기 (apt_dong 열이 없으면 추가)
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { getDb } from "../../src/lib/db/client";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const LAWD = arg("lawd");
const APT = arg("apt");
const APPLY = process.argv.includes("--apply");
const norm = (s: string) => s.replace(/\s+/g, "");

type Api = { key: string; aptDong: string; rgst: string };

async function fetchMonth(ym: string): Promise<Api[]> {
  const out: Api[] = [];
  for (let page = 1; page <= 20; page++) {
    const qs = new URLSearchParams({
      serviceKey: process.env.MOLIT_API_KEY!.trim(),
      LAWD_CD: LAWD,
      DEAL_YMD: ym,
      numOfRows: "1000",
      pageNo: String(page),
      _type: "json",
    });
    let rows: Array<Record<string, unknown>> = [];
    for (let a = 0; a < 4; a++) {
      try {
        const j = JSON.parse(await (await fetch(`https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade?${qs}`)).text());
        const it = j.response?.body?.items?.item;
        rows = Array.isArray(it) ? it : it ? [it] : [];
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    for (const r of rows) {
      if (norm(String(r.aptNm ?? "")) !== norm(APT)) continue;
      const d = `${r.dealYear}-${String(r.dealMonth).padStart(2, "0")}-${String(r.dealDay).padStart(2, "0")}`;
      const amount = Number(String(r.dealAmount ?? "").replace(/,/g, ""));
      const key = `${d}|${Number(r.excluUseAr).toFixed(2)}|${Number(r.floor)}|${amount}`;
      out.push({ key, aptDong: String(r.aptDong ?? "").trim(), rgst: String(r.rgstDate ?? "").trim() });
    }
    if (rows.length < 1000) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

async function main() {
  if (!LAWD || !APT) throw new Error("--lawd, --apt 필요");
  const db = getDb()!;
  const cols = (await db.execute(`PRAGMA table_info(transactions)`)).rows.map((r) => String(r.name));
  const hasCol = cols.includes("apt_dong");
  const res = await db.execute({
    sql: `SELECT id, year_month, deal_date, exclusive_area, floor, deal_amount, rgst_date${hasCol ? ", apt_dong" : ""}
          FROM transactions WHERE lawd_cd = ? AND deal_type = 'trade' AND apt_name_norm = ? AND year_month >= '202301'`,
    args: [LAWD, norm(APT)],
  });
  const ours = new Map<string, Array<Record<string, unknown>>>();
  for (const r of res.rows) {
    const key = `${r.deal_date}|${Number(r.exclusive_area).toFixed(2)}|${Number(r.floor)}|${Number(r.deal_amount)}`;
    ours.set(key, [...(ours.get(key) ?? []), r]);
  }
  const months = [...new Set(res.rows.map((r) => String(r.year_month)))].sort();
  const plan: Array<{ id: string; aptDong: string | null; rgst: string | null }> = [];
  const held = { noMatch: 0, ambiguous: 0, emptyDong: 0 };
  for (const ym of months) {
    const api = await fetchMonth(ym);
    const byKey = new Map<string, Api[]>();
    for (const a of api) byKey.set(a.key, [...(byKey.get(a.key) ?? []), a]);
    for (const [key, list] of byKey) {
      const mine = ours.get(key) ?? [];
      if (!mine.length) {
        held.noMatch += list.length;
        continue;
      }
      if (mine.length !== 1 || list.length !== 1) {
        held.ambiguous += list.length;
        continue;
      }
      const row = mine[0]!;
      const a = list[0]!;
      const setDong = a.aptDong && !(hasCol && row.apt_dong) ? a.aptDong : null;
      const setRgst = a.rgst && !row.rgst_date ? a.rgst.replace(/\./g, "-").replace(/^(\d{2})-/, "20$1-") : null;
      if (!a.aptDong) held.emptyDong++;
      if (setDong || setRgst) plan.push({ id: String(row.id), aptDong: setDong, rgst: setRgst });
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(
    JSON.stringify(
      {
        apt: APT,
        ourRows: res.rows.length,
        months: months.length,
        plan: plan.length,
        setDong: plan.filter((p) => p.aptDong).length,
        setRgst: plan.filter((p) => p.rgst).length,
        held,
        sample: plan.slice(0, 5),
      },
      null,
      1,
    ),
  );
  if (!APPLY) return;
  if (!hasCol) await db.execute(`ALTER TABLE transactions ADD COLUMN apt_dong TEXT`);
  let n = 0;
  for (let i = 0; i < plan.length; i += 100) {
    const part = plan.slice(i, i + 100);
    const r = await db.batch(
      part.map((p) => ({
        sql: `UPDATE transactions SET
                apt_dong = CASE WHEN (apt_dong IS NULL OR apt_dong = '') AND ? IS NOT NULL THEN ? ELSE apt_dong END,
                rgst_date = CASE WHEN (rgst_date IS NULL OR rgst_date = '') AND ? IS NOT NULL THEN ? ELSE rgst_date END
              WHERE id = ?`,
        args: [p.aptDong, p.aptDong, p.rgst, p.rgst, p.id],
      })),
      "write",
    );
    n += r.reduce((x, y) => x + y.rowsAffected, 0);
  }
  console.log(JSON.stringify({ applied: n }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
