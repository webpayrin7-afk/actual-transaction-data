import type { Complex3d } from "@/lib/complex-3d/read";

/**
 * 단지 상세용 동 모양 요청 (3D 카드 노출 여부·타입·동 지도가 같은 캐시를 쓴다).
 * `shapes=1` — 주변 건물·층별 시세·학교·역을 빼서 3D 페이지 전체 응답보다 훨씬 가볍다.
 */
export async function fetchComplex3dShapes(complexId: string): Promise<Complex3d | null> {
  const res = await fetch(`/api/complex-3d/${complexId}?v=2&shapes=1`);
  if (!res.ok) return null;
  return res.json();
}
