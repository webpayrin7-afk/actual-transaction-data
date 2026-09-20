import type { HeightStatus, ThreeDClass } from "./types";

export type { ThreeDClass };
export { THREE_D_CLASSES } from "./types";

export function classifyThreeD(input: {
  hasOfficialFootprint: boolean;
  heightStatus: HeightStatus | null;
}): ThreeDClass {
  if (!input.hasOfficialFootprint) return "NO_GEOMETRY";
  if (input.heightStatus === "OFFICIAL_HEIGHT") return "3D_EXACT";
  if (input.heightStatus === "FLOOR_COUNT_ONLY") return "3D_PARTIAL";
  return "FOOTPRINT_ONLY";
}
