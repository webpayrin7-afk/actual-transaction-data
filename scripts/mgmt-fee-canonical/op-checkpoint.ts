/**
 * Per-operation checkpoint for a live dry-run.
 * Successful and empty (missing) ops are not fetched again.
 * Failed ops stay resumable. No database writes.
 */
export type OpCheckpointStatus = "success" | "missing" | "failed";

export type OpCheckpointRecord = {
  complex_id: string;
  period: string;
  op: string;
  service: string;
  status: OpCheckpointStatus;
  http: number;
  result_class: string;
  amount: number | null;
  numeric_fields: string[];
  explicit_zero_fields: string[];
  error: string | null;
  completed_at: string;
};

export type OpCheckpointFile = {
  version: 1;
  records: OpCheckpointRecord[];
};

function keyOf(complex_id: string, period: string, service: string, op: string): string {
  return `${complex_id}|${period}|${service}|${op}`;
}

export class OpCheckpointStore {
  private readonly records = new Map<string, OpCheckpointRecord>();

  static empty(): OpCheckpointStore {
    return new OpCheckpointStore();
  }

  static parse(json: string): OpCheckpointStore {
    const parsed = JSON.parse(json) as OpCheckpointFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
      throw new Error("invalid op checkpoint");
    }
    const store = new OpCheckpointStore();
    for (const record of parsed.records) store.put(record);
    return store;
  }

  get(
    complex_id: string,
    period: string,
    service: string,
    op: string,
  ): OpCheckpointRecord | undefined {
    return this.records.get(keyOf(complex_id, period, service, op));
  }

  put(record: OpCheckpointRecord): void {
    this.records.set(
      keyOf(record.complex_id, record.period, record.service, record.op),
      { ...record, numeric_fields: [...record.numeric_fields], explicit_zero_fields: [...record.explicit_zero_fields] },
    );
  }

  /** Success, confirmed-missing, and retired-service failures are not retried. */
  shouldFetch(complex_id: string, period: string, service: string, op: string): boolean {
    const record = this.get(complex_id, period, service, op);
    if (!record) return true;
    if (record.status === "success" || record.status === "missing") return false;
    if (record.result_class === "openapi_12") return false;
    return true;
  }

  list(): OpCheckpointRecord[] {
    return [...this.records.values()];
  }

  serialize(): string {
    return JSON.stringify({ version: 1, records: this.list() } satisfies OpCheckpointFile);
  }
}
