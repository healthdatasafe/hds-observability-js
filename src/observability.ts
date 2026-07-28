import { Aggregator } from './aggregator.ts';
import {
  SERVICE_FIELD_RE,
  STATUS_CLASSES,
  type Exporter,
  type ServiceIdentity,
  type StatusClass
} from './types.ts';

/** Floor on the window length. Shorter windows approach per-event reporting. */
export const MIN_WINDOW_MS = 60_000;
export const DEFAULT_WINDOW_MS = 300_000;
export const DEFAULT_MIN_CELL_COUNT = 5;

export interface ObservabilityOptions<M extends string, E extends string> {
  service: ServiceIdentity;
  /** Every method id that may be recorded. **Route patterns, never concrete paths.** */
  methods: readonly M[];
  /** Every error code that may be recorded. */
  errorCodes: readonly E[];
  exporter: Exporter;
  /** Export cadence and window length. Minimum {@link MIN_WINDOW_MS}. */
  windowMs?: number;
  /** Cells below this count are deferred, never emitted. */
  minCellCount?: number;
  /** Injectable clock/timer, for tests. */
  now?: () => number;
  setInterval?: typeof setInterval;
}

export interface Observability<M extends string, E extends string> {
  recordCall: (method: M, statusClass: StatusClass, durationMs: number) => void;
  recordError: (code: E) => void;
  /** Force a window close and export. Normally driven by the timer. */
  flush: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Build the emitter.
 *
 * `methods` and `errorCodes` are the allow-list. Anything not in them is
 * refused and counted, never sent — which is what stops a template literal such
 * as `` `GET /users/${username}` `` from reaching the vendor: it does not match
 * a registered pattern, so it is dropped rather than emitted.
 *
 * Refusals never throw. A telemetry path must not be able to take down the
 * service it observes.
 */
export function createObservability<M extends string, E extends string> (
  options: ObservabilityOptions<M, E>
): Observability<M, E> {
  const {
    service,
    methods,
    errorCodes,
    exporter,
    windowMs = DEFAULT_WINDOW_MS,
    minCellCount = DEFAULT_MIN_CELL_COUNT,
    now = Date.now,
    setInterval: setIntervalFn = setInterval
  } = options;

  for (const [field, value] of Object.entries(service)) {
    if (!SERVICE_FIELD_RE.test(value)) {
      throw new Error(`hds-observability: service.${field} must match ${SERVICE_FIELD_RE}`);
    }
  }
  if (windowMs < MIN_WINDOW_MS) {
    throw new Error(`hds-observability: windowMs must be >= ${MIN_WINDOW_MS}`);
  }
  if (minCellCount < 1) {
    throw new Error('hds-observability: minCellCount must be >= 1');
  }

  const knownMethods = new Set<string>(methods);
  const knownCodes = new Set<string>(errorCodes);
  const knownStatus = new Set<string>(STATUS_CLASSES);
  const agg = new Aggregator(minCellCount, now());

  let exporting: Promise<void> = Promise.resolve();

  async function flush (): Promise<void> {
    const window = agg.flush(now());
    if (window === null) return;
    try {
      await exporter(window, service);
    } catch {
      // Never surface a telemetry failure to the caller. The next window will
      // carry a `export_failed` count so the loss is itself observable.
      agg.recordDrop('export_failed');
    }
  }

  const timer = setIntervalFn(() => {
    exporting = exporting.then(flush, flush);
  }, windowMs);
  // Do not hold the process open for telemetry.
  (timer as { unref?: () => void }).unref?.();

  return {
    recordCall (method, statusClass, durationMs) {
      if (!knownMethods.has(method)) return agg.recordDrop('unknown_method');
      if (!knownStatus.has(statusClass)) return agg.recordDrop('unknown_status_class');
      if (!Number.isFinite(durationMs) || durationMs < 0) return agg.recordDrop('invalid_duration');
      agg.recordCall(method, statusClass, durationMs);
    },
    recordError (code) {
      if (!knownCodes.has(code)) return agg.recordDrop('unknown_error_code');
      agg.recordError(code);
    },
    flush,
    async stop () {
      clearInterval(timer);
      await exporting;
      await flush();
    }
  };
}
