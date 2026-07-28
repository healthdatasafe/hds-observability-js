/**
 * Public types. Every value that can reach an exporter is one of:
 * a compile-time constant, a member of a closed enum, or a number.
 *
 * There is deliberately no parameter anywhere in this API that accepts a
 * free-form runtime string. That absence is the guarantee: a user value cannot
 * be interpolated into telemetry because there is nothing to interpolate it
 * into. See `docs/FENCES.md`.
 */

/** Outcome classes. Closed set; callers may not extend it. */
export const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx', 'ok', 'error'] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

/** Reasons a payload was refused. Closed set; emitted as a counter. */
export const DROP_REASONS = [
  'unknown_method',
  'unknown_error_code',
  'unknown_status_class',
  'invalid_duration',
  'export_failed'
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/**
 * Identity of the emitting service. Set once at boot from constants or
 * deployment config — never from request data. Validated at construction
 * against {@link SERVICE_FIELD_RE} so a runtime value cannot be smuggled in.
 */
export interface ServiceIdentity {
  name: string;
  version: string;
  instance: string;
}

/** Conservative shape for service identity fields: no spaces, no punctuation beyond `.-_:`. */
export const SERVICE_FIELD_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** A single aggregated window, ready to serialise. */
export interface Window {
  startUnixNano: string;
  endUnixNano: string;
  calls: CallCell[];
  errors: ErrorCell[];
  drops: DropCell[];
}

export interface CallCell {
  method: string;
  statusClass: StatusClass;
  count: number;
  /** Bucket counts aligned to {@link DURATION_BOUNDS_MS}, plus one overflow bucket. */
  bucketCounts: number[];
  sumMs: number;
}

export interface ErrorCell {
  code: string;
  count: number;
}

export interface DropCell {
  reason: DropReason;
  count: number;
}

/** Fixed histogram bounds in milliseconds. Pinned: changing them changes the wire format. */
export const DURATION_BOUNDS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

/** Where a serialised window goes. Implemented by `otlpExporter`; swappable by design. */
export type Exporter = (window: Window, service: ServiceIdentity) => Promise<void>;
