-- Representative supply for a real A/B variant of the same exclusive area.
-- Does not replace or delete apt_canonical_unit_types rows.
-- variants_json: [{ "supplyCents": number, "householdCount": number }]

CREATE TABLE IF NOT EXISTS apt_unit_supply_representative (
  complex_id TEXT NOT NULL,
  exclusive_cents INTEGER NOT NULL,
  representative_supply_cents INTEGER NOT NULL,
  representative_household_count INTEGER NOT NULL,
  variant_count INTEGER NOT NULL,
  variants_json TEXT NOT NULL,
  rule TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, exclusive_cents)
);
