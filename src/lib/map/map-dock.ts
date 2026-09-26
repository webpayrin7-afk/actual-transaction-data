/** 헤더 없이 지도가 화면 전체를 쓰는 경로 (지도 첫 화면) — 하단 독은 이 화면에서 조금 더 아래에 붙는다 */
export function isMapHomePath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p === "/" || p === "/map";
}
