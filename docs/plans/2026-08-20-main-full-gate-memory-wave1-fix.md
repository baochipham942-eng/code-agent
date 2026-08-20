# Wave 1 memory Main Full Gate repair

## Incident

The post-merge Main Full Gate failed on both memory Wave 1 merges:

- The soft-archive guidance raised the always-on prompt estimate to 3132 tokens,
  above the existing 3100-token ceiling.
- The configurable memory-model change moved conversation judgment from
  `quickTask` to `memoryTask`, but `durableFacts.test.ts` still mocked the old
  entry point. Three full-suite assertions therefore received heuristic results
  with no durable facts.

PR checks did not include either full-suite assertion. The post-merge combo gate
correctly detected the integration gap.

## Repair

- Compress the new memory guidance while retaining archive, historical-context,
  re-verification, and explicit archive-inspection semantics. The estimate is
  now 3085 tokens.
- Update the durable-facts test mock and assertions to exercise `memoryTask`.

No production routing or archive behavior changes in this repair.

## Verification

- Typecheck passed.
- Focused prompt, durable-facts, memory routing, and review suites: 5 files,
  67 tests passed.
- Full Vitest with four workers: 2370 files passed, 4 skipped; 20473 tests
  passed, 7 skipped, 29 todo.
- Changed-file ESLint passed.
- Web and renderer production builds passed.
- `git diff --check` passed.
