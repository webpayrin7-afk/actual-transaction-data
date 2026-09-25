import json
from pathlib import Path
plan = json.loads(Path("data/poc/supply/real-variant-plan.json").read_text(encoding="utf-8"))
rows = plan["decisions"][:3]
Path("data/poc/supply/real-variant-sample.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
print(plan["summary"])
