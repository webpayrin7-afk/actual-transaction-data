/**
 * 지역별 동 누락 전수점검:
 * - tx: transactions(lawd_cd) DISTINCT dong
 * - catalog: apt_catalog gu 매칭 dong (구 버그 경로)
 * - browse: queryRegionBrowseApts (현재 동별 상세 경로)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { mkdir, writeFile } from "node:fs/promises";
import { ALL_REGIONS } from "../src/lib/constants/regions-registry";
import type { RegionDef } from "../src/lib/constants/regions-registry";
import { ensureSchema, getDb } from "../src/lib/db/client";
import { queryRegionBrowseApts } from "../src/lib/db/repository";

function guMatchesRegion(gu: string, region: RegionDef): boolean {
  if (!gu.trim()) return false;
  if (gu.includes(region.name) || region.name === gu) return true;
  return region.districts.some(
    (d) => gu.includes(d.name) || d.name === gu || gu.includes(d.name),
  );
}

type AuditRow = {
  slug: string;
  name: string;
  fullName: string;
  txDongs: number;
  catDongs: number;
  browseDongs: number;
  missingVsTx: string[];
  extraInCat: string[];
  syncMonths: number;
  hasTx: boolean;
  txDongList: string[];
};

async function main() {
  try {
    await ensureSchema();
  } catch (error) {
    // Turso free tier 등에서 스키마 write가 막혀도 점검(읽기)은 진행
    console.warn("[audit] ensureSchema skipped:", error);
  }
  const db = getDb();
  if (!db) {
    console.error("DB unavailable");
    process.exit(1);
  }

  const cat = await db.execute(
    `SELECT gu, dong FROM apt_catalog WHERE TRIM(dong) != '' GROUP BY gu, dong`,
  );
  const catalogByGuDong = new Map<string, Set<string>>();
  for (const row of cat.rows) {
    const gu = String(row.gu ?? "");
    const dong = String(row.dong ?? "").trim();
    if (!dong) continue;
    if (!catalogByGuDong.has(gu)) catalogByGuDong.set(gu, new Set());
    catalogByGuDong.get(gu)!.add(dong);
  }

  const sync = await db.execute(
    `SELECT lawd_cd, COUNT(DISTINCT year_month) AS months
     FROM sync_months GROUP BY lawd_cd`,
  );
  const syncByLawd = new Map<string, number>();
  for (const row of sync.rows) {
    syncByLawd.set(String(row.lawd_cd), Number(row.months) || 0);
  }

  const rows: AuditRow[] = [];

  for (const region of ALL_REGIONS) {
    const placeholders = region.lawdCodes.map(() => "?").join(",");
    const tx = await db.execute({
      sql: `SELECT DISTINCT TRIM(dong) AS dong
            FROM transactions
            WHERE lawd_cd IN (${placeholders})
              AND deal_type = 'trade'
              AND TRIM(dong) != ''
            ORDER BY dong`,
      args: [...region.lawdCodes],
    });
    const txDongSet = new Set(
      tx.rows.map((r) => String(r.dong ?? "").trim()).filter(Boolean),
    );

    const catDongSet = new Set<string>();
    for (const [gu, dongs] of catalogByGuDong) {
      if (!guMatchesRegion(gu, region)) continue;
      for (const d of dongs) catDongSet.add(d);
    }

    const browse = await queryRegionBrowseApts([...region.lawdCodes]);
    const browseDongSet = new Set(
      (browse ?? []).map((r) => r.dong.trim()).filter(Boolean),
    );

    const missingVsTx = [...txDongSet]
      .filter((d) => !catDongSet.has(d))
      .sort((a, b) => a.localeCompare(b, "ko"));
    const extraInCat = [...catDongSet]
      .filter((d) => !txDongSet.has(d))
      .sort((a, b) => a.localeCompare(b, "ko"));

    const syncMonths = region.lawdCodes.reduce(
      (sum, code) => sum + (syncByLawd.get(code) ?? 0),
      0,
    );

    rows.push({
      slug: region.slug,
      name: region.name,
      fullName: region.fullName,
      txDongs: txDongSet.size,
      catDongs: catDongSet.size,
      browseDongs: browseDongSet.size,
      missingVsTx,
      extraInCat,
      syncMonths,
      hasTx: txDongSet.size > 0,
      txDongList: [...txDongSet].sort((a, b) => a.localeCompare(b, "ko")),
    });
  }

  const withGap = rows
    .filter((r) => r.hasTx && r.missingVsTx.length > 0)
    .sort(
      (a, b) =>
        b.missingVsTx.length - a.missingVsTx.length ||
        a.name.localeCompare(b.name, "ko"),
    );
  const browseMismatch = rows.filter(
    (r) => r.hasTx && r.browseDongs !== r.txDongs,
  );
  const noTx = rows.filter((r) => !r.hasTx);
  const noSync = noTx.filter((r) => r.syncMonths === 0);
  const okCatalog = rows.filter((r) => r.hasTx && r.missingVsTx.length === 0);

  console.log("=== SUMMARY ===");
  console.log(
    JSON.stringify(
      {
        totalRegions: rows.length,
        regionsWithTradeTx: rows.filter((r) => r.hasTx).length,
        catalogMissingDongs: withGap.length,
        browseMatchesTx: browseMismatch.length === 0,
        browseMismatchCount: browseMismatch.length,
        noTradeTx: noTx.length,
        catalogComplete: okCatalog.length,
      },
      null,
      2,
    ),
  );

  console.log("\n=== CATALOG 누락 (거래O / 카탈로그 누락) ===");
  for (const r of withGap) {
    console.log(
      `- ${r.name} (${r.slug}): cat ${r.catDongs}/${r.txDongs} browse ${r.browseDongs} | 누락 ${r.missingVsTx.length}: ${r.missingVsTx.join(", ")}`,
    );
  }

  if (browseMismatch.length) {
    console.log("\n=== BROWSE≠TX ===");
    for (const r of browseMismatch) {
      console.log(`- ${r.name}: browse ${r.browseDongs} vs tx ${r.txDongs}`);
    }
  }

  console.log(`\n=== 매매 거래 없는 지역 (${noTx.length}, sync없음 ${noSync.length}) ===`);
  for (const r of noTx.sort((a, b) => a.name.localeCompare(b.name, "ko"))) {
    console.log(`- ${r.fullName} (${r.slug}) syncMonths=${r.syncMonths}`);
  }

  const lines: string[] = [];
  lines.push("# 동 목록 전수점검");
  lines.push("");
  lines.push(`점검 시각: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## 요약");
  lines.push("");
  lines.push(`- 전체 지역: ${rows.length}`);
  lines.push(`- 매매 거래 있는 지역: ${rows.filter((r) => r.hasTx).length}`);
  lines.push(`- 카탈로그 동 누락 지역: **${withGap.length}**`);
  lines.push(
    `- 현재 browse(거래집계) = 거래 동 수 일치: **${browseMismatch.length === 0 ? "예" : "아니오 (" + browseMismatch.length + ")"}**`,
  );
  lines.push(`- 카탈로그와 거래 동 완전 일치: ${okCatalog.length}`);
  lines.push(`- 매매 거래 없음(미적재 등): ${noTx.length}`);
  lines.push("");
  lines.push("## 카탈로그 누락 상세 (구 버그 경로)");
  lines.push("");
  lines.push(
    "동별 상세는 이미 거래(`lawd_cd`) 기준으로 수정됨. 아래는 `apt_catalog` 잔여 누락 규모입니다.",
  );
  lines.push("");
  lines.push("| 지역 | slug | catalog | tx | browse | 누락 수 | 누락 동 |");
  lines.push("|---|---|---:|---:|---:|---:|---|");
  for (const r of withGap) {
    lines.push(
      `| ${r.name} | \`${r.slug}\` | ${r.catDongs} | ${r.txDongs} | ${r.browseDongs} | ${r.missingVsTx.length} | ${r.missingVsTx.join(", ")} |`,
    );
  }
  lines.push("");
  lines.push("## 거래 기준 동 목록 (매매 있는 지역)");
  lines.push("");
  for (const r of rows
    .filter((x) => x.hasTx)
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "ko"))) {
    lines.push(
      `- **${r.fullName}** (\`${r.slug}\`): ${r.txDongs}개 — ${r.txDongList.join(", ")}`,
    );
  }
  lines.push("");
  lines.push("## 매매 거래 없는 지역");
  lines.push("");
  if (!noTx.length) {
    lines.push("(없음)");
  } else {
    for (const r of noTx.sort((a, b) =>
      a.fullName.localeCompare(b.fullName, "ko"),
    )) {
      lines.push(
        `- ${r.fullName} (\`${r.slug}\`) · syncMonths=${r.syncMonths}`,
      );
    }
  }

  await mkdir("/opt/cursor/artifacts", { recursive: true });
  await writeFile(
    "/opt/cursor/artifacts/dong-coverage-audit.md",
    lines.join("\n"),
    "utf8",
  );
  console.log("\nWrote /opt/cursor/artifacts/dong-coverage-audit.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
