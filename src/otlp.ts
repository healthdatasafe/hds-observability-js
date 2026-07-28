import {
  DURATION_BOUNDS_MS,
  type Exporter,
  type ServiceIdentity,
  type Window
} from './types.ts';

/**
 * OTLP/HTTP JSON serialisation and transport.
 *
 * No vendor SDK is loaded. OTLP over HTTP is a POST of JSON, so this is a
 * `fetch` call and nothing else. That is deliberate: an in-process vendor agent
 * auto-instruments everything, which means the collected surface can widen on
 * an upgrade with no change on our side. It is also what makes the backend
 * swappable — point `endpoint` at a collector, and the vendor is a collector
 * configuration rather than a dependency of this library.
 *
 * The resource is built here and only here, from the service identity. Nothing
 * detects or appends host, process or environment attributes. A collector in
 * front of this must be configured the same way (no `resourcedetection`), or it
 * will re-add downstream exactly what this refuses to send.
 */

const DELTA = 1; // AggregationTemporality.DELTA — windowed counts, not cumulative.
const SCOPE = { name: 'hds-observability-js', version: '0.1.0' };

interface KeyValue { key: string; value: { stringValue: string } }

function attrs (pairs: Record<string, string>): KeyValue[] {
  return Object.entries(pairs).map(([key, v]) => ({ key, value: { stringValue: v } }));
}

/** Build the OTLP metrics payload for one window. Pure; no I/O. */
export function buildPayload (window: Window, service: ServiceIdentity): object {
  const metrics: object[] = [];

  if (window.calls.length > 0) {
    metrics.push({
      name: 'hds.calls',
      unit: '1',
      sum: {
        aggregationTemporality: DELTA,
        isMonotonic: true,
        dataPoints: window.calls.map((c) => ({
          attributes: attrs({ method: c.method, status_class: c.statusClass }),
          startTimeUnixNano: window.startUnixNano,
          timeUnixNano: window.endUnixNano,
          asInt: String(c.count)
        }))
      }
    });
    metrics.push({
      name: 'hds.call.duration',
      unit: 'ms',
      histogram: {
        aggregationTemporality: DELTA,
        dataPoints: window.calls.map((c) => ({
          attributes: attrs({ method: c.method, status_class: c.statusClass }),
          startTimeUnixNano: window.startUnixNano,
          timeUnixNano: window.endUnixNano,
          count: String(c.count),
          sum: c.sumMs,
          bucketCounts: c.bucketCounts.map(String),
          explicitBounds: [...DURATION_BOUNDS_MS]
        }))
      }
    });
  }

  if (window.errors.length > 0) {
    metrics.push({
      name: 'hds.errors',
      unit: '1',
      sum: {
        aggregationTemporality: DELTA,
        isMonotonic: true,
        dataPoints: window.errors.map((e) => ({
          attributes: attrs({ code: e.code }),
          startTimeUnixNano: window.startUnixNano,
          timeUnixNano: window.endUnixNano,
          asInt: String(e.count)
        }))
      }
    });
  }

  if (window.drops.length > 0) {
    metrics.push({
      name: 'hds.telemetry.dropped',
      unit: '1',
      sum: {
        aggregationTemporality: DELTA,
        isMonotonic: true,
        dataPoints: window.drops.map((d) => ({
          attributes: attrs({ reason: d.reason }),
          startTimeUnixNano: window.startUnixNano,
          timeUnixNano: window.endUnixNano,
          asInt: String(d.count)
        }))
      }
    });
  }

  return {
    resourceMetrics: [{
      resource: {
        attributes: attrs({
          'service.name': service.name,
          'service.version': service.version,
          'service.instance.id': service.instance
        })
      },
      scopeMetrics: [{ scope: SCOPE, metrics }]
    }]
  };
}

export interface OtlpOptions {
  /** Collector endpoint, e.g. `http://127.0.0.1:4318/v1/metrics`. */
  endpoint: string;
  /** Static headers (auth for the collector). Never derived from request data. */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** An {@link Exporter} that POSTs the payload as OTLP/HTTP JSON. */
export function otlpExporter (options: OtlpOptions): Exporter {
  const { endpoint, headers = {}, timeoutMs = 10_000 } = options;
  return async (window, service) => {
    const body = JSON.stringify(buildPayload(window, service));
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`otlp export failed: ${res.status}`);
  };
}
