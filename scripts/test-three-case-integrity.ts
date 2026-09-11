/** Local SQLite only: no credentials, no network, no production repair. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { getDb, ensureSchema } from "../src/lib/db/client";
import { replaceMonthTransactions, queryAptTransactions } from "../src/lib/db/repository";
import { GET } from "../src/app/api/apt-detail/route";
import { aptDetailHref, type AptDetailResponse } from "../src/lib/molit/apt";
import { priorTypeMaxAmount, typeRecordHigh } from "../src/lib/region/market-insight";
import { normalizeAreaKey, resolveDefaultAreaKey } from "../src/lib/apt/default-area";
import { formatComplexLocationLabel, readRecentComplexes, RECENT_COMPLEXES_KEY } from "../src/lib/complexes/recent-views";
import type { Transaction } from "../src/types/transaction";

process.env.TURSO_DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), "jiplab-integrity-")), "test.db")}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;

function tx(day: number, amount: number, area = 59.82): Transaction {
  return { id: `fixture-${day}-${area}`, aptName: "이촌코오롱(A)", lawdCd: "11170", gu: "용산구", dong: "이촌동", jibun: "412", dealType: "trade", dealDate: `2026-08-${String(day).padStart(2,"0")}`, dealAmount: amount, exclusiveArea: area, monthlyRent: 0, floor: 14, buildYear: 1999, dealingGbn: "중개거래" };
}

async function main() {
  const db = getDb()!;
  await ensureSchema(db);
  const items = [tx(1,100),tx(2,100),tx(3,90),tx(4,110),tx(5,1000,84.78)];
  await replaceMonthTransactions({lawdCd:"11170",yearMonth:"202608",dealKind:"trade",items});
  const response = await GET(new NextRequest("http://localhost/api/apt-detail?aptName="+encodeURIComponent("이촌코오롱(A)")+"&region=seoul-yongsan"));
  assert.equal(response.status,200);
  const detail = await response.json() as AptDetailResponse;
  const ordered = detail.items.filter(t=>t.exclusiveArea===59.82).sort((a,b)=>a.dealDate.localeCompare(b.dealDate));
  assert.deepEqual(ordered.map(t=>t.isSingoga),[true,false,false,true]);
  assert.deepEqual(ordered.map(t=>typeRecordHigh(t.dealAmount,priorTypeMaxAmount({...t,history:items.filter(i=>i.exclusiveArea===59.82)})).isSingoga),[true,false,false,true]);
  assert.equal(resolveDefaultAreaKey(detail.areas,detail.items),"84.78");
  const link = new URL(aptDetailHref("이촌코오롱(A)","seoul-yongsan","용산구",59.82),"http://localhost");
  assert.equal(link.searchParams.get("area"),"59.82");
  assert.equal(detail.items.filter(t=>normalizeAreaKey(t.exclusiveArea)===link.searchParams.get("area")).length,4);
  assert.equal(priorTypeMaxAmount({exclusiveArea:59.82,dealDate:"2026-08-01",history:items}),0);

  assert.equal(formatComplexLocationLabel({regionSlug:"seoul-jung",gu:"중구"}),"서울 중구");
  assert.equal(formatComplexLocationLabel({regionSlug:"busan-26110",gu:"중구"}),"부산 중구");
  const stored = JSON.stringify([{aptName:"남산타운",regionSlug:"seoul-jung",gu:"중구",regionLabel:"중구",viewedAt:1}]);
  Object.defineProperty(globalThis,"window",{configurable:true,value:{localStorage:{getItem:(key:string)=>key===RECENT_COMPLEXES_KEY?stored:null}}});
  assert.equal(readRecentComplexes()[0].regionLabel,"서울 중구");
  Reflect.deleteProperty(globalThis,"window");

  // The exact same name in a different LAWD must not enter the detail response.
  await replaceMonthTransactions({lawdCd:"11140",yearMonth:"202608",dealKind:"trade",items:[{...tx(1,100),aptName:"중구검증단지",gu:"중구"}]});
  await replaceMonthTransactions({lawdCd:"26110",yearMonth:"202608",dealKind:"trade",items:[{...tx(1,999),aptName:"중구검증단지",gu:"중구"}]});
  const scoped = await queryAptTransactions({lawdCodes:["11140"],aptName:"중구검증단지",yearMonths:[]});
  assert.deepEqual(scoped.map(t=>t.dealAmount),[100]);

  // Fail a later (>80 statements) chunk: no partial rows or completion marker.
  const originalTransaction = db.transaction.bind(db);
  db.transaction = (async () => {
    const transaction = await originalTransaction("write");
    const batch = transaction.batch.bind(transaction);
    let batches = 0;
    transaction.batch = async statements => {
      if (++batches === 2) throw new Error("injected second chunk failure");
      return batch(statements);
    };
    return transaction;
  }) as typeof db.transaction;
  const many = Array.from({length:100},(_,i)=>({...tx(1,10000+i),dealDate:"2026-07-01",aptName:"원자성검증",floor:i}));
  await assert.rejects(replaceMonthTransactions({lawdCd:"11170",yearMonth:"202607",dealKind:"trade",items:many}),/injected/);
  assert.equal(Number((await db.execute("SELECT COUNT(*) n FROM transactions WHERE year_month='202607'")).rows[0].n),0);
  assert.equal(Number((await db.execute("SELECT COUNT(*) n FROM sync_months WHERE year_month='202607'")).rows[0].n),0);
  db.transaction = originalTransaction;
  // Same count/latest date, changed identity: the authoritative preview sees it.
  const correction = await replaceMonthTransactions({lawdCd:"11170",yearMonth:"202608",dealKind:"trade",items:items.map((t,i)=>i===0?{...t,dealAmount:101}:t),dryRun:true});
  assert.equal(correction.inserted,1);
  assert.equal(correction.deleted,1);
  assert.doesNotMatch(readFileSync("scripts/sync-molit.ts","utf8"),/isCellUnchanged\(/);
  db.close();
  console.log("PASS: record sequence, shared region rule, clicked area, recent location migration, LAWD isolation, atomic rollback, correction diff");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
