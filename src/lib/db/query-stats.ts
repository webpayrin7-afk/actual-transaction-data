/** Request-scoped SQL execute counter. READ path only. */

let enabled = false;
let count = 0;

export function beginDbQueryCount(): void {
  enabled = true;
  count = 0;
}

export function noteDbQuery(): void {
  if (enabled) count += 1;
}

export function peekDbQueryCount(): number {
  return count;
}

export function takeDbQueryCount(): number {
  const n = count;
  enabled = false;
  count = 0;
  return n;
}
