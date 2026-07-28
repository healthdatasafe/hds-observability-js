# Changelog

## [Unreleased]

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
