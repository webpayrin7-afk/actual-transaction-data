/**
 * Deterministic MOLIT trade cancellation / duplicate resolution.
 * Does not use XML order. ingestMeta is not persisted to the warehouse.
 */
import { naturalKeyFromTx } from "@/lib/market/identity";
import type { Transaction } from "@/types/transaction";

/** MOLIT AptTrade 해제여부: "O" = 해제 계약. */
export function isCancelledTrade(tx: Transaction): boolean {
  const raw = (tx.ingestMeta?.cdealType ?? "").trim().toUpperCase();
  if (!raw) return false;
  return raw === "O" || raw === "Y" || raw.includes("해제");
}

function ingestMetaOf(tx: Transaction) {
  return {
    cdealType: (tx.ingestMeta?.cdealType ?? "").trim(),
    cdealDay: (tx.ingestMeta?.cdealDay ?? "").trim(),
    rgstDate: (tx.ingestMeta?.rgstDate ?? "").trim(),
    aptDong: (tx.ingestMeta?.aptDong ?? "").trim(),
  };
}

/**
 * Prefer an active surviving deal over a cancellation of the same identity.
 * Tie-break is field-based, never array index.
 */
export function compareActiveCandidates(a: Transaction, b: Transaction): number {
  const ma = ingestMetaOf(a);
  const mb = ingestMetaOf(b);
  const aRgst = ma.rgstDate ? 1 : 0;
  const bRgst = mb.rgstDate ? 1 : 0;
  if (aRgst !== bRgst) return bRgst - aRgst;
  if (ma.rgstDate !== mb.rgstDate) return ma.rgstDate < mb.rgstDate ? 1 : -1;
  if (ma.aptDong !== mb.aptDong) {
    if (!ma.aptDong) return 1;
    if (!mb.aptDong) return -1;
    return ma.aptDong.localeCompare(mb.aptDong, "ko");
  }
  const aGbn = a.dealingGbn ?? "";
  const bGbn = b.dealingGbn ?? "";
  if (aGbn !== bGbn) return aGbn.localeCompare(bGbn, "ko");
  const aYear = a.buildYear ?? -1;
  const bYear = b.buildYear ?? -1;
  if (aYear !== bYear) return bYear - aYear;
  return a.id.localeCompare(b.id);
}

export type DuplicateGroupClass =
  | "cancellation-pair"
  | "exact-duplicate"
  | "aptDong-different"
  | "other";

export function classifyIdentityGroup(rows: Transaction[]): DuplicateGroupClass {
  if (rows.length < 2) return "exact-duplicate";
  const cancelled = rows.filter(isCancelledTrade);
  const active = rows.filter((r) => !isCancelledTrade(r));
  if (cancelled.length > 0 && active.length > 0) return "cancellation-pair";

  const dongs = new Set(rows.map((r) => ingestMetaOf(r).aptDong));
  if (dongs.size > 1) return "aptDong-different";

  const signatures = new Set(
    rows.map((r) =>
      JSON.stringify({
        ...ingestMetaOf(r),
        dealingGbn: r.dealingGbn,
        buildYear: r.buildYear,
        aptName: r.aptName,
      }),
    ),
  );
  if (signatures.size === 1) return "exact-duplicate";
  return "other";
}

export type ResolveActiveResult = {
  active: Transaction[];
  parsed: number;
  cancelledExcluded: number;
  exactDuplicateExcluded: number;
  otherCollapsed: number;
  cancelledOnlyDropped: number;
};

export function resolveActiveTrades(
  items: Transaction[],
  lawdCd: string,
): ResolveActiveResult {
  const groups = new Map<string, Transaction[]>();
  for (const tx of items) {
    const key = naturalKeyFromTx(tx, lawdCd || tx.lawdCd || "");
    const list = groups.get(key);
    if (list) list.push(tx);
    else groups.set(key, [tx]);
  }

  const active: Transaction[] = [];
  let cancelledExcluded = 0;
  let exactDuplicateExcluded = 0;
  let otherCollapsed = 0;
  let cancelledOnlyDropped = 0;

  for (const rows of groups.values()) {
    if (rows.length === 1) {
      if (isCancelledTrade(rows[0])) {
        cancelledOnlyDropped += 1;
        cancelledExcluded += 1;
      } else {
        active.push(rows[0]);
      }
      continue;
    }

    const kind = classifyIdentityGroup(rows);
    const survivors = rows.filter((r) => !isCancelledTrade(r));
    cancelledExcluded += rows.length - survivors.length;

    if (survivors.length === 0) {
      cancelledOnlyDropped += rows.length;
      continue;
    }

    const chosen = [...survivors].sort(compareActiveCandidates)[0];
    active.push(chosen);
    const droppedActives = survivors.length - 1;
    if (kind === "aptDong-different" || kind === "other") {
      otherCollapsed += droppedActives;
    } else {
      exactDuplicateExcluded += droppedActives;
    }
  }

  return {
    active,
    parsed: items.length,
    cancelledExcluded,
    exactDuplicateExcluded,
    otherCollapsed,
    cancelledOnlyDropped,
  };
}

/**
 * Refuse month replace when the incoming unique set is implausibly smaller
 * than the warehouse cell. Protects against truncated API / parser failure
 * deleting most of a month.
 */
export function isUnsafeMonthShrink(params: {
  previousRowCount: number;
  nextRowCount: number;
}): boolean {
  const prev = params.previousRowCount;
  const next = params.nextRowCount;
  if (prev >= 8 && next === 0) return true;
  if (prev >= 20 && next < prev * 0.5) return true;
  return false;
}
