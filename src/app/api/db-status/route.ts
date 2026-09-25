import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db/client";
import { getSyncStats } from "@/lib/db/repository";

export const dynamic = "force-dynamic";

/**
 * 웨어하우스 상태 확인 (관리용).
 * - Vercel(Production/Preview)에서는 SYNC_ADMIN_SECRET 필수 — 미설정이면 항상 401.
 * - 기본 응답은 싸다: months + syncedRowCount(sync_months.row_count 합).
 *   syncedRowCount 는 실제 transactions 행수가 아니다(과소 집계).
 * - 정확한 transactions 행수는 ?exact=1 일 때만 COUNT(*) (1,300만 행 스캔, 수십 초).
 *   exact 가 아니면 transactions 는 null.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.SYNC_ADMIN_SECRET?.trim();
  const provided = request.nextUrl.searchParams.get("secret")?.trim() ?? "";
  if (!secret && process.env.VERCEL) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (secret && provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const exact = request.nextUrl.searchParams.get("exact") === "1";

  if (!hasDb()) {
    return NextResponse.json({
      configured: false,
      months: 0,
      syncedRowCount: 0,
      transactions: exact ? 0 : null,
    });
  }

  const stats = await getSyncStats({ exact });
  return NextResponse.json({
    configured: true,
    ...stats,
  });
}
