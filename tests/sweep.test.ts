import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createObservability } from '../src/observability.ts';
import { otlpExporter } from '../src/otlp.ts';
import { DROP_REASONS, STATUS_CLASSES, type ServiceIdentity } from '../src/types.ts';

/**
 * Plan 88 workstream D — the payload sweep.
 *
 * How this differs from `fences.test.ts`, and why the difference is the whole
 * point: those tests capture `Window` objects from an in-memory exporter and
 * assert against `buildPayload`. That asserts *our own objects*. This file
 * drives the **real `otlpExporter`** at a real socket and sweeps **the bytes
 * that actually left the process**, so it also covers the transport — the one
 * layer a payload could acquire something on its way out, and the layer no
 * existing test touched.
 *
 * Fence 13 requires this shape of evidence, and requires positive controls:
 * a sweep that finds nothing because nothing was sent proves nothing at all.
 * Every block below asserts a known-good marker IS present before concluding
 * anything from an absence. That is not ceremony — on 2026-07-28 a check of
 * this exact kind reported "OK" against a file that did not exist.
 */

const SERVICE: ServiceIdentity = { name: 'bridge-test', version: '1.0.0', instance: 'i-01' };
const METHODS = ['GET /users/:username/events', 'POST /sync'] as const;
const CODES = ['SYNC_TIMEOUT', 'AUTH_FAILED'] as const;

/**
 * Ten identifier strings, one per category pryv swept, each unique so a hit
 * names its own origin. Deliberately includes the two that carry credentials:
 * a leak there is materially worse than a username.
 */
const IDENTIFIERS = {
  username: 'zzsweep-username-alice',
  email: 'zzsweep-email-alice@example.com',
  recordId: 'zzsweep-recordid-ck9x2h4t0000',
  credentialUrl: 'https://zzsweep-token-abc123@core.example.com/alice',
  attachmentPath: '/var/data/zzsweep-attach/alice/scan.pdf',
  bearerToken: 'Bearer zzsweep-bearer-eyJhbGciOi',
  streamId: 'zzsweep-streamid-diabetes',
  password: 'zzsweep-password-hunter2',
  phone: 'zzsweep-phone-+41791234567',
  nationalId: 'zzsweep-nationalid-756.1234.5678.90'
} as const;

const ALL_IDENTIFIERS = Object.values(IDENTIFIERS);

/** A real OTLP receiver. Records raw request bytes and headers, exactly as sent. */
function receiver () {
  const bodies: string[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      headers.push(req.headers);
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200).end('{}');
    });
  });
  return {
    async listen (): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      return `http://127.0.0.1:${port}/v1/metrics`;
    },
    async close () { await new Promise<void>((resolve) => server.close(() => resolve())); },
    get wire () { return bodies.join('\n'); },
    bodies,
    headers
  };
}

/** Every attribute key present anywhere in the transported payload. */
function attributeKeys (json: string): Set<string> {
  const keys = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n === null || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (typeof o.key === 'string' && o.value !== undefined) keys.add(o.key);
    Object.values(o).forEach(walk);
  };
  walk(JSON.parse(json));
  return keys;
}

