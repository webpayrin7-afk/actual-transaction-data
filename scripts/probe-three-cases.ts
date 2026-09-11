import { config } from "dotenv";
import { createClient, type InStatement } from "@libsql/client";
import { TRADE_API_URL, RENT_API_URL } from "../src/lib/constants/regions";
import { parseTradeXml, parseRentXml, getApiTotalCount, getApiResultCode } from "../src/lib/molit/parse";
import { getDb } from "../src/lib/db/client";
import { queryAptTransactions, queryRegionMonthPool } from "../src/lib/db/repository";
import { GET as aptGET } from "../src/app/api/apt-detail/route";
import { NextRequest } from "next/server";
import type { AptDetailResponse } from "../src/lib/molit/apt";
import { naturalKeyFromTx } from "../src/lib/market/identity";
import { resolveActiveTrades } from "../src/lib/molit/trade-resolve";
import { GET as regionGET } from "../src/app/api/region-daily/route";
import type { RegionDailyResponse } from "../src/lib/molit/service";
import { normalizeAreaKey, resolveDefaultAreaKey } from "../src/lib/apt/default-area";
import { priorTypeMaxAmount } from "../src/lib/region/market-insight";
config({ path: ".env.local", quiet: true });

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("Database configuration missing");
  const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  if (process.argv.includes("--jung")) {
    const key = process.env.MOLIT_API_KEY!.trim();
    const response = await fetch(`${TRADE_API_URL}?serviceKey=${key.includes("%") ? key : encodeURIComponent(key)}&LAWD_CD=11140&DEAL_YMD=202503&pageNo=1&numOfRows=1000`, { signal: AbortSignal.timeout(30000), cache:"no-store" });
    const xml = await response.text();
    if (!response.ok || !["00","000","0"].includes(getApiResultCode(xml).code)) throw new Error("MOLIT request failed");
    const parsed = parseTradeXml(xml,"11140");
    if (getApiTotalCount(xml) !== parsed.length) throw new Error("Incomplete MOLIT response");
    const src = resolveActiveTrades(parsed,"11140").active;
    const rows = (await db.execute(`SELECT apt_name,apt_name_norm,COUNT(*) n FROM transactions WHERE lawd_cd='11140' AND deal_type='trade' GROUP BY apt_name,apt_name_norm`)).rows;
    console.log("jung-name-counts", JSON.stringify({warehouse:rows.length,sourceMarch:new Set(src.map(t=>t.aptName)).size}));
    console.log("jung-no-warehouse",JSON.stringify(src.filter(t=>!rows.some(r=>String(r.apt_name_norm)===t.aptName.replace(/\s+/g,"").toLowerCase()))));
    console.log("jung-cell-count",JSON.stringify((await db.execute(`SELECT COUNT(*) n FROM transactions WHERE lawd_cd='11140' AND year_month='202503' AND deal_type='trade'`)).rows));
    db.close(); return;
  }
  if (process.argv.includes("--pipeline")) {
    const shared = getDb()!;
    const execute = shared.execute.bind(shared);
    shared.execute = ((statement: InStatement) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (!/^\s*(SELECT|PRAGMA table_info)\b/i.test(sql)) throw new Error("READ-ONLY audit rejected SQL");
      return execute(statement);
    }) as typeof shared.execute;
    shared.executeMultiple = async () => { throw new Error("READ-ONLY audit rejected executeMultiple"); };
    const cases = [
      { name: "이촌코오롱(A)", slug: "seoul-yongsan", code: "11170", ym: "202608" },
      { name: "한강(대우)", slug: "seoul-yongsan", code: "11170", ym: "202503" },
      ...["남산타운", "서울역센트럴자이", "롯데캐슬", "삼성사이버빌리지"].map(name => ({ name, slug: "seoul-jung", code: "11140", ym: "202608" })),
    ];
    for (const c of cases) {
      const repo = await queryAptTransactions({ lawdCodes: [c.code], aptName: c.name, yearMonths: [] });
      const region = await queryRegionMonthPool({ lawdCodes: [c.code], yearMonths: [c.ym] });
      const response = await aptGET(new NextRequest(`http://localhost/api/apt-detail?${new URLSearchParams({ aptName: c.name, region: c.slug, months: "120" })}`));
      const api = await response.json() as AptDetailResponse;
      const dates = c.ym === "202503" ? "2025-03-08,2025-03-15" : "2026-08-01,2026-08-03,2026-08-06,2026-08-07,2026-08-13,2026-08-16";
      const regionResponse = await regionGET(new NextRequest(`http://localhost/api/region-daily?${new URLSearchParams({region:c.slug,yearMonth:c.ym,dates,part:"days"})}`));
      const regionApi = await regionResponse.json() as RegionDailyResponse;
      const targets = api.items.filter(t => t.dealType === "trade" && (c.code === "11170" ? ["2026-08-07", "2025-03-08", "2025-03-15"].includes(t.dealDate) : t.dealDate.startsWith("2026-08")));
      const defaultArea = resolveDefaultAreaKey(api.areas,api.items);
      if (c.name === "이촌코오롱(A)") console.log("ichon-prior-25eok",JSON.stringify(api.items.filter(t=>t.dealType==="trade"&&t.exclusiveArea===59.82&&t.dealAmount===250000).map(t=>({date:t.dealDate,high:t.isSingoga}))));
      console.log("pipeline", c.name, JSON.stringify({repo:repo.length,regionMonthRows:region?.filter(t=>t.aptName===c.name).length,apiStatus:response.status,api:api.items.length,regionStatus:regionResponse.status,defaultArea,targets:targets.map(t=>({id:t.id,date:t.dealDate,area:t.exclusiveArea,amount:t.dealAmount,high:t.isSingoga,prior:priorTypeMaxAmount({...t,history:api.items.filter(i=>i.dealType==="trade")}),regionHigh:regionApi.historySections?.flatMap(s=>s.deals).find(r=>r.id===t.id)?.singogaKind,regionApi:regionApi.historySections?.some(s=>s.deals.some(r=>r.id===t.id)),uiDefault:defaultArea==="all"||normalizeAreaKey(t.exclusiveArea)===defaultArea,uiSelected:api.items.filter(i=>normalizeAreaKey(i.exclusiveArea)===normalizeAreaKey(t.exclusiveArea)).some(i=>i.id===t.id)}))}));
    }
    shared.close(); db.close(); return;
  }
  if (process.argv.includes("--source")) {
    for (const [ym, kind] of [["202608", "trade"], ["202608", "rent"], ["202503", "trade"]]) {
      const rows = [];
      let total = 0;
      for (let page = 1; page === 1 || rows.length < total; page++) {
        const key = process.env.MOLIT_API_KEY!.trim();
        const endpoint = kind === "trade" ? TRADE_API_URL : RENT_API_URL;
        const response = await fetch(`${endpoint}?serviceKey=${key.includes("%") ? key : encodeURIComponent(key)}&LAWD_CD=11170&DEAL_YMD=${ym}&pageNo=${page}&numOfRows=1000`, { signal: AbortSignal.timeout(30000), cache: "no-store" });
        const xml = await response.text();
        const status = getApiResultCode(xml);
        if (!response.ok || !["00","000","0"].includes(status.code)) throw new Error(`MOLIT status ${response.status} ${status.code}`);
        total = getApiTotalCount(xml);
        rows.push(...(kind === "trade" ? parseTradeXml(xml, "11170") : parseRentXml(xml, "11170")));
        if (page > 10) throw new Error("Page limit");
      }
      console.log("source", ym, kind, "total", total, "parsed", rows.length, JSON.stringify(rows.filter(t => ym === "202608" ? t.aptName === "이촌코오롱(A)" : t.dong === "이촌동" && (t.jibun === "415" || [185000,193000].includes(t.dealAmount)))));
      if (ym === "202503") {
        const wh = (await db.execute(`SELECT * FROM transactions WHERE lawd_cd='11170' AND year_month='202503' AND deal_type='trade'`)).rows.map(r=>({id:String(r.id),dealType:"trade" as const,dealDate:String(r.deal_date),aptName:String(r.apt_name),gu:String(r.gu),dong:String(r.dong),jibun:String(r.jibun),exclusiveArea:Number(r.exclusive_area),floor:Number(r.floor),dealAmount:Number(r.deal_amount),monthlyRent:0,buildYear:Number(r.build_year),dealingGbn:String(r.dealing_gbn)}));
        const active = resolveActiveTrades(rows, "11170").active;
        const keys = new Set(active.map(t=>naturalKeyFromTx(t,"11170")));
        const wkeys = new Set(wh.map(t=>naturalKeyFromTx(t,"11170")));
        const missing = active.filter(t=>!wkeys.has(naturalKeyFromTx(t,"11170")));
        const extra = wh.filter(t=>!keys.has(naturalKeyFromTx(t,"11170")));
        console.log("cell-diff", JSON.stringify({warehouse:wh.length,warehouseUnique:wkeys.size,sourceRaw:rows.length,sourceActive:active.length,missing:missing.length,extras:extra.length,targetMissing:missing.filter(t=>t.aptName==='한강(대우)'),targetExtras:extra.filter(t=>t.aptName==='한강(대우)')}));
      }
    }
    db.close();
    return;
  }
  if (process.argv.includes("--identity")) {
    for (const sql of [
      `SELECT apt_name,lawd_cd,gu,dong,COUNT(*) n FROM transactions WHERE apt_name_norm IN ('남산타운','서울역센트럴자이','롯데캐슬','삼성사이버빌리지') AND deal_type='trade' GROUP BY apt_name,lawd_cd,gu,dong`,
      `SELECT * FROM transactions WHERE lawd_cd='11170' AND deal_type='trade' AND deal_date IN ('2025-03-08','2025-03-15') AND (deal_amount IN (185000,193000) OR jibun='415')`,
      `SELECT apt_name,apt_name_norm,gu,dong,year_month,COUNT(*) n FROM transactions WHERE lawd_cd='11170' AND dong='이촌동' AND jibun='415' GROUP BY apt_name,apt_name_norm,gu,dong,year_month ORDER BY year_month DESC LIMIT 25`,
    ]) console.log("identity", JSON.stringify((await db.execute(sql)).rows));
    db.close();
    return;
  }
  const queries = [
    { label: "yongsan-targets", sql: `SELECT id,lawd_cd,year_month,deal_type,deal_date,apt_name,apt_name_norm,gu,dong,exclusive_area,deal_amount,monthly_rent,floor,jibun FROM transactions WHERE lawd_cd='11170' AND ((year_month='202608' AND apt_name LIKE '%코오롱%') OR (year_month='202503' AND apt_name LIKE '%한강%' AND exclusive_area BETWEEN 59 AND 61)) ORDER BY deal_date` },
    { label: "yongsan-names", sql: `SELECT apt_name,apt_name_norm,gu,dong,jibun,COUNT(*) n,MIN(deal_date) first,MAX(deal_date) last FROM transactions WHERE lawd_cd='11170' AND (apt_name LIKE '%코오롱%' OR apt_name LIKE '%한강%대우%') GROUP BY apt_name,apt_name_norm,gu,dong,jibun` },
    { label: "jung-sample", sql: `SELECT apt_name,apt_name_norm,gu,dong,COUNT(*) n,MAX(deal_date) last FROM transactions WHERE lawd_cd='11140' AND year_month>='202608' GROUP BY apt_name,apt_name_norm,gu,dong ORDER BY n DESC LIMIT 12` },
    { label: "sync-targets", sql: `SELECT * FROM sync_months WHERE lawd_cd IN ('11170','11140') AND year_month IN ('202608','202503')` },
  ];
  for (const q of queries) console.log(q.label, JSON.stringify((await db.execute(q.sql)).rows));
  db.close();
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
