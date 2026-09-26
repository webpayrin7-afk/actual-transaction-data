import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** 지금 배포 번호 — 화면이 예전 배포로 떠 있는지 확인용 (NewVersionReload). 캐시하지 않는다 */
export function GET() {
  return NextResponse.json(
    { id: process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
