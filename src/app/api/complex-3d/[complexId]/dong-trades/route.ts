import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * 동별 매매 실거래 — 국토부 거래 동(aptDong, transactions.apt_dong)이 이 동인 거래.
 * 거래 동은 등기된 2023년 이후 거래만 있다. ?dong=115동 (또는 115)
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ complexId: string }> }) {
  const { complexId } = await params;
  const dong = (request.nextUrl.searchParams.get("dong") ?? "").trim().replace(/동$/, "");
  if (!/^cx_[0-9a-f]{16}$/.test(complexId) || !dong || dong.length > 12) {
    return NextResponse.json({ error: "요청이 올바르지 않습니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ trades: [], total: 0 }, { status: 503 });
  try {
    const m = await db.execute({
      sql: `SELECT lawd_cd, apt_name_norm FROM apt_complex_master WHERE complex_id = ?`,
      args: [complexId],
    });
    const row = m.rows[0];
    if (!row) return NextResponse.json({ trades: [], total: 0 }, { status: 404 });
    // 거래 동은 2023년부터라 year_month 조건으로 (lawd, 단지명, 연월) 색인을 타게 한다
    const where = `lawd_cd = ? AND apt_name_norm = ? AND year_month >= '202301' AND deal_type = 'trade' AND (apt_dong = ? OR apt_dong = ?)`;
    const args = [String(row.lawd_cd), String(row.apt_name_norm), dong, `${dong}동`];
    const [list, count, covered] = await Promise.all([
      db.execute({
        sql: `SELECT deal_date, deal_amount, exclusive_area, floor, rgst_date FROM transactions INDEXED BY idx_tx_lawd_apt_ym WHERE ${where}
              ORDER BY deal_date DESC LIMIT 5`,
        args,
      }),
      db.execute({ sql: `SELECT count(*) n FROM transactions INDEXED BY idx_tx_lawd_apt_ym WHERE ${where}`, args }),
      // 이 단지에 거래 동이 들어 있는지 (없으면 "아직 준비 중")
      db.execute({
        sql: `SELECT 1 FROM transactions INDEXED BY idx_tx_lawd_apt_ym WHERE lawd_cd = ? AND apt_name_norm = ? AND year_month >= '202301' AND deal_type = 'trade' AND apt_dong IS NOT NULL AND apt_dong <> '' LIMIT 1`,
        args: args.slice(0, 2),
      }),
    ]);
    return NextResponse.json(
      {
        total: Number(count.rows[0]?.n ?? 0),
        available: covered.rows.length > 0,
        trades: list.rows.map((r) => ({
          dealDate: String(r.deal_date),
          amount: Number(r.deal_amount),
          area: Number(r.exclusive_area),
          floor: Number(r.floor),
          registered: !!r.rgst_date,
        })),
      },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch (error) {
    console.error("[dong-trades]", error);
    return NextResponse.json({ trades: [], total: 0, available: false }, { status: 500 });
  }
}
