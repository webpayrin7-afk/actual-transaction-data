/**
 * PHASE D3: one production partial index for Home discovery_at range.
 *
 *   npx tsx scripts/create-discovery-index-d3.ts --precheck=1
 *   npx tsx scripts/create-discovery-index-d3.ts
 *
 * Creates ONLY:
 *   CREATE INDEX IF NOT EXISTS idx_tx_type_discovery
 *   ON transactions (deal_type, discovery_at)
 *   WHERE discovery_at IS NOT NULL;
 *
 * No transaction INSERT/UPDATE/DELETE. No second index. No cron enable.
 */
import { createClient } from "@libsql/client";
import { TRUSTED_DISCOVERY_COPY } from "../src/lib/db/discovery-axis";
import { seoulDayBoundsUtc, seoulToday } from "../src/lib/market/time";

const EXPECTED_NN = 2304;
const INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_tx_type_discovery
ON transactions (deal_type, discovery_at)
WHERE discovery_at IS NOT NULL`;

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function n(v: unknown): number {
  return Number(v ?? 0);
}

function explainDetail(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((r) => String(r.detail ?? JSON.stringify(r)));
}

async function main() {
  const precheckOnly = argValue("precheck", "0") === "1";
  const url = process.env.TURSO_DATABASE_URL?.trim() ?? "";
  const token = process.env.TURSO_AUTH_TOKEN?.trim() ?? "";
  if (!url || url.startsWith("file:")) {
    throw new Error("STOP: need remote TURSO_DATABASE_URL (not file:)");
  }
  if (!token) throw new Error("STOP: TURSO_AUTH_TOKEN missing");
  console.log(JSON.stringify({ remote: true, url_prefix: url.slice(0, 18) }));

  const db = createClient({ url, authToken: token });
  const today = seoulToday();
  const { startIso, endIso } = seoulDayBoundsUtc(today);

  const cols = await db.execute("PRAGMA table_info(transactions)");
  const names = cols.rows.map((r) => String(r.name));
  if (!names.includes("discovery_at")) {
    throw new Error("STOP: transactions.discovery_at missing");
  }

  const total = await db.execute("SELECT COUNT(*) AS n FROM transactions");
  const nn = await db.execute(
    `SELECT COUNT(*) AS n FROM transactions WHERE discovery_at IS NOT NULL`,
  );
  const nnNe = await db.execute(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE discovery_at IS NOT NULL AND discovery_at != ''`,
  );
  const todayAll = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM transactions
          WHERE discovery_at IS NOT NULL AND discovery_at != ''
            AND discovery_at >= ? AND discovery_at < ?`,
    args: [startIso, endIso],
  });
  const idxList = await db.execute("PRAGMA index_list(transactions)");
  const idxNames = idxList.rows.map((r) => String(r.name));

  const pre = {
    discovery_at_exists: true,
    transactions_total: n(total.rows[0]?.n),
    discovery_nn: n(nn.rows[0]?.n),
    discovery_nn_ne: n(nnNe.rows[0]?.n),
    today_kst: today,
    today_total: n(todayAll.rows[0]?.n),
    indexes: idxNames,
    already_has_discovery_index: idxNames.includes("idx_tx_type_discovery"),
  };
  console.log(JSON.stringify({ step: "precheck", ...pre }, null, 2));

  if (pre.discovery_nn !== EXPECTED_NN) {
    throw new Error(
      `STOP: discovery_at IS NOT NULL = ${pre.discovery_nn} (expected ${EXPECTED_NN})`,
    );
  }

  const explBefore = await db.execute({
    sql: `EXPLAIN QUERY PLAN
          SELECT COUNT(*) FROM transactions
          WHERE deal_type = 'trade'
            AND discovery_at IS NOT NULL
            AND discovery_at != ''
            AND discovery_at >= ?
            AND discovery_at < ?`,
    args: [startIso, endIso],
  });
  const explBeforeDetails = explainDetail(explBefore.rows as Array<Record<string, unknown>>);
  console.log(JSON.stringify({ step: "explain_before", plan: explBeforeDetails }, null, 2));

  if (precheckOnly) {
    console.log(JSON.stringify({ step: "precheck_only_done" }));
    return;
  }

  if (pre.already_has_discovery_index) {
    console.log(JSON.stringify({ step: "index_exists_skip_create" }));
  } else {
    const t0 = Date.now();
    const created = await db.execute(INDEX_SQL);
    const buildMs = Date.now() - t0;
    console.log(
      JSON.stringify({
        step: "create_index",
        build_ms: buildMs,
        rowsAffected: created.rowsAffected,
        lastInsertRowid: String(created.lastInsertRowid ?? ""),
      }),
    );
  }

  const idxAfter = await db.execute("PRAGMA index_list(transactions)");
  const idxAfterNames = idxAfter.rows.map((r) => String(r.name));
  const master = await db.execute(
    `SELECT name, sql FROM sqlite_master
     WHERE type='index' AND name='idx_tx_type_discovery'`,
  );
  const xinfo = await db.execute("PRAGMA index_xinfo(idx_tx_type_discovery)");
  let stat1: unknown = null;
  try {
    const st = await db.execute(
      `SELECT * FROM sqlite_stat1 WHERE idx='idx_tx_type_discovery'`,
    );
    stat1 = st.rows;
  } catch {
    stat1 = "sqlite_stat1 unavailable";
  }

  console.log(
    JSON.stringify(
      {
        step: "index_verify",
        exists: idxAfterNames.includes("idx_tx_type_discovery"),
        sql: master.rows[0]?.sql ?? null,
        xinfo: xinfo.rows,
        sqlite_stat1: stat1,
        all_indexes: idxAfterNames,
      },
      null,
      2,
    ),
  );
  if (!idxAfterNames.includes("idx_tx_type_discovery")) {
    throw new Error("STOP: idx_tx_type_discovery missing after CREATE");
  }

  const explAfter = await db.execute({
    sql: `EXPLAIN QUERY PLAN
          SELECT COUNT(*) FROM transactions
          WHERE deal_type = 'trade'
            AND discovery_at IS NOT NULL
            AND discovery_at != ''
            AND discovery_at >= ?
            AND discovery_at < ?`,
    args: [startIso, endIso],
  });
  const explAfterDetails = explainDetail(explAfter.rows as Array<Record<string, unknown>>);
  console.log(JSON.stringify({ step: "explain_after", plan: explAfterDetails }, null, 2));

  const usesDiscoveryIdx = explAfterDetails.some((d) =>
    d.includes("idx_tx_type_discovery"),
  );
  const usesFirstSeenIdx = explAfterDetails.some((d) =>
    d.includes("idx_tx_type_first_seen"),
  );
  const constrainsRange = explAfterDetails.some(
    (d) =>
      d.includes("discovery_at") &&
      (d.includes(">") || d.includes("<") || d.includes("RANGE") || d.includes("=")),
  );
  console.log(
    JSON.stringify({
      step: "explain_gate",
      uses_idx_tx_type_discovery: usesDiscoveryIdx,
      uses_idx_tx_type_first_seen: usesFirstSeenIdx,
      mentions_discovery_range: constrainsRange,
      plan: explAfterDetails,
    }),
  );
  if (!usesDiscoveryIdx || usesFirstSeenIdx) {
    throw new Error(
      `STOP: planner did not switch to idx_tx_type_discovery: ${explAfterDetails.join(" | ")}`,
    );
  }

  const homeSql = `SELECT COUNT(*) AS n FROM transactions
          WHERE deal_type = 'trade'
            AND discovery_at IS NOT NULL
            AND discovery_at != ''
            AND discovery_at >= ?
            AND discovery_at < ?`;

  const tCold0 = Date.now();
  const cold = await db.execute({ sql: homeSql, args: [startIso, endIso] });
  const coldMs = Date.now() - tCold0;
  const tWarm0 = Date.now();
  const warm = await db.execute({ sql: homeSql, args: [startIso, endIso] });
  const warmMs = Date.now() - tWarm0;
  console.log(
    JSON.stringify({
      step: "home_count_perf",
      cold_ms: coldMs,
      warm_ms: warmMs,
      cold_n: n(cold.rows[0]?.n),
      warm_n: n(warm.rows[0]?.n),
    }),
  );

  const byLawd = await db.execute({
    sql: `SELECT lawd_cd, COUNT(*) AS n
          FROM transactions
          WHERE discovery_at IS NOT NULL AND discovery_at != ''
            AND discovery_at >= ? AND discovery_at < ?
          GROUP BY lawd_cd`,
    args: [startIso, endIso],
  });
  const map = new Map<string, number>();
  for (const r of byLawd.rows) map.set(String(r.lawd_cd), n(r.n));
  const sum = (...codes: string[]) => codes.reduce((a, c) => a + (map.get(c) ?? 0), 0);

  const gn08 = await db.execute(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE lawd_cd='11680' AND discovery_at IS NOT NULL AND discovery_at != ''
       AND date(discovery_at, '+9 hours') = '2026-09-08'`,
  );
  const mijub = await db.execute(
    `SELECT apt_name, deal_date, deal_amount, first_seen_at, discovery_at, last_seen_at
     FROM transactions
     WHERE lawd_cd='11170' AND deal_date='2026-06-30' AND deal_amount=178000
       AND replace(apt_name,' ','') LIKE '%미주%'`,
  );
  const trusted = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM transactions
          WHERE discovery_at IS NOT NULL AND discovery_at >= ? AND discovery_at < ?`,
    args: [TRUSTED_DISCOVERY_COPY.fromInclusive, TRUSTED_DISCOVERY_COPY.toExclusive],
  });
  const nnAfter = await db.execute(
    `SELECT COUNT(*) AS n FROM transactions WHERE discovery_at IS NOT NULL`,
  );

  const correctness = {
    discovery_total: n(nnAfter.rows[0]?.n),
    today_total: sum(...map.keys()),
    home_trade: n(warm.rows[0]?.n),
    gangnam: sum("11680"),
    songpa: sum("11710"),
    yongsan: sum("11170"),
    seongnam: sum("41131", "41133", "41135"),
    suwon: sum("41111", "41113", "41115", "41117"),
    namyangju: sum("41360"),
    gangnam_9_8_discovery: n(gn08.rows[0]?.n),
    trusted_window: n(trusted.rows[0]?.n),
    mijub: mijub.rows.map((r) => ({
      apt_name: String(r.apt_name),
      deal_date: String(r.deal_date),
      deal_amount: n(r.deal_amount),
      first_seen_at: r.first_seen_at == null ? null : String(r.first_seen_at),
      discovery_at: r.discovery_at == null ? null : String(r.discovery_at),
      last_seen_at: r.last_seen_at == null ? null : String(r.last_seen_at),
    })),
  };
  console.log(JSON.stringify({ step: "correctness", ...correctness }, null, 2));

  const expectedCounts = {
    discovery_total: 2304,
    today_total: 2304,
    home_trade: 698,
    gangnam: 78,
    songpa: 55,
    yongsan: 20,
    seongnam: 80,
    suwon: 140,
    namyangju: 139,
    gangnam_9_8_discovery: 0,
  };
  const mismatches = Object.entries(expectedCounts).filter(
    ([k, v]) => correctness[k as keyof typeof expectedCounts] !== v,
  );
  const mijubOk =
    correctness.mijub.length >= 1 &&
    correctness.mijub.some(
      (r) =>
        r.deal_amount === 178000 &&
        r.deal_date.startsWith("2026-06-30") &&
        (r.discovery_at == null || r.discovery_at === ""),
    );
  console.log(
    JSON.stringify({
      step: "correctness_gate",
      mismatches,
      mijub_historical: correctness.mijub.length >= 1,
      mijub_discovery_absent: mijubOk,
      unchanged: mismatches.length === 0 && mijubOk,
    }),
  );
  if (mismatches.length || !mijubOk) {
    throw new Error("STOP: discovery counts changed after index");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
