import {
  DURATION_BOUNDS_MS,
  type CallCell,
  type DropCell,
  type DropReason,
  type ErrorCell,
  type StatusClass,
  type Window
} from './types.ts';

/**
 * In-process aggregation into fixed windows, with small-cell deferral.
 *
 * Two properties this exists to guarantee:
 *
 * 1. **Nothing event-level leaves.** Callers record individual events; only
 *    per-window totals are ever serialised.
 * 2. **No cell below `minCellCount` is ever emitted.** A count of 1 from a
 *    low-traffic service is an event record wearing an aggregate costume, and
 *    on these services the mere fact of activity is sensitive.
 *
 * Sub-threshold cells are **deferred, not dropped**: they accumulate into the
 * next window and are emitted once the running total reaches the threshold, so
 * totals are preserved and only their timing is coarsened. The deliberate
 * consequence is that a genuinely rare event may never reach the exporter. That
 * is the intended trade: rare events are diagnosed from local logs, which stay
 * on our own infrastructure and carry the full context.
 */

const BUCKET_COUNT = DURATION_BOUNDS_MS.length + 1;

/**
 * Composite-map-key separator. A control character, so it cannot occur inside a
 * route pattern or a status class and the key is unambiguous. Written as an
 * escape rather than a literal: a raw control byte in a source file makes git
 * treat it as binary, which silently kills diffs and review.
 */
const KEY_SEP = '\u0001';

function bucketFor (durationMs: number): number {
  for (let i = 0; i < DURATION_BOUNDS_MS.length; i++) {
    if (durationMs <= DURATION_BOUNDS_MS[i]) return i;
  }
  return DURATION_BOUNDS_MS.length;
}

interface CallAcc {
  method: string;
  statusClass: StatusClass;
  count: number;
  bucketCounts: number[];
  sumMs: number;
}

export class Aggregator {
  readonly #minCellCount: number;
  #calls = new Map<string, CallAcc>();
  #errors = new Map<string, number>();
  #drops = new Map<DropReason, number>();
  #windowStartMs: number;

  constructor (minCellCount: number, nowMs: number) {
    this.#minCellCount = minCellCount;
    this.#windowStartMs = nowMs;
  }

  recordCall (method: string, statusClass: StatusClass, durationMs: number): void {
    const key = `${method}${KEY_SEP}${statusClass}`;
    let acc = this.#calls.get(key);
    if (acc === undefined) {
      acc = {
        method,
        statusClass,
        count: 0,
        bucketCounts: new Array(BUCKET_COUNT).fill(0),
        sumMs: 0
      };
      this.#calls.set(key, acc);
    }
    acc.count++;
    acc.sumMs += durationMs;
    acc.bucketCounts[bucketFor(durationMs)]++;
  }

  recordError (code: string): void {
    this.#errors.set(code, (this.#errors.get(code) ?? 0) + 1);
  }

  recordDrop (reason: DropReason): void {
    this.#drops.set(reason, (this.#drops.get(reason) ?? 0) + 1);
  }

  /**
   * Close the current window. Returns the cells that cleared the threshold and
   * retains the rest for the next one. Returns `null` when nothing clears, so
   * the caller can skip the export entirely rather than send an empty payload.
   */
  flush (nowMs: number): Window | null {
    const calls: CallCell[] = [];
    for (const [key, acc] of this.#calls) {
      if (acc.count < this.#minCellCount) continue;
      calls.push({
        method: acc.method,
        statusClass: acc.statusClass,
        count: acc.count,
        bucketCounts: [...acc.bucketCounts],
        sumMs: acc.sumMs
      });
      this.#calls.delete(key);
    }

    const errors: ErrorCell[] = [];
    for (const [code, count] of this.#errors) {
      if (count < this.#minCellCount) continue;
      errors.push({ code, count });
      this.#errors.delete(code);
    }

    // Drop counters carry no per-subject signal — they count our own refusals —
    // so they are not subject to small-cell deferral.
    const drops: DropCell[] = [...this.#drops].map(([reason, count]) => ({ reason, count }));
    this.#drops.clear();

    const startUnixNano = String(BigInt(Math.trunc(this.#windowStartMs)) * 1_000_000n);
    const endUnixNano = String(BigInt(Math.trunc(nowMs)) * 1_000_000n);
    this.#windowStartMs = nowMs;

    if (calls.length === 0 && errors.length === 0 && drops.length === 0) return null;
    return { startUnixNano, endUnixNano, calls, errors, drops };
  }

  /** Cells currently held back below the threshold. Test/diagnostic use. */
  deferredCellCount (): number {
    return this.#calls.size + this.#errors.size;
  }
}
