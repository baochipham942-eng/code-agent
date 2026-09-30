---
name: cross-layer-drift-sweep
description: Load when a contract, name, default, schema, or user-facing copy change may drift across Neo layers.
---

# Cross-layer drift sweep

## Change axes and blind spots

| Change axis | Known blind spot |
| --- | --- |
| Type narrowing | A shared union or guard narrows, but host adapters, renderer callers, or fixtures still send the wider shape. |
| Field rename | A serializer, IPC/SSE mapper, snapshot, or documentation example still emits or reads the old key. |
| Default value change | Omitted input keeps an old default in config, CLI, web/SSE, desktop UI, or the Tauri shell. |
| Contract/schema change | Runtime validation, generated types, persistence, or replay fixtures accept a schema different from the shared contract. |
| User-facing copy change | An i18n key, renderer label, host error code mapping, snapshot, or docs example still uses the old wording. |

Choose the row that describes the change, then check every blind spot before calling the change done.

## Sweep both expressions

1. Write down the exact old expression and the exact new expression, including spelling, casing, serialized keys, and user-visible text.
2. Run plain `grep -rn` for **both** expressions across every layer: shared contract, host, renderer, tests, fixtures/snapshots, docs, and scripts.

   ```bash
   grep -rn -- '<old-expression>' src/shared/contract src/host src/renderer tests/fixtures tests docs scripts
   grep -rn -- '<new-expression>' src/shared/contract src/host src/renderer tests/fixtures tests docs scripts
   ```

3. Classify every old-expression hit as intentionally retained or stale. Follow each new-expression hit to its consumer; a declaration without a consumer is not coverage.

## Verify at the observable layer

- Exercise the real output, rendered result, or serialized bytes that a user or downstream adapter receives. Include a snapshot-replay fixture when the behavior is replayable.
- Record the observable assertion and its evidence alongside the parser or unit-test result.
- “Only the parser/unit tests passed” is not acceptable evidence.
