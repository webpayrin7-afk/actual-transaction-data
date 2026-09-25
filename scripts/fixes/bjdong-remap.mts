/**
 * 부천(41194·41196)·화성(41591·41593·41595·41597) 단지의 법정동 뒷자리(bjdong_cd) 바로잡기.
 * 구가 새로 생기면서 lawd_cd는 새 구 코드인데 bjdong_cd는 옛 시(41190·41590) 기준 번호로 남아
 * 실제로 없는 법정동 코드가 됐다 → 건축물대장·K-apt 조회가 모두 비었다.
 *
 * 규칙 (추정·이름 유사 매칭 없음):
 *   옛 코드 = 옛 시 코드(41190|41590) + 현재 bjdong_cd
 *   법정동 변경 이력(lawd-successor.csv, 1:1 쌍)에서 그 옛 코드의 새 코드가
 *   ① 단지 lawd_cd로 시작하고 ② 읍면동 이름이 단지 legal_dong_name과 같을 때만 바꾼다.
 *   화성 능동(병점·동탄으로 나뉨, holds 파일)은 새 코드 둘 중 단지 lawd_cd로 시작하는 하나.
 *   이미 새 코드인 단지(이력의 새 코드와 같음)는 건드리지 않는다. 그 밖은 보류.
 *
 *   npx tsx scripts/fixes/bjdong-remap.mts            # 계획만: 매핑·백업 파일을 만든다 (DB 쓰기 없음)
 *   npx tsx scripts/fixes/bjdong-remap.mts --apply    # 계획 파일대로 고친다 (행마다 옛 값 조건을 걸어서)
 *
 * --apply가 고치는 것 (이 단지들만):
 *   apt_complex_master.bjdong_cd
 *   complex_building_checkpoint.parcel_key·pnu (옛 번호 부분만 바꾸고 건물 조회를 다시 하도록 상태를 PENDING으로)
 *   apt_supply_identity_residual.bjdong_cd·pnu, apt_unit_acquisition_manifest.bjdong_cd
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";

const OUT = "C:/data/fixes/bjdong-2026-09-25";
const CODES_DIR =
  process.env.LAWD_SUCCESSOR_DIR ?? "C:/dev/ziplab/.claude/worktrees/agent-ab9f8df0cdcaf0df8/data/admin-codes";
const TARGET_LAWD = ["41194", "41196", "41591", "41593", "41595", "41597"];
const OLD_CITY: Record<string, string> = {
  "41194": "41190",
  "41196": "41190",
  "41591": "41590",
  "41593": "41590",
  "41595": "41590",
  "41597": "41590",
};

type Row = { complex_id: string; apt_name: string; lawd_cd: string; legal_dong_name: string; bjdong_cd: string };
type Fix = Row & { new_bjdong: string; basis: string };

function csv(path: string): Array<Record<string, string>> {
  const [head, ...lines] = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const cols = head!.split(",");
  return lines.map((l) => {
    const v = l.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, (v[i] ?? "").trim()]));
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  mkdirSync(OUT, { recursive: true });
  const planPath = join(OUT, "mapping.json");

  if (apply) {
    if (!existsSync(planPath)) throw new Error("먼저 --apply 없이 돌려 계획 파일을 만드세요.");
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as { fixes: Fix[] };
    let master = 0;
    let checkpoint = 0;
    let residual = 0;
    let manifest = 0;
    for (let i = 0; i < plan.fixes.length; i += 50) {
      const chunk = plan.fixes.slice(i, i + 50);
      const stmts = chunk.flatMap((f) => {
        const oldPnuPrefix = `${f.lawd_cd}${f.bjdong_cd}`;
        const newPnuPrefix = `${f.lawd_cd}${f.new_bjdong}`;
        return [
          {
            sql: `UPDATE apt_complex_master SET bjdong_cd = ? WHERE complex_id = ? AND bjdong_cd = ?`,
            args: [f.new_bjdong, f.complex_id, f.bjdong_cd],
          },
          {
            sql: `UPDATE complex_building_checkpoint
                  SET parcel_key = replace(parcel_key, ?, ?), pnu = ? || substr(pnu, 11),
                      title_status = 'PENDING', building_status = 'PENDING', geometry_status = 'PENDING',
                      link_status = 'PENDING', detail = 'bjdong remap 2026-09-25', updated_at = ?
                  WHERE complex_id = ? AND substr(pnu, 1, 10) = ?`,
            args: [
              `${f.lawd_cd}|${f.bjdong_cd}|`,
              `${f.lawd_cd}|${f.new_bjdong}|`,
              newPnuPrefix,
              new Date().toISOString(),
              f.complex_id,
              oldPnuPrefix,
            ],
          },
          {
            sql: `UPDATE apt_supply_identity_residual
                  SET bjdong_cd = ?, pnu = CASE WHEN substr(pnu, 1, 10) = ? THEN ? || substr(pnu, 11) ELSE pnu END
                  WHERE complex_id = ? AND bjdong_cd = ?`,
            args: [f.new_bjdong, oldPnuPrefix, newPnuPrefix, f.complex_id, f.bjdong_cd],
          },
          {
            sql: `UPDATE apt_unit_acquisition_manifest SET bjdong_cd = ? WHERE complex_id = ? AND bjdong_cd = ?`,
            args: [f.new_bjdong, f.complex_id, f.bjdong_cd],
          },
        ];
      });
      const res = await db.batch(stmts, "write");
      for (let j = 0; j < res.length; j += 4) {
        master += res[j]!.rowsAffected;
        checkpoint += res[j + 1]!.rowsAffected;
        residual += res[j + 2]!.rowsAffected;
        manifest += res[j + 3]!.rowsAffected;
      }
    }
    console.log(JSON.stringify({ mode: "apply", planned: plan.fixes.length, master, checkpoint, residual, manifest }, null, 2));
    return;
  }

  const successors = csv(join(CODES_DIR, "lawd-successor.csv"));
  const holds = csv(join(CODES_DIR, "lawd-successor-holds.csv"));
  const byOld = new Map(successors.map((r) => [r.old_lawd_cd!, r]));
  const liveNew = new Set(successors.map((r) => r.resolved_lawd_cd!));

  const res = await db.execute({
    sql: `SELECT complex_id, apt_name, lawd_cd, legal_dong_name, bjdong_cd FROM apt_complex_master
          WHERE lawd_cd IN (${TARGET_LAWD.map(() => "?").join(",")})`,
    args: TARGET_LAWD,
  });
  const rows = res.rows.map((r) => ({
    complex_id: String(r.complex_id),
    apt_name: String(r.apt_name),
    lawd_cd: String(r.lawd_cd),
    legal_dong_name: String(r.legal_dong_name ?? "").trim(),
    bjdong_cd: String(r.bjdong_cd ?? "").trim(),
  })) as Row[];

  const fixes: Fix[] = [];
  const held: Array<Row & { reason: string }> = [];
  let alreadyOk = 0;
  for (const r of rows) {
    const full = `${r.lawd_cd}${r.bjdong_cd}`;
    if (liveNew.has(full)) {
      alreadyOk++;
      continue;
    }
    const oldFull = `${OLD_CITY[r.lawd_cd]}${r.bjdong_cd}`;
    const s = byOld.get(oldFull);
    if (s) {
      const newFull = s.resolved_lawd_cd!;
      const name = [s.umd_nm, s.ri_nm].filter(Boolean).join(" ");
      if (newFull.startsWith(r.lawd_cd) && (s.umd_nm === r.legal_dong_name || name === r.legal_dong_name)) {
        fixes.push({ ...r, new_bjdong: newFull.slice(5), basis: `successor ${oldFull}→${newFull} (${name})` });
      } else {
        held.push({ ...r, reason: `successor ${oldFull}→${newFull} (${name}) — 구 또는 동 이름이 다름` });
      }
      continue;
    }
    const h = holds.find((x) => x.old_codes === oldFull);
    if (h) {
      const picks = h.new_codes!.split("|").filter((c) => c.startsWith(r.lawd_cd));
      if (picks.length === 1 && h.umd_nm === r.legal_dong_name) {
        fixes.push({ ...r, new_bjdong: picks[0]!.slice(5), basis: `split ${oldFull}→${picks[0]} (${h.umd_nm}, 구로 결정)` });
      } else {
        held.push({ ...r, reason: `split ${oldFull} — 새 코드를 하나로 못 정함` });
      }
      continue;
    }
    held.push({ ...r, reason: `이력에 ${oldFull} 없음` });
  }

  // 백업: 고칠 단지의 master 전체 행 + 딸린 표의 현재 행
  const ids = fixes.map((f) => f.complex_id);
  const backup: Record<string, unknown[]> = {};
  for (const t of ["apt_complex_master", "complex_building_checkpoint", "apt_supply_identity_residual", "apt_unit_acquisition_manifest"]) {
    backup[t] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const r = await db.execute({
        sql: `SELECT * FROM ${t} WHERE complex_id IN (${chunk.map(() => "?").join(",")})`,
        args: chunk,
      });
      backup[t]!.push(...r.rows.map((x) => ({ ...x })));
    }
  }
  // 백업·계획은 고칠 게 있을 때만, 시각을 붙여 새 파일로 쓴다 — 적용 뒤 다시 돌려도 이전 백업을 덮어쓰지 않게
  if (fixes.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(OUT, `backup-${stamp}.json`), JSON.stringify(backup));
    writeFileSync(join(OUT, `mapping-${stamp}.json`), JSON.stringify({ built_at: new Date().toISOString(), fixes, held }, null, 1));
    writeFileSync(planPath, JSON.stringify({ built_at: new Date().toISOString(), fixes, held }, null, 1));
  }

  const perLawd: Record<string, { fix: number; held: number }> = {};
  for (const f of fixes) (perLawd[f.lawd_cd] ??= { fix: 0, held: 0 }).fix++;
  for (const h of held) (perLawd[h.lawd_cd] ??= { fix: 0, held: 0 }).held++;
  console.log(
    JSON.stringify(
      {
        mode: "plan",
        complexes: rows.length,
        already_ok: alreadyOk,
        fix: fixes.length,
        held: held.length,
        per_lawd: perLawd,
        backup_rows: Object.fromEntries(Object.entries(backup).map(([k, v]) => [k, v.length])),
        sample: fixes.slice(0, 5).map((f) => `${f.apt_name} ${f.legal_dong_name} ${f.bjdong_cd}→${f.new_bjdong}`),
        held_sample: held.slice(0, 5).map((h) => `${h.apt_name} ${h.legal_dong_name} ${h.bjdong_cd}: ${h.reason}`),
        files: { mapping: planPath, backup: join(OUT, "backup.json") },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