describe('D: payload sweep over the real transport', () => {
  it('no identifier survives, in any position a caller can reach', async () => {
    const rx = receiver();
    const endpoint = await rx.listen();
    try {
      const obs = createObservability({
        service: SERVICE,
        methods: METHODS,
        errorCodes: CODES,
        // The real transport, headers included.
        exporter: otlpExporter({ endpoint, headers: { 'x-api-key': IDENTIFIERS.bearerToken } }),
        minCellCount: 1,
        onRefused: () => {}, // see fences.test.ts: keeps the no-sink warning out of the output
        setInterval: (() => ({ unref () {} })) as unknown as typeof setInterval
      });

      // Every position an identifier can occupy through this API.
      for (const id of ALL_IDENTIFIERS) {
        obs.recordCall(`GET /users/${id}/events` as never, '2xx', 5); // interpolated method
        obs.recordCall('POST /sync', id as never, 5); //                 status class
        obs.recordError(id as never); //                                 error code
      }
      // Duration is numeric, but a caller can still hand it junk.
      obs.recordCall('POST /sync', '2xx', Number.NaN);
      obs.recordCall('POST /sync', '2xx', Number.POSITIVE_INFINITY);
      obs.recordCall('POST /sync', '2xx', -1);

      // POSITIVE CONTROL — a legitimate call, so a clean sweep means "the
      // pipeline ran and carried nothing", not "the pipeline was off".
      obs.recordCall('POST /sync', '2xx', 5);
      obs.recordError('SYNC_TIMEOUT');

      await obs.flush();

      assert.ok(rx.bodies.length > 0, 'POSITIVE CONTROL FAILED: nothing was transported');
      assert.ok(rx.wire.includes('POST /sync'), 'POSITIVE CONTROL FAILED: known-good method absent');
      assert.ok(rx.wire.includes('SYNC_TIMEOUT'), 'POSITIVE CONTROL FAILED: known-good code absent');

      for (const [name, value] of Object.entries(IDENTIFIERS)) {
        assert.ok(!rx.wire.includes(value), `identifier "${name}" reached the wire`);
      }
      // The marker prefix catches a partial/mangled leak the exact-match misses.
      assert.ok(!rx.wire.includes('zzsweep'), 'a sweep marker reached the wire in some form');
    } finally {
      await rx.close();
    }
  });

  it('the auth header does not bleed into the body', async () => {
    const rx = receiver();
    const endpoint = await rx.listen();
    try {
      const obs = createObservability({
        service: SERVICE,
        methods: METHODS,
        errorCodes: CODES,
        exporter: otlpExporter({ endpoint, headers: { authorization: IDENTIFIERS.bearerToken } }),
        minCellCount: 1,
        onRefused: () => {}, // see fences.test.ts: keeps the no-sink warning out of the output
        setInterval: (() => ({ unref () {} })) as unknown as typeof setInterval
      });
      obs.recordCall('POST /sync', '2xx', 5);
      await obs.flush();

      assert.ok(rx.bodies.length > 0, 'POSITIVE CONTROL FAILED: nothing was transported');
      // The header must arrive (it is how the collector authenticates us)...
      assert.equal(rx.headers[0]?.authorization, IDENTIFIERS.bearerToken);
      // ...and must not be serialised into the payload.
      assert.ok(!rx.wire.includes('zzsweep-bearer'), 'the auth header was serialised into the body');
    } finally {
      await rx.close();
    }
  });

  it('enumerates the attribute inventory rather than checking for absence', async () => {
    const rx = receiver();
    const endpoint = await rx.listen();
    try {
      const obs = createObservability({
        service: SERVICE,
        methods: METHODS,
        errorCodes: CODES,
        exporter: otlpExporter({ endpoint }),
        minCellCount: 1,
        onRefused: () => {}, // see fences.test.ts: keeps the no-sink warning out of the output
        setInterval: (() => ({ unref () {} })) as unknown as typeof setInterval
      });
      obs.recordCall('POST /sync', '2xx', 5);
      obs.recordError('SYNC_TIMEOUT');
      obs.recordCall('nope' as never, '2xx', 5); // force a drop cell too
      await obs.flush();

      assert.ok(rx.bodies.length > 0, 'POSITIVE CONTROL FAILED: nothing was transported');

      // Enumerate what IS there. Spot-checking for what must not be there
      // cannot catch a key nobody thought to look for — this is the check
      // pryv's post-deploy verification ran, and the reason it found things
      // their suite did not.
      assert.deepEqual([...attributeKeys(rx.wire)].sort(), [
        'code', 'method', 'reason', 'service.instance.id', 'service.name',
        'service.version', 'status_class'
      ]);
    } finally {
      await rx.close();
    }
  });

  it('every string on the wire is a registered constant, over the real transport', async () => {
    const rx = receiver();
    const endpoint = await rx.listen();
    try {
      const obs = createObservability({
        service: SERVICE,
        methods: METHODS,
        errorCodes: CODES,
        exporter: otlpExporter({ endpoint }),
        minCellCount: 1,
        onRefused: () => {}, // see fences.test.ts: keeps the no-sink warning out of the output
        setInterval: (() => ({ unref () {} })) as unknown as typeof setInterval
      });
      obs.recordCall('POST /sync', '2xx', 5);
      obs.recordError('SYNC_TIMEOUT');
      obs.recordCall('nope' as never, '2xx', 5);
      await obs.flush();

      const allowed = new Set<string>([
        ...METHODS, ...CODES, ...STATUS_CLASSES, ...DROP_REASONS,
        SERVICE.name, SERVICE.version, SERVICE.instance,
        'hds.calls', 'hds.call.duration', 'hds.errors', 'hds.telemetry.dropped',
        'method', 'status_class', 'code', 'reason', '1', 'ms',
        'service.name', 'service.version', 'service.instance.id',
        'hds-observability-js', '0.2.0'
      ]);
      const strings: string[] = [];
      const walk = (n: unknown): void => {
        if (typeof n === 'string') strings.push(n);
        else if (Array.isArray(n)) n.forEach(walk);
        else if (n !== null && typeof n === 'object') Object.values(n as object).forEach(walk);
      };
      walk(JSON.parse(rx.wire));

      assert.ok(strings.length > 0, 'POSITIVE CONTROL FAILED: no strings transported');
      for (const s of strings) {
        if (/^\d+$/.test(s)) continue; // counts/timestamps, serialised as strings by OTLP
        assert.ok(allowed.has(s), `unexpected string on the wire: ${JSON.stringify(s)}`);
      }
    } finally {
      await rx.close();
    }
  });
});

