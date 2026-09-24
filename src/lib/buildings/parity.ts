import type { ParityClass } from "./types";

export function classifyParity(input: {
  kaptHousehold: number | null;
  unitHousehold: number | null;
  typeHouseholdSum: number | null;
  buildingHouseholdSum: number | null;
}): { parityClass: ParityClass; detail: string } {
  const values = [
    input.kaptHousehold,
    input.unitHousehold,
    input.typeHouseholdSum,
    input.buildingHouseholdSum,
  ].filter((n): n is number => n != null && Number.isFinite(n) && n > 0);

  if (values.length === 0) {
    return { parityClass: "NO_SOURCE", detail: "no household sources" };
  }
  if (values.length === 1) {
    return { parityClass: "PARTIAL_SOURCE", detail: "single household source" };
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const base = input.kaptHousehold ?? max;
  if (min === max) {
    return { parityClass: "PARITY", detail: `all=${min}` };
  }
  const abs = max - min;
  const rel = base > 0 ? abs / base : 1;
  if (abs <= 5 || rel <= 0.02) {
    return {
      parityClass: "MINOR_SCOPE_DIFF",
      detail: `kapt=${input.kaptHousehold} unit=${input.unitHousehold} type=${input.typeHouseholdSum} bldg=${input.buildingHouseholdSum}`,
    };
  }
  if (rel <= 0.25 && values.length < 4) {
    return {
      parityClass: "PARTIAL_SOURCE",
      detail: `kapt=${input.kaptHousehold} unit=${input.unitHousehold} type=${input.typeHouseholdSum} bldg=${input.buildingHouseholdSum}`,
    };
  }
  return {
    parityClass: "MAJOR_MISMATCH",
    detail: `kapt=${input.kaptHousehold} unit=${input.unitHousehold} type=${input.typeHouseholdSum} bldg=${input.buildingHouseholdSum}`,
  };
}
