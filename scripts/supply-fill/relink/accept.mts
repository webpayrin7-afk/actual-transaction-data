/**
 * Parcel relink, step 4 (local files only): acceptance check for every candidate PNU.
 *
 * Per candidate the registry rows are taken under ONE code (cadastre code first, predecessor only
 * when the earlier code has no rows), exactly like fill-notrade-local.mts. Units are the 아파트
 * 전유부 (주건축물) units of deriveOfficialSupplies (no name filter).
 *
 * Acceptance (must pass, exact):
 *   G2  every exclusive the complex already has (canonical unit rows ∪ trade exclusive pairs,
 *       cents) appears among the parcel's apartment unit exclusives.
 *   nt  the complex has no exclusives in the DB, so the check is the K-apt household count:
 *       parcel apartment units == K-apt 세대수 exactly. No K-apt count → held.
 *   A candidate owned by another master complex is held (SHARED_PNU). More than one passing
 *   parcel → held (AMBIGUOUS). One parcel accepted for two complexes → both held.
 *   Multi-parcel unions are not attempted: the local 전유공용 file has no 관리번호 group key.
 *
 * Usage: ./node_modules/.bin/tsx scripts/supply-fill/relink/accept.mts WORK_DIR
 * Writes WORK_DIR/accept.jsonl, nt-targets.jsonl, g2-targets.jsonl, expos-accepted.jsonl,
 *        accept-summary.json, samples.json
 */
