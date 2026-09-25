import type { Client, InStatement } from "@libsql/client";

/** 단지의 MOLIT 연결 행 읽기 문장 — 단지 번호만 있으면 되니 다른 조회와 한 번에(batch) 보낼 수 있다. */
export function txNameLinksStatement(complexId: string): InStatement {
  return {
    sql: `SELECT source_key FROM apt_complex_source_links WHERE complex_id = ? AND source = 'MOLIT' LIMIT 20`,
    args: [complexId],
  };
}

/** 연결 행 → 실거래 단지명 목록 (마스터 이름 + 같은 시군구 연결 이름). */
export function txNameNormsFromLinks(
  rows: ReadonlyArray<Record<string, unknown>>,
  lawdCd: string,
  masterNorm: string,
): string[] {
  const out = new Set([masterNorm]);
  for (const r of rows) {
    const key = String(r.source_key);
    if (key.startsWith(`${lawdCd}|`)) out.add(key.slice(lawdCd.length + 1));
  }
  return [...out];
}

/**
 * 단지(complex_id)의 실거래 단지명(transactions.apt_name_norm) 목록 — 마스터 이름 + 같은 시군구 MOLIT 연결 이름.
 * 지방 마스터는 K-apt 이름이라 실거래 이름과 다른 경우가 많다 (예: 옥암3차골드디움 ↔ 골드디움3차).
 */
export async function complexTxNameNorms(
  db: Client,
  complexId: string,
  lawdCd: string,
  masterNorm: string,
): Promise<string[]> {
  const res = await db.execute(txNameLinksStatement(complexId));
  return txNameNormsFromLinks(res.rows, lawdCd, masterNorm);
}
