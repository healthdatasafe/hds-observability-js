import { Aggregator } from './aggregator.ts';
import {
  SERVICE_FIELD_RE,
  STATUS_CLASSES,
  type DropReason,
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
  /**
   * Called with the **offending value** every time a payload is refused.
   *
   * The wire carries only the refusal *reason*, and must: the value is a
   * runtime string, which is precisely what may not be emitted. But if it is
   * named nowhere at all, a rising `unknown_method` counter is undiagnosable —
   * the operator can see that something is wrong and has no way to discover
   * *which* method id. Wire this to the service's own logger: local logs stay
   * on our infrastructure and already carry identifiers, so naming it there
   * adds no exposure.
   *
   * Omitting it is supported but warned about once, because "refusals are
   * happening and nobody can tell you what they were" is the same silent
   * inertness this library exists to eliminate.
   *
   * (Defect #2 of the three pryv's post-deploy verification caught, which this
   * emitter shared by construction — found by plan 88 workstream D.)
   */
  onRefused?: (reason: DropReason, value: string) => void;
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
    onRefused,
    now = Date.now,
    setInterval: setIntervalFn = setInterval
  } = options;

  for (const [field, value] of Object.entries(service)) {
    if (!SERVICE_FIELD_RE.test(value)) {
      throw new Error(`hds-observability: service.${field} must match ${SERVICE_FIELD_RE}`);
    }
  }
  // An empty allow-list refuses EVERY datapoint as unknown, producing an
  // emitter that reports itself configured and sends nothing but drop counts.
  // That is not a hypothetical: it is how the previous generation of this layer
  // sat inert for six weeks, and pryv hit the identical shape upstream. Fail at
  // construction, loudly, rather than at runtime, silently.
  if (methods.length === 0) {
    throw new Error('hds-observability: methods must not be empty — an empty allow-list refuses every call and emits only drop counts');
  }
  if (errorCodes.length === 0) {
    throw new Error('hds-observability: errorCodes must not be empty — an empty allow-list refuses every error and emits only drop counts');
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
  let warnedNoSink = false;

  /**
   * Count the refusal on the wire (reason only) AND name the offending value
   * locally. Never throws: a telemetry path must not be able to take down the
   * service it observes, and that includes a caller's faulty logger.
   */
  function refuse (reason: DropReason, value: unknown): void {
    agg.recordDrop(reason);
    if (onRefused === undefined) {
      if (!warnedNoSink) {
        warnedNoSink = true;
        console.warn(
          `hds-observability: refusing payloads (${reason}) but no onRefused sink is configured — ` +
          'the offending values are being discarded and these drops cannot be diagnosed. ' +
          'Pass onRefused to route them to your local logger.'
        );
      }
      return;
    }
    try {
      onRefused(reason, typeof value === 'string' ? value : String(value));
    } catch { /* a broken sink must not break the caller */ }
  }

  async function flush (): Promise<void> {
    const window = agg.flush(now());
    if (window === null) return;
    try {
      await exporter(window, service);
    } catch (err) {
      // Never surface a telemetry failure to the caller. The next window will
      // carry an `export_failed` count so the loss is itself observable — and
      // the reason goes to the local sink, because a count that says only
      // "export failed" leaves an operator with nothing to act on. (The
      // message is local-only; it never reaches the wire.)
      refuse('export_failed', err instanceof Error ? err.message : err);
    }
  }

  const timer = setIntervalFn(() => {
    exporting = exporting.then(flush, flush);
  }, windowMs);
  // Do not hold the process open for telemetry.
  (timer as { unref?: () => void }).unref?.();

  return {
    recordCall (method, statusClass, durationMs) {
      if (!knownMethods.has(method)) return refuse('unknown_method', method);
      if (!knownStatus.has(statusClass)) return refuse('unknown_status_class', statusClass);
      if (!Number.isFinite(durationMs) || durationMs < 0) return refuse('invalid_duration', durationMs);
      agg.recordCall(method, statusClass, durationMs);
    },
    recordError (code) {
      if (!knownCodes.has(code)) return refuse('unknown_error_code', code);
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
