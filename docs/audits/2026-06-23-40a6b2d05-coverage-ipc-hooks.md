# Codex Audit Report — coverage-ipc-hooks

**Date**: 2026-06-23
**Scope**: `origin/main..test/coverage-ipc-hooks` (PR #268, test-coverage work for src/main/ipc + src/renderer/hooks)
**Starting commit**: 40a6b2d05
**Rounds run**: 4 / 4
**Converged**: ✅ yes (count 6→5→5→1, severity HIGH→MED→MED→MED, 0 false positives all rounds)

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     |  1   |  4  |  1  | 0c1b9596a  |
| 2     |  0   |  4  |  1  | 3d3521fea  |
| 3     |  0   |  5  |  0  | 8789b467b  |
| 4     |  0   |  1  |  0  | c318c13a1  |

All 16 findings were real (0 false positives). 2 were genuine **production bugs** in `useVoiceInput.ts`
that the coverage tests had masked; the rest were test-validity gaps (coverage as vanity metric).

## Findings by Round

### Round 1 — divergent 8-dimension sweep
- 🔴 HIGH — pii.ipc spawn assertion vacuous (only counted calls, never verified executable/script/env/stdio). **Fixed** 0c1b9596a — asserts `process.execPath`, script arg, stdio, `CODE_AGENT_BUNDLED_UV/RUNNER` env.
- 🟡 MED — **useVoiceInput production bug**: `UNSUPPORTED` precheck branch never set `status='error'` (asymmetric with `DISABLED`), leaving UI at `idle` while holding an error. **Fixed** (production) + TDD assertion (red→green).
- 🟡 MED — marketplace fixture `source`/`lastUpdated` shapes (string/number) violated real `MarketplaceInfo` contract (object / ISO string). **Fixed** — aligned to contract.
- 🟡 MED — settings testApiKey only asserted GET/POST, not endpoint/headers/body. **Fixed** — full fetch assertion per provider.
- 🟡 MED — connector openApp success was host-dependent (`process.platform`), would break Linux/Windows CI. **Fixed** — pins platform + adds non-darwin failure case.
- 🟢 LOW — settings env restore not in `finally`. **Fixed**.

### Round 2 — symmetric application of round-1 fixes
- 🟡 MED — **useVoiceInput production bug (symmetric)**: after round-1 set `status='error'` on UNSUPPORTED, a stale `pendingAudioRef` from a prior recoverable failure made `canRetry` wrongly true on front-door errors. `DISABLED` had the same latent gap. **Fixed** (production) — both branches clear `pendingAudioRef` + regression test.
- 🟡 MED — memory v2 entry tests only proved runtime called, not with which args; delete/pack/importV2 uncovered. **Fixed** — `toHaveBeenCalledWith(db, payload)` + missing actions + entryId/schemaVersion error cases.
- 🟡 MED — skill.ipc SkillsMP success only asserted URL query (same class as round-1 settings). **Fixed** — asserts Authorization/Content-Type/signal.
- 🟡 MED — marketplace `installedAt` fixtures numeric, violate `InstalledPlugin` (string). **Fixed** — ISO strings.
- 🟢 LOW — trailing whitespace (git diff --check). **Fixed**.

### Round 3 — remaining "assert called, not with what" instances
- 🟡 MED ×5 — skill.ipc (session/combo/draft IDs), memory legacy CRUD (deleteByCategory keys + import args), settings setDevMode (full payload), useVoiceInput (transcribe ASR options), marketplace refresh-all (targets a/b). All **fixed** — arg/payload assertions added. Codex confirmed 0 regressions from round-2 prod fixes, 0 new contract/host issues.

### Round 4 — final, convergence
- 🟡 MED — symmetric test-completeness gap: round-2's `pendingAudioRef` fix covers DISABLED + UNSUPPORTED in production, but only UNSUPPORTED had a regression test. **Fixed** — added DISABLED regression test (discriminating power verified by removing the production clear → test goes red).

## Deferred Items
None. All findings resolved within scope.

## LOW Findings (informational)
Both LOWs (env-restore-in-finally, trailing whitespace) were bundled into the same-file MED commits.

## Convergence Analysis

The audit converged cleanly. The dominant pattern across rounds was **symmetric application**:
the same defect class (vacuous "called but not with what" assertions; contract-divergent fixtures;
asymmetric error-state handling) recurred in sibling locations that round-N fixes didn't propagate to.
Round 1 fixed one instance per class; rounds 2–3 swept the remaining siblings; round 4 caught the
last test-completeness asymmetry (a fix applied to two production branches but tested on one).

**Two real production bugs** (both in `useVoiceInput.ts`, both error-state asymmetries between the
DISABLED and UNSUPPORTED prechecks) were surfaced only because Codex read the code without the
committer's "tests pass = done" narrative — exactly the confirmation-bias gap this loop targets.

Lesson for future round-1 reviews of coverage work: when a test only asserts a mock *was called*,
treat it as a finding by default unless the args are genuinely argument-free; and when fixing any
error-state / cleanup in one branch, immediately check (and test) the sibling branches.
