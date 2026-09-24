/**
 * Live call list: one request per (service, op) used by phase71c or phase26.
 * Op names that both catalogs share on different services stay as separate calls.
 */
import {
  MAIN_CATALOG,
  REFERENCE_CATALOG,
  type CatalogOp,
  type FeeService,
} from "./op-catalog";

export type LiveCall = {
  op: string;
  service: FeeService;
  service_name: string;
  in_main: boolean;
  in_reference: boolean;
};

export function serviceName(service: FeeService): string {
  if (service === "common") return "AptCmnuseManageCostServiceV3";
  if (service === "individual") return "AptIndvdlzManageCostServiceV3";
  return "AptRepairsCostServiceV3";
}

export function callKey(service: FeeService, op: string): string {
  return `${service}:${op}`;
}

export function buildLiveCalls(): LiveCall[] {
  const map = new Map<string, LiveCall>();
  const add = (rows: readonly CatalogOp[], side: "main" | "reference") => {
    for (const row of rows) {
      const key = callKey(row.service, row.op);
      const current = map.get(key) ?? {
        op: row.op,
        service: row.service,
        service_name: serviceName(row.service),
        in_main: false,
        in_reference: false,
      };
      if (side === "main") current.in_main = true;
      else current.in_reference = true;
      map.set(key, current);
    }
  };
  add(MAIN_CATALOG, "main");
  add(REFERENCE_CATALOG, "reference");
  return [...map.values()];
}
