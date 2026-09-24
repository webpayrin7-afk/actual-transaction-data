/**
 * National master expansion gate.
 * SAFE rows are the only writable class. This module never writes a database.
 */

export const CAPITAL_SIDO = ["11", "41"] as const;

export const SIDO_LABEL: Record<string, string> = {
  "11": "서울특별시",
  "26": "부산광역시",
  "27": "대구광역시",
  "28": "인천광역시",
  "29": "광주광역시",
  "30": "대전광역시",
  "31": "울산광역시",
  "36": "세종특별자치시",
  "41": "경기도",
  "42": "강원특별자치도",
  "43": "충청북도",
  "44": "충청남도",
  "45": "전북특별자치도",
  "46": "전라남도",
  "47": "경상북도",
  "48": "경상남도",
  "50": "제주특별자치도",
};

export const NATIONAL_SIDO_CODES = Object.keys(SIDO_LABEL);

export type SidoWaveInput = {
  sido_code: string;
  candidate_safe: number;
  legal_dong_resolver: boolean;
  sync_lawds: number;
  cadastral_source: boolean;
  pnu_source: boolean;
};

export type MasterGateInput = {
  selected_sido: string[];
  safe: number;
  ambiguous_in_payload: number;
  unresolved_in_payload: number;
  duplicate_complex_id: number;
  duplicate_external_identity: number;
  invalid_sido_lawd: number;
  existing_row_overwrite: number;
  provenance_missing: number;
  expected_candidate_count: number;
};

export function selectFirstWave(rows: SidoWaveInput[]): string[] {
  const ranked = rows
    .filter((r) => !CAPITAL_SIDO.includes(r.sido_code as (typeof CAPITAL_SIDO)[number]))
    .filter((r) => r.candidate_safe > 0 && r.legal_dong_resolver)
    .sort(
      (a, b) =>
        b.candidate_safe - a.candidate_safe ||
        Number(b.pnu_source) - Number(a.pnu_source) ||
        Number(b.cadastral_source) - Number(a.cadastral_source) ||
        b.sync_lawds - a.sync_lawds ||
        a.sido_code.localeCompare(b.sido_code),
    );
  if (ranked.length < 2) return [];
  return ranked.slice(0, 3).map((r) => r.sido_code);
}

export function evaluateMasterGate(input: MasterGateInput): {
  pass: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (input.selected_sido.length < 2 || input.selected_sido.length > 3) {
    reasons.push("wave_size");
  }
  if (input.selected_sido.some((s) => CAPITAL_SIDO.includes(s as (typeof CAPITAL_SIDO)[number]))) {
    reasons.push("capital_sido_in_wave");
  }
  if (input.safe !== input.expected_candidate_count) reasons.push("expected_count");
  if (input.safe <= 0) reasons.push("safe_count");
  if (input.ambiguous_in_payload !== 0) reasons.push("ambiguous_in_payload");
  if (input.unresolved_in_payload !== 0) reasons.push("unresolved_in_payload");
  if (input.duplicate_complex_id !== 0) reasons.push("duplicate_complex_id");
  if (input.duplicate_external_identity !== 0) reasons.push("duplicate_external_identity");
  if (input.invalid_sido_lawd !== 0) reasons.push("invalid_sido_lawd");
  if (input.existing_row_overwrite !== 0) reasons.push("existing_row_overwrite");
  if (input.provenance_missing !== 0) reasons.push("provenance_missing");
  return { pass: reasons.length === 0, reasons };
}

/** Apply stays unimplemented until a later wave has a PASS gate and an explicit writer. */
export function productionApplyAllowed(gatePass: boolean): false {
  void gatePass;
  return false;
}
