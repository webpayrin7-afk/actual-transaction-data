/**
 * V3 hard-identity exclusions only.
 * Trade activity, recency, and household presence never exclude a candidate.
 */
import type { HardExcludeReasonV3 } from "./ranking-v3";

export type IdentityHardGateInput = {
  complexId: string;
  lawdCd: string;
  bjdongCd: string | null;
  aptNameNorm: string;
  identityStatus: string | null;
  ambiguousName: boolean;
};

export type IdentityHardGateResult =
  | { ok: true }
  | { ok: false; reason: HardExcludeReasonV3 };

export function evaluateHardIdentityV3(input: IdentityHardGateInput): IdentityHardGateResult {
  if (input.ambiguousName) return { ok: false, reason: "AMBIGUOUS_IDENTITY" };
  if (input.bjdongCd == null || String(input.bjdongCd).trim() === "") {
    return { ok: false, reason: "MISSING_BJDONG" };
  }
  if (!/^cx_[0-9a-f]{16}$/.test(input.complexId) || !input.lawdCd) {
    return { ok: false, reason: "CORRUPT_MASTER_IDENTITY" };
  }
  const status = (input.identityStatus ?? "").toUpperCase();
  if (status.includes("CONFLICT") || status.includes("DUPLICATE") || status === "INVALID") {
    return { ok: false, reason: "CORRUPT_MASTER_IDENTITY" };
  }
  return { ok: true };
}
