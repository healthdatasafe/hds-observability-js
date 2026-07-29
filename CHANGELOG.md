# Changelog

## [0.2.0] — 2026-07-29

Plan 88 workstream D. Two defects found by **verifying against a running
collector** rather than reviewing the code — both of which a green suite had
already passed, and both of which pryv's own post-deploy verification caught in
their equivalent emitter. That is the whole argument for fence 13.

### Fixed — an empty allow-list produced a silently inert emitter

`createObservability` accepted `methods: []` / `errorCodes: []`. The result
refuses **every** datapoint as unknown, so the service reports itself
instrumented and ships nothing but drop counts. This is the exact shape that let
the previous generation of this layer sit inert for six weeks without a test
failing. Construction now throws instead. **Breaking** for anyone who was
(pointlessly) constructing with an empty list.

### Added — `onRefused`, so a refusal names the offending value

The wire carries only the refusal *reason*, and must: the value is a runtime
string, which is precisely what may not be emitted. But it was previously named
**nowhere at all**, which made a rising `unknown_method` counter undiagnosable —
an operator could see that something was wrong and had no way to discover which
method id. `onRefused(reason, value)` routes it to the service's own logger;
local logs stay on our infrastructure and already carry identifiers, so this
adds no exposure.

Omitting the sink is supported but warns **once**, because "refusals are
happening and nobody can tell you what they were" is the same blindness this
library exists to eliminate. Export failures now also report their cause to the
sink rather than being swallowed into a bare `export_failed` count.

### Added — the workstream D payload sweep (`tests/sweep.test.ts`)

Drives the **real `otlpExporter` at a real socket** and sweeps the bytes that
actually left the process. The pre-existing fence tests capture `Window` objects
from an in-memory exporter and assert against `buildPayload` — that asserts our
own objects and never exercises the transport, the one layer where a payload
could acquire something on the way out.

Ten identifier strings (username, email, record id, credential-bearing URL,
attachment path, bearer token, stream id, password, phone, national id) pushed
through **every position a caller can reach** — interpolated method, status
class, error code, and junk durations — each with positive controls, because a
sweep that finds nothing because nothing was sent proves nothing. Also asserts
the auth header does not bleed into the body, and **enumerates** the attribute
inventory rather than checking for absence.

**Verified end-to-end against the live dev collector** (`_local/scripts/obs/sweep-against-collector.ts`),
not just in-process: 30 identifier/position combinations refused, capture file
grew 92,606 → 94,596 bytes with the positive controls present, and zero
occurrences of any marker. Attribute inventory in the capture is exactly
`code`, `method`, `reason`, `service.instance.id`, `service.name`,
`service.version`, `status_class`.

### Not applicable — the third defect

pryv's third finding was `..` escaping their stack-frame sanitizer. There is no
frame sanitizer here to escape: no API accepts a stack, a message, or any
free-text field, so fence 3 holds by construction rather than by sanitisation.
Asserted as a test so that adding such a field breaks the build.

## [0.1.0]

- Initial library (plan 88, workstream 2). Allow-list telemetry emitter: aggregate
  metrics and error counts over OTLP/HTTP, no vendor SDK in the process, no
  free-text parameter anywhere in the API.
- `createObservability` — registered method patterns and error codes are the
  allow-list; anything else is refused and counted under
  `hds.telemetry.dropped`. Refusals never throw.
- `Aggregator` — fixed windows (default 5 min, floored at 60 s) with small-cell
  **deferral**: cells below `minCellCount` (default 5) accumulate into the next
  window rather than being dropped, so totals survive and only their timing is
  coarsened.
- `otlpExporter` / `buildPayload` — OTLP/HTTP JSON via `fetch`. Resource is
  exactly `service.name`, `service.version`, `service.instance.id`; nothing is
  detected or appended.
- `docs/FENCES.md` — the nine guarantees, the code enforcing each, the test
  proving it, and the deliberate gaps this library does not cover (transport
  metadata, collector-added attributes, egress).
- Fence tests assert what the **transport** would carry, including a probe sweep
  proving a caller-supplied value cannot reach the wire through any entry point.
