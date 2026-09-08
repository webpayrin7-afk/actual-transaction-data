import { NextResponse } from "next/server";
import { getLabHome } from "@/lib/lab/compute";

/** 실험 데이터는 초 단위 실시간 불필요 — market-home과 동일 패턴 */
export const revalidate = 60;

export async function GET() {
  try {
    const data = await getLabHome();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    console.error("[lab]", error);
    return NextResponse.json(
      { error: "실험실 데이터를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
