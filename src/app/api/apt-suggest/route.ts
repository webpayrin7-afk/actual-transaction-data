import { NextRequest, NextResponse } from "next/server";
import { searchAptSuggestions } from "@/lib/molit/apt";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 1) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    const suggestions = await searchAptSuggestions(q, 8);
    return NextResponse.json({ suggestions });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "단지 검색에 실패했습니다.", suggestions: [] },
      { status: 500 },
    );
  }
}
