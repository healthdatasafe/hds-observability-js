# Fences

The guarantees this library exists to provide, and the code that enforces each.
Each has a test in `tests/fences.test.ts` that asserts **what the transport would
carry**, not what our own objects contain — because a control that is present in
configuration and inert in practice passes the second kind of test and fails the
first. That has happened twice in this ecosystem, so it is the standard here.

| # | Fence | Enforced by | Test |
|---|---|---|---|
| 1 | Every value that can reach an exporter is a compile-time constant, a closed-enum member, or a number. The API has no free-text parameter. | `ObservabilityOptions.methods` / `errorCodes` are the allow-list; `recordCall`/`recordError` accept only their union members | *every string on the wire is a registered constant*; *probe sweep* |
| 2 | An unregistered id is refused, counted, and never emitted. | `createObservability` set-membership checks, `recordDrop` | *drops an interpolated method id*; *drops an unregistered error code* |
| 3 | No event-level record leaves. Only per-window totals are serialised. | `Aggregator` accumulates; `flush` emits cells | *defers rather than drops* |
| 4 | No cell below `minCellCount` is ever emitted. | `Aggregator.flush` skips and retains sub-threshold cells | *withholds a sub-threshold cell*; *a single rare event is never emitted* |
| 5 | Export is fixed-cadence, never flush-on-event. | interval timer in `createObservability`; no export path from `recordCall`/`recordError` | *(structural: no code path exists)* |
| 6 | Windows cannot be shortened toward per-event reporting. | `MIN_WINDOW_MS` floor | *refuses a window shorter than the floor* |
| 7 | The resource carries exactly three attributes and nothing is detected. | `otlp.ts` builds the resource from `ServiceIdentity` only | *emits exactly three resource attributes* |
| 8 | Service identity cannot smuggle a runtime value. | `SERVICE_FIELD_RE` validation at construction | *refuses a service identity that could carry a runtime value* |
| 9 | Telemetry failure never propagates to the caller. | `flush` catches; refusals return rather than throw | *(structural)* |

## Deliberate consequences

**A genuinely rare event never reaches the vendor.** Fence 4 defers sub-threshold
cells indefinitely rather than dropping them, so totals survive — but a code that
fires once and never again stays below the threshold forever. This is intended:
rare events are diagnosed from local logs, which stay on our own infrastructure
and carry the full context. Do not "fix" this by lowering `minCellCount` to 1 on
a low-traffic service; that is precisely where a cell of 1 identifies someone.

**Alerting is on rates and shapes, not on individual errors.** Nothing here
carries a stack trace, a message, or a timestamp finer than the window.

## What this library does NOT cover

- **Transport metadata.** The collector sees the emitting host's IP, TLS
  fingerprint and request cadence. Front it with a collector inside your own
  trust boundary if that matters.
- **A collector that re-adds attributes.** A `resourcedetection` processor
  downstream will append exactly what fence 7 refuses to send. Configure the
  collector to forward the resource unchanged.
- **Egress.** Fence 1 covers this library. It does not stop some other
  dependency opening its own socket. Restrict egress so only the collector can
  reach the vendor; that is the only control that covers code you did not write.