import { closeSync, createReadStream, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { exclusiveCents } from "../../../src/lib/unit-type/canonical";
import { deriveOfficialSupplies, type ExposRow } from "../../../src/lib/unit-type/official-expos";

const WORK = process.argv[2]!;
type Cand = { pnu: string; methods: string[]; lot: string; jimok: string; dist: number | null; registryPnus: string[]; owners: string[] };
type Target = {
  kind: "nt" | "g2";
  complexId: string;
  aptName: string;
  reason: string;
  lawdCd: string;
  sido: string;
  sigungu: string;
  roadAddress: string;
  kaptHouseholds: number | null;
  canonical: [number, number, string, number][];
  pairs: [number, number, number][];
  phase3: { t3y: number; trades: number };
  candidates: Cand[];
  point: [number, number] | null;
  onRoad: boolean;
};
type FileRow = ExposRow & { pnu: string; exposCd?: string; mainAtchCd?: string; mainPurpsCd?: string };
const str = (v: unknown) => (v == null ? "" : String(v).trim());

function toExpos(row: FileRow): ExposRow {
  let expos = str(row.exposPubuseGbCdNm);
  if (!expos && row.exposCd === "1") expos = "전유";
  if (!expos && row.exposCd === "2") expos = "공용";
  let atch = str(row.mainAtchGbCdNm);
  if (!atch && row.mainAtchCd === "0") atch = "주건축물";
  if (!atch && row.mainAtchCd === "1") atch = "부속건축물";
  let purps = str(row.mainPurpsCdNm);
  if (!purps && row.mainPurpsCd === "02001") purps = "아파트";
  return {
    dongNm: str(row.dongNm), hoNm: str(row.hoNm), flrNo: str(row.flrNo), exposPubuseGbCdNm: expos,
    mainAtchGbCdNm: atch, mainPurpsCdNm: purps, etcPurps: str(row.etcPurps), area: row.area, bldNm: "",
  };
}

const targets = readFileSync(`${WORK}/candidates.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Target);
const wanted = new Set(targets.flatMap((t) => t.candidates.flatMap((c) => c.registryPnus)));
const rawByPnu = new Map<string, string[]>();
const rl = createInterface({ input: createReadStream(`${WORK}/registry-expos.jsonl`, { encoding: "utf8" }), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  const pnu = line.slice(9, 28);
  if (!wanted.has(pnu)) continue;
  const list = rawByPnu.get(pnu) ?? [];
  list.push(line);
  rawByPnu.set(pnu, list);
}

type Eval = { pnu: string; registryPnu: string; methods: string[]; jimok: string; lot: string; dist: number | null;
  units: number; exclusives: number[]; result: string; missing?: number[] };
const results: Record<string, unknown>[] = [];
const acceptedBy = new Map<string, string[]>();
for (const t of targets) {
  const required = [...new Set([...t.canonical.map((c) => c[0]), ...t.pairs.map((p) => p[0])])].sort((a, b) => a - b);
  const evals: Eval[] = [];
  for (const c of t.candidates) {
    const registryPnu = c.registryPnus.find((p) => (rawByPnu.get(p)?.length ?? 0) > 0) ?? "";
    const base = { pnu: c.pnu, registryPnu, methods: c.methods, jimok: c.jimok, lot: c.lot, dist: c.dist, units: 0, exclusives: [] as number[] };
    if (!registryPnu) { evals.push({ ...base, result: "NO_REGISTRY_ROWS" }); continue; }
    const rows = rawByPnu.get(registryPnu)!.map((l) => toExpos(JSON.parse(l) as FileRow));
    const derived = deriveOfficialSupplies(rows, t.aptName);
    const exSet = new Set(derived.units.map((u) => exclusiveCents(u.exclusiveArea)));
    const ev: Eval = { ...base, units: derived.units.length, exclusives: [...exSet].sort((a, b) => a - b), result: "" };
    if (derived.units.length === 0) ev.result = "NO_APT_UNITS";
    else if (t.kind === "g2") {
      const missing = required.filter((e) => !exSet.has(e));
      ev.result = required.length === 0 ? "NO_REFERENCE" : missing.length ? "EXCLUSIVE_NOT_COVERED" : "PASS";
      if (missing.length) ev.missing = missing;
    } else {
      const hh = t.kaptHouseholds ?? 0;
      ev.result = !(hh > 0) ? "NO_KAPT_HOUSEHOLDS" : derived.units.length === hh ? "PASS" : "HOUSEHOLD_MISMATCH";
    }
    if (ev.result === "PASS" && c.owners.length > 0) ev.result = "SHARED_PNU";
    evals.push(ev);
  }
  const pass = evals.filter((e) => e.result === "PASS");
  const distinct = [...new Set(pass.map((e) => e.registryPnu))];
  let decision: string;
  if (t.candidates.length === 0) decision = t.point ? "NO_CANDIDATE" : "NO_POINT";
  else if (distinct.length === 1) decision = "ACCEPTED";
  else if (distinct.length > 1) decision = "AMBIGUOUS";
  else {
    const order = ["SHARED_PNU", "HOUSEHOLD_MISMATCH", "EXCLUSIVE_NOT_COVERED", "NO_KAPT_HOUSEHOLDS", "NO_REFERENCE", "NO_APT_UNITS", "NO_REGISTRY_ROWS"];
    decision = order.find((o) => evals.some((e) => e.result === o)) ?? "NO_CANDIDATE";
  }
  const chosen = decision === "ACCEPTED" ? pass.find((e) => e.registryPnu === distinct[0])! : null;
  if (chosen) acceptedBy.set(chosen.registryPnu, [...(acceptedBy.get(chosen.registryPnu) ?? []), t.complexId]);
  results.push({ kind: t.kind, complexId: t.complexId, aptName: t.aptName, reason: t.reason, lawdCd: t.lawdCd, sido: t.sido,
    sigungu: t.sigungu, roadAddress: t.roadAddress, onRoad: t.onRoad, kaptHouseholds: t.kaptHouseholds, required,
    t3y: t.pairs.reduce((n, p) => n + (p[2] ?? 0), 0), decision, chosen, evals });
}
for (const r of results) {
  const chosen = r.chosen as Eval | null;
  if (chosen && (acceptedBy.get(chosen.registryPnu)?.length ?? 0) > 1) {
    r.decision = "SAME_PARCEL_TWO_COMPLEXES";
    r.chosen = null;
  }
}

const accepted = results.filter((r) => r.decision === "ACCEPTED");
const methodOf = (e: Eval) => e.methods.join("+");
writeFileSync(`${WORK}/accept.jsonl`, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(`${WORK}/nt-targets.jsonl`, accepted.filter((r) => r.kind === "nt").map((r) => {
  const e = r.chosen as Eval;
  return JSON.stringify({ complexId: r.complexId, aptName: r.aptName, lawdCd: r.lawdCd, sido: r.sido, sigungu: r.sigungu,
    cadastrePnu: e.pnu, registryPnus: [e.registryPnu], identityStatus: "RELINKED", cadastre: "EXISTS", pnuOwners: 1,
    identity: `RELINK_${methodOf(e)}+KAPT_HOUSEHOLDS_EQ`, relinkReason: r.reason });
}).join("\n") + "\n");
writeFileSync(`${WORK}/g2-targets.jsonl`, accepted.filter((r) => r.kind === "g2").map((r) => {
  const e = r.chosen as Eval;
  return JSON.stringify({ complexId: r.complexId, aptName: r.aptName, pnu: e.registryPnu, cadastrePnu: e.pnu, cadastre: "EXISTS",
    identityStatus: `RELINK_${methodOf(e)}+EXCLUSIVES_COVERED`, t3y: r.t3y, trades: 0, relinkReason: r.reason });
}).join("\n") + "\n");
const keep = new Set(accepted.map((r) => (r.chosen as Eval).registryPnu));
const fd = openSync(`${WORK}/expos-accepted.jsonl`, "w");
for (const p of keep) for (const line of rawByPnu.get(p) ?? []) writeSync(fd, line + "\n");
closeSync(fd);

const summary: Record<string, Record<string, number>> = {};
for (const r of results) {
  const key = `${r.kind}|${r.reason}`;
  const s = (summary[key] ??= { targets: 0, withCandidate: 0 });
  s.targets += 1;
  if ((r.evals as Eval[]).length > 0) s.withCandidate += 1;
  s[r.decision as string] = (s[r.decision as string] ?? 0) + 1;
}
const methods: Record<string, number> = {};
for (const r of accepted) methods[methodOf(r.chosen as Eval)] = (methods[methodOf(r.chosen as Eval)] ?? 0) + 1;
writeFileSync(`${WORK}/accept-summary.json`, JSON.stringify({ targets: results.length, accepted: accepted.length, byReason: summary, acceptedByMethod: methods }, null, 1));
const pick = [...accepted].sort((a, b) => String(a.complexId).localeCompare(String(b.complexId)));
const step = Math.max(1, Math.floor(pick.length / 20));
writeFileSync(`${WORK}/samples.json`, JSON.stringify(pick.filter((_, i) => i % step === 0).slice(0, 20).map((r) => {
  const e = r.chosen as Eval;
  return { kind: r.kind, reason: r.reason, aptName: r.aptName, address: `${r.sido} ${r.sigungu} ${r.roadAddress}`.trim(), pnu: e.pnu,
    registryPnu: e.registryPnu, lot: e.lot, jimok: e.jimok, method: methodOf(e), units: e.units, kaptHouseholds: r.kaptHouseholds,
    required: r.required, parcelExclusives: e.exclusives };
}), null, 1));
console.log(JSON.stringify({ targets: results.length, accepted: accepted.length, acceptedByMethod: methods }));
console.log(JSON.stringify(summary));
