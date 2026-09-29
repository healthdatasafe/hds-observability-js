import assert from 'node:assert/strict';
import { buildPayload } from '../src/otlp.ts';
import { createObservability, MIN_WINDOW_MS } from '../src/observability.ts';
import { DROP_REASONS, STATUS_CLASSES, type Exporter, type ServiceIdentity, type Window } from '../src/types.ts';

/**
 * These tests exist to prove the fencing directives of plan 88, not to exercise
 * the API. They assert what the TRANSPORT would carry, because asserting the
 * contents of our own objects is structurally incapable of catching the class
 * of defect that has bitten this codebase twice: a control that is present in
 * configuration and inert in practice.
 */

const SERVICE: ServiceIdentity = { name: 'bridge-test', version: '1.0.0', instance: 'i-01' };
const METHODS = ['GET /users/:username/events', 'POST /sync'] as const;
const CODES = ['SYNC_TIMEOUT', 'AUTH_FAILED'] as const;

function harness (opts: { minCellCount?: number } = {}) {
  const sent: Window[] = [];
  let clock = 1_700_000_000_000;
  const exporter: Exporter = async (w) => { sent.push(w); };
  const obs = createObservability({
    service: SERVICE,
    methods: METHODS,
    errorCodes: CODES,
    exporter,
    minCellCount: opts.minCellCount ?? 5,
    // These tests refuse payloads deliberately. A sink keeps the "no sink
    // configured" warning out of the output — noisy output is how real
    // warnings get ignored. The warning itself is covered in `sweep.test.ts`.
    onRefused: () => {},
    now: () => clock,
    setInterval: (() => ({ unref () {} })) as unknown as typeof setInterval
  });
  return { obs, sent, tick: (ms: number) => { clock += ms; } };
}

/** Every string value anywhere in a serialised payload. */
function stringValues (node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => stringValues(n, out));
  else if (node !== null && typeof node === 'object') {
    Object.values(node as Record<string, unknown>).forEach((n) => stringValues(n, out));
  }
  return out;
}

describe('fence: no free-text can reach the wire', () => {
  it('drops an interpolated method id instead of emitting it', async () => {
    const { obs, sent } = harness({ minCellCount: 1 });
    const username = 'alice@example.com';
    // The shape a careless caller would write.
    obs.recordCall(`GET /users/${username}/events` as never, '2xx', 12);
    await obs.flush();

    const json = JSON.stringify(sent.map((w) => buildPayload(w, SERVICE)));
    assert.ok(!json.includes('alice'), 'interpolated value reached the payload');
    assert.ok(json.includes('unknown_method'), 'the refusal was not counted');
  });

  it('drops an unregistered error code', async () => {
    const { obs, sent } = harness({ minCellCount: 1 });
    obs.recordError('PATIENT_12345_FAILED' as never);
    await obs.flush();
    const json = JSON.stringify(sent.map((w) => buildPayload(w, SERVICE)));
    assert.ok(!json.includes('12345'));
    assert.ok(json.includes('unknown_error_code'));
  });

  it('probe sweep: nothing a caller supplies at runtime appears on the wire', async () => {
    const { obs, sent } = harness({ minCellCount: 1 });
    const PROBE = 'zzprobezz';
    obs.recordCall(`GET /users/${PROBE}/events` as never, '2xx', 1);
    obs.recordCall('POST /sync', PROBE as never, 1);
    obs.recordError(PROBE as never);
    // A legitimate call, so the window is non-empty and the zeros mean something.
    obs.recordCall('POST /sync', '2xx', 5);
    await obs.flush();

    const json = JSON.stringify(sent.map((w) => buildPayload(w, SERVICE)));
    assert.ok(json.length > 0, 'positive control: the pipeline produced a payload');
    assert.ok(!json.includes(PROBE), 'probe reached the wire');
  });

  it('every string on the wire is a registered constant', async () => {
    const { obs, sent } = harness({ minCellCount: 1 });
    obs.recordCall('POST /sync', '2xx', 5);
    obs.recordError('SYNC_TIMEOUT');
    await obs.flush();

    const allowed = new Set<string>([
      ...METHODS, ...CODES, ...STATUS_CLASSES, ...DROP_REASONS,
      SERVICE.name, SERVICE.version, SERVICE.instance,
      // structural: metric/attribute names, scope, units
      'hds.calls', 'hds.call.duration', 'hds.errors', 'hds.telemetry.dropped',
      'method', 'status_class', 'code', 'reason', '1', 'ms',
      'service.name', 'service.version', 'service.instance.id',
      'hds-observability-js', '0.2.2'
    ]);
    for (const w of sent) {
      for (const s of stringValues(buildPayload(w, SERVICE))) {
        // Numeric strings are counts/timestamps serialised as strings by OTLP.
        if (/^\d+$/.test(s)) continue;
        assert.ok(allowed.has(s), `unexpected string on the wire: ${JSON.stringify(s)}`);
      }
    }
  });
});

describe('fence: no cell below the threshold is emitted', () => {
  it('withholds a sub-threshold cell', async () => {
    const { obs, sent } = harness({ minCellCount: 5 });
    for (let i = 0; i < 4; i++) obs.recordCall('POST /sync', '2xx', 3);
    await obs.flush();
    assert.equal(sent.length, 0, 'a cell of 4 was emitted with threshold 5');
  });

  it('defers rather than drops: totals survive into a later window', async () => {
    const { obs, sent } = harness({ minCellCount: 5 });
    for (let i = 0; i < 4; i++) obs.recordError('SYNC_TIMEOUT');
    await obs.flush();
    assert.equal(sent.length, 0);

    obs.recordError('SYNC_TIMEOUT'); // 5th
    await obs.flush();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].errors, [{ code: 'SYNC_TIMEOUT', count: 5 }],
      'deferred counts were lost rather than carried forward');
  });

  it('a single rare event is never emitted', async () => {
    const { obs, sent } = harness({ minCellCount: 5 });
    obs.recordError('AUTH_FAILED');
    for (let i = 0; i < 10; i++) await obs.flush();
    assert.equal(sent.length, 0);
  });
});

describe('fence: window floor and pinned resource', () => {
  it('refuses a window shorter than the floor', () => {
    assert.throws(() => createObservability({
      service: SERVICE,
      methods: METHODS,
      errorCodes: CODES,
      exporter: async () => {},
      windowMs: MIN_WINDOW_MS - 1
    }), /windowMs must be >=/);
  });

  it('refuses a service identity that could carry a runtime value', () => {
    assert.throws(() => createObservability({
      service: { ...SERVICE, instance: 'user alice@example.com' },
      methods: METHODS,
      errorCodes: CODES,
      exporter: async () => {}
    }), /service\.instance must match/);
  });

  it('emits exactly three resource attributes and detects nothing', async () => {
    const { obs, sent } = harness({ minCellCount: 1 });
    obs.recordCall('POST /sync', '2xx', 1);
    await obs.flush();
    const payload = buildPayload(sent[0], SERVICE) as {
      resourceMetrics: [{ resource: { attributes: { key: string }[] } }]
    };
    assert.deepEqual(
      payload.resourceMetrics[0].resource.attributes.map((a) => a.key).sort(),
      ['service.instance.id', 'service.name', 'service.version']
    );
  });
});
