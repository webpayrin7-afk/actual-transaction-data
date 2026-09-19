/**
 * Local JSON checkpoint. COMPLETE rows are skippable.
 * PARTIAL, MISSING, and FAILED rows stay resumable.
 * No database connection.
 */
import type { CheckpointRecord, CheckpointStatus } from "./types";

export type CheckpointFile = {
  version: 1;
  records: CheckpointRecord[];
};

function keyOf(complex_id: string, period: string): string {
  return `${complex_id}|${period}`;
}

export class CheckpointStore {
  private readonly records = new Map<string, CheckpointRecord>();

  static empty(): CheckpointStore {
    return new CheckpointStore();
  }

  static fromRecords(records: readonly CheckpointRecord[]): CheckpointStore {
    const store = new CheckpointStore();
    for (const record of records) store.put(record);
    return store;
  }

  static parse(json: string): CheckpointStore {
    const parsed = JSON.parse(json) as CheckpointFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
      throw new Error("invalid checkpoint file");
    }
    return CheckpointStore.fromRecords(parsed.records);
  }

  get(complex_id: string, period: string): CheckpointRecord | undefined {
    return this.records.get(keyOf(complex_id, period));
  }

  put(record: CheckpointRecord): void {
    this.records.set(keyOf(record.complex_id, record.period), { ...record });
  }

  shouldSkip(complex_id: string, period: string): boolean {
    return this.get(complex_id, period)?.status === "COMPLETE";
  }

  /** Non-complete rows, including FAILED, can be retried. */
  isResumable(complex_id: string, period: string): boolean {
    const status = this.get(complex_id, period)?.status;
    if (!status) return true;
    return status !== "COMPLETE";
  }

  list(): CheckpointRecord[] {
    return [...this.records.values()].sort((a, b) =>
      keyOf(a.complex_id, a.period).localeCompare(keyOf(b.complex_id, b.period)),
    );
  }

  statusOf(complex_id: string, period: string): CheckpointStatus | null {
    return this.get(complex_id, period)?.status ?? null;
  }

  toJSON(): CheckpointFile {
    return { version: 1, records: this.list() };
  }

  serialize(): string {
    return JSON.stringify(this.toJSON(), null, 2);
  }
}
