---
name: verify-all-runtime-sinks
description: Load when a runtime change could leave alternate Neo entry points, caches, generated values, or artifacts on old behavior.
---

# Verify all runtime sinks

## Consumer table

Start every row as `unknown`. Replace it only after checking the real consumer and recording evidence.

| Dimension | What to inspect in Neo | Status |
| --- | --- | --- |
| parse -> runtime | Trace parsed input through the shared contract, host runtime, and the observable result. | `unknown` |
| alternate entry points | Confirm the real list with grep before editing this row: desktop UI, web/SSE, headless/CLI runner, and ACP/external engine adapters. Exercise each entry point. | `unknown` |
| generated or cached values | Check generated requests, persisted defaults, compiled output, caches, and any replayed value that can outlive the source change. | `unknown` |
| fixtures and artifacts | Check tests/fixtures, snapshot-replay data, serialized bytes, and delivered artifacts for old behavior. | `unknown` |

## Status rules

- Mark a row `covered` only when the relevant sink was exercised or inspected and the evidence is recorded.
- Mark a row `not-applicable` only with a concrete reason tied to this change; do not use it to skip an uncertain sink.
- Leave a row `unknown` when the sink has not been checked or the evidence is ambiguous.

## Completion claim

Claim verification complete only when every row is `covered` or `not-applicable` with a reason. If any row is unknown, you may not claim the verification is complete.
