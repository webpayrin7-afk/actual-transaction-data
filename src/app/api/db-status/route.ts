import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db/client";
import { getSyncStats } from "@/lib/db/repository";

export const dynamic = "force-dynamic";

/** 웨어하우스 상태 확인 (시크릿 없으면 존재 여부만) */
export async function GET(request: NextRequest) {
  const secret = process.env.SYNC_ADMIN_SECRET?.trim();
  const provided = request.nextUrl.searchParams.get("secret")?.trim() ?? "";
  if (secret && provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!hasDb()) {
    return NextResponse.json({
      configured: false,
      months: 0,
      transactions: 0,
    });
  }

  const stats = await getSyncStats();
  return NextResponse.json({
    configured: true,
    ...stats,
  });
}
