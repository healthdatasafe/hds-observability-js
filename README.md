# hds-observability-js

Allow-list telemetry emitter. Aggregate metrics and error counts over OTLP, with
no vendor agent in the process and no free-text field anywhere in the API.

Built for [Health Data Safe](https://healthdatasafe.org), where the operating
constraint is that **no patient identifier, no user content and no event-level
record may reach an observability vendor** — and that the claim has to be
provable rather than asserted.

## Why an allow-list

The usual approach is a deny-list: run the vendor's agent, enumerate the
attributes that must not leave, and filter them. It cannot prove a negative, and
it fails silently. Two instances within six weeks, both found only by inspecting
what the vendor had actually received:

- an agent configuration placed in a file the agent does not scan for, so the
  whole preset was inert while every test passed;
- an attribute exclusion written as `request.headers.user-agent` when the agent
  emits `request.headers.userAgent`, so it matched nothing.

This library inverts the model. There is no parameter that accepts a runtime
string, so a user value cannot be interpolated into telemetry — not because it
is filtered, but because there is nothing to interpolate it into. Anything not
in the registered allow-list is refused and counted.

## Usage

```ts
import { createObservability, otlpExporter } from 'hds-observability-js';

const METHODS = ['GET /users/:username/events', 'POST /sync'] as const;
const ERROR_CODES = ['SYNC_TIMEOUT', 'UPSTREAM_AUTH_FAILED'] as const;

const obs = createObservability({
  service: { name: 'bridge-example', version: '1.4.0', instance: 'i-01' },
  methods: METHODS,
  errorCodes: ERROR_CODES,
  exporter: otlpExporter({ endpoint: 'http://127.0.0.1:4318/v1/metrics' })
});

obs.recordCall('POST /sync', '2xx', 42.5);
obs.recordError('SYNC_TIMEOUT');
```

`methods` are **route patterns, never concrete paths**. A concrete path is how a
username reaches a vendor as a first-class attribute. An interpolated id such as
`` `GET /users/${username}` `` does not match a registered pattern, so it is
dropped and counted under `hds.telemetry.dropped{reason="unknown_method"}`
rather than emitted.

Refusals never throw. A telemetry path must not be able to take down the service
it observes.

## What is emitted

| Metric | Type | Attributes |
|---|---|---|
| `hds.calls` | delta sum | `method`, `status_class` |
| `hds.call.duration` | delta histogram (ms) | `method`, `status_class` |
| `hds.errors` | delta sum | `code` |
| `hds.telemetry.dropped` | delta sum | `reason` |

Resource: `service.name`, `service.version`, `service.instance.id`. Nothing else,
and nothing is detected.

## Defaults worth knowing

- **`windowMs`: 5 minutes**, floored at 60 s. Export is fixed-cadence; there is
  no flush-on-event path, because the arrival time of an event-triggered request
  reveals the event time regardless of the payload.
- **`minCellCount`: 5.** Cells below it are **deferred, not dropped** — they
  accumulate and are emitted once the running total clears the threshold, so
  totals survive and only their timing is coarsened. The deliberate consequence
  is that a genuinely rare event never reaches the vendor; diagnose those from
  local logs.

## Scope

This library covers what *it* sends. It does not stop another dependency opening
its own socket, and it does not control what a collector adds downstream. Pair
it with a collector that forwards the resource unchanged and with egress rules
that let only the collector reach the vendor.

Full list of guarantees, the code enforcing each, and the deliberate gaps:
[`docs/FENCES.md`](docs/FENCES.md).

## Development

```bash
npm run setup      # install + build
npm test           # fence tests
npm run typecheck
npm run lint
```

## Licence

BSD-3-Clause.
