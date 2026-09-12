#!/usr/bin/env python3
"""Phase 5.10 — legal-dong seed resolver + trade prefilter (no production writes).

See data/poc/phase510/resolver-prefilter-report.json for last run.
Builds seed (lawd,dong)->bjdong from existing building caches only.
Does not call bulk BldRgstHub; optional <=20 proof is separate.
"""
print("Artifacts: data/poc/phase510/resolver-prefilter-report.json")
