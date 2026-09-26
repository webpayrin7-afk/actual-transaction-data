/**
 * 3D 모형을 보여줄지 — 단지 상세 3D 카드와 3D 화면이 같은 기준을 쓴다 (서버·클라이언트 공용, DB 없음).
 *
 * 기본은 "모양(GIS 외곽선)이 연결된 건물이 하나라도 있으면 보여준다".
 * 예외 하나: 모양이 있는 건물이 모두 분명한 비주거 건물(어린이집·상가·근린생활시설 등)이고,
 * 단지에 주거동이 따로 있는데 그 주거동에는 모양이 없을 때만 숨긴다 — 파크리오처럼 어린이집 하나만 모양이 있으면
 * 3D로 단지를 보여줄 수 없다.
 * 주거동이 하나도 없는 단지(한 동짜리 주상복합·빌딩형, 주용도 업무시설·근린생활시설)는 그 건물이 곧 단지라 그대로 보여준다.
 */
type GateBuilding = {
  residential: boolean;
  households: number | null;
  usage: string | null;
  rings: unknown[] | null;
};

/** 주거동 — 건축HUB 주거 표시가 있거나 세대가 있는 건물 */
function isResidential(b: GateBuilding): boolean {
  return b.residential || (b.households ?? 0) > 0;
}

/** 분명한 비주거 — 주거 표시·세대가 없고, 주용도가 있으면서 주택 용도(공동주택·단독주택·아파트·기숙사)가 아닌 건물 */
function isClearlyNonResidential(b: GateBuilding): boolean {
  if (isResidential(b)) return false;
  return !!b.usage && !/주택|아파트|기숙사/.test(b.usage);
}

export function has3dModel(buildings: ReadonlyArray<GateBuilding>): boolean {
  const shaped = buildings.filter((b) => b.rings);
  if (!shaped.length) return false;
  if (!buildings.some(isResidential)) return true;
  return shaped.some((b) => !isClearlyNonResidential(b));
}