/**
 * The three defects pryv's own post-deploy verification caught. All three are
 * failure modes this emitter shares by construction, and all three passed a
 * green suite upstream — which is exactly why they are asserted here rather
 * than reasoned about.
 */
describe('D: the three defects pryv found by verifying rather than reviewing', () => {
  it('#1 an empty vocabulary is a LOUD refusal, not silent inertness', () => {
    // With no registered methods, every recordCall is refused as
    // `unknown_method`: an emitter that logs "configured" and reports nothing.
    // That is the shape that let the previous generation of this layer sit
    // inert for six weeks. Construction must refuse it.
    assert.throws(() => createObservability({
      service: SERVICE,
      methods: [],
      errorCodes: CODES,
      exporter: async () => {}
    }), /methods must not be empty/);

    assert.throws(() => createObservability({
      service: SERVICE,
      methods: METHODS,
      errorCodes: [],
      exporter: async () => {}
    }), /errorCodes must not be empty/);
  });

  it('#2 a refusal names the offending value somewhere an operator can reach', async () => {
    // The wire carries only the REASON, correctly — the refused value is a
    // runtime string and must never be emitted. But if it is named nowhere at
    // all, a rising `unknown_method` counter is undiagnosable: the operator
    // cannot discover WHICH method id is wrong. Local logs already carry
    // identifiers, so naming it there adds no exposure.
    const refused: string[] = [];
    const obs = createObservability({
      service: SERVICE,
      methods: METHODS,
      errorCodes: CODES,
      exporter: async () => {},
      minCellCount: 1,
      onRefused: (reason, value) => { refused.push(`${reason}:${value}`); },
      setInterval: (() => ({ unref () {} })) as unknown as typeof setInterval
    });

    obs.recordCall('GET /users/alice/events' as never, '2xx', 5);
    obs.recordError('PATIENT_12345_FAILED' as never);
    obs.recordCall('POST /sync', 'weird' as never, 5);

    assert.deepEqual(refused, [
      'unknown_method:GET /users/alice/events',
      'unknown_error_code:PATIENT_12345_FAILED',
      'unknown_status_class:weird'
    ], 'the refused value is not surfaced to the local sink');
  });

  it('#2b omitting the sink warns ONCE, so the blindness is itself visible', () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    try {
      const obs = createObservability({
        service: SERVICE,
        methods: METHODS,
        errorCodes: CODES,
        exporter: async () => {},
        minCellCount: 1,
        setInterval: (() => ({ unref () {} })) as unknown as typeof setInterval
      });
      obs.recordCall('bad-one' as never, '2xx', 1);
      obs.recordCall('bad-two' as never, '2xx', 1);
      obs.recordError('bad-three' as never);
    } finally {
      console.warn = realWarn;
    }
    assert.equal(warnings.length, 1, 'expected exactly one warning, not one per refusal');
    assert.match(warnings[0], /no onRefused sink is configured/);
  });

  it('#3 has no frame sanitizer to escape, because no stack can be recorded', () => {
    // pryv's third defect was `..` escaping their stack-frame sanitizer. It
    // cannot occur here: there is no API that accepts a stack, a message, or
    // any free-text field, so fence 3 holds by construction rather than by
    // sanitisation. Asserted so that adding such a field breaks a test.
    const obs = createObservability({
      service: SERVICE,
      methods: METHODS,
      errorCodes: CODES,
      exporter: async () => {},
      setInterval: (() => ({ unref () {} })) as unknown as typeof setInterval
    });
    assert.deepEqual(Object.keys(obs).sort(), ['flush', 'recordCall', 'recordError', 'stop']);
    // recordError takes ONE argument: a code. No Error, no message, no stack.
    assert.equal(obs.recordError.length, 1);
  });
});
