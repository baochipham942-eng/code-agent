# Codex Audit Report — coverage-planning-cron

**Date**: 2026-06-23
**Scope**: `origin/main..test/coverage-planning-cron` (10 new test files + 2 source fixes)
**Starting commit**: 3b58... (branch head before audit), fixes through `18c065079`
**Rounds run**: 3 / 4
**Converged**: ✅ yes (for the change set under review; 1 pre-existing cross-file security gap escalated, not in scope)

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     |  2   |  6  |  0  | 457dd6ed7  |
| 2     |  0   |  0  |  3 (1 fixed, 2 deferred) | 18c065079 |
| 3     |  0   |  1 (deferred/escalated) | 0 | — |

Trend: **2H → 0H → 0H** (monotonic convergence). 0 false positives across all rounds.

## Findings by Round

### Round 1 — 2 HIGH + 6 MED (all resolved)

#### 🔴 HIGH — matchDangerousBash dead safety guard (casing)
**Finding**: `matchDangerousBash()` checked `context.toolName !== 'bash'`, but the bash
tool registers at runtime as `'Bash'` (capital B, `bash.schema.ts`). The planning-layer
dangerous-command blocker (`dangerousBashBlock`, priority 200) therefore **never fired**
in production — `rm -rf /` via toolName `'Bash'` was not blocked by this hook. The new
test locked in the broken behavior (only tested lowercase `'bash'`).
**Resolution**: ✅ fixed in `457dd6ed7` — `context.toolName?.toLowerCase() !== 'bash'`.
Test asserts `'Bash'`/`'BASH'` + `rm -rf /` are now blocked.

#### 🔴 HIGH — heartbeatTaskLoader orphan jobs on file deletion
**Finding**: `loadFromFile()` returned early on missing `HEARTBEAT.md` **without** calling
`cleanup()`. Deleting the file to disable heartbeat tasks (e.g. via the file watcher's
reload) left previously-registered cron jobs running as orphans.
**Resolution**: ✅ fixed in `457dd6ed7` — `await this.cleanup()` before the early return.
Test: load → delete file → reload → expect `deleteJob('job-1')`.

#### 🟡 MED ×6 (all fixed in `457dd6ed7`)
- cronAutomationBridge `syncCronAutomationFromJob`: asserted only that `upsert` was called,
  not the payload → now asserts the full `UpsertSessionAutomationInput` incl. resolver-injected `nextRunAt`.
- cronAutomationBridge one-time fixture drift (`scheduleType:'at'` but `schedule:{type:'every'}`)
  → fixture now uses `schedule:{type:'at', datetime}`.
- planManager phase-id round-trip not covered (phase ids are regenerated on read, not persisted)
  → added an explicit test **documenting** the current behavior (left as a known limitation, not a source change).
- errorTracker `getRecentErrors` recency sort untested due to same-ms ties → `Date.now` stubbed per log, exact newest-first order + limit asserted.
- findingsManager `getSummary` "most recent" only checked bullet count → time controlled, newest-2 asserted present and oldest-2 absent.
- feasibilityChecker env-var test leaked `process.env` → now saves/restores the original value.

### Round 2 — 0 HIGH, 1 LOW fixed, 2 deferred

#### 🟢 LOW — heartbeatTaskLoader TOCTOU (fixed)
**Finding**: After `existsSync` returns true, the file can be deleted before `readFileSync`,
which throws `ENOENT`; the catch only logged → orphan jobs again.
**Resolution**: ✅ fixed in `18c065079` — in the catch, if `!fs.existsSync(filePath)` then
`await this.cleanup()`. A transient read error where the file still exists keeps jobs intact
(intentional asymmetry). Test simulates exists→ENOENT via `vi.mock('fs')` passthrough + one-shot spies.

#### Deferred (Round 2)
- **MED matchDangerousBash rm-flag-order** — deferred under "primary guard covers it". Round 3 partially overturned this (see below).
- **LOW TOOL_CATEGORIES missing `'Append'`** — `Append` is a real registered write tool, but is already treated as write in the real execution / permission-classifier / git-status paths. Adding it to `TOOL_CATEGORIES` only changes planning-hook reminder/observer behavior. Deferred as a behavior change for the owner. **Codex confirmed this defer is reasonable in Round 3.**

### Round 3 — 0 HIGH, 1 MED (escalated, out of scope)

Heartbeat regression audit: **no finding** — catch-block cleanup is idempotent (clears
`registeredJobIds`), no double-delete, `vi.mock('fs')` passthrough is file-local with
restored one-shot spies, no leakage. Symmetric TOCTOU sweep: **no other orphan-risk site**
(other `existsSync→read` cases degrade to empty/null, none keep long-lived cron jobs).

#### 🟡 MED — dangerous `rm` long-flag bypass (PRE-EXISTING, ESCALATED — not fixed)
**Finding** (Codex node-regex verified): `rm -fr /` IS covered by the primary guard
`commandSafety.validateCommand` (`rm\s+(-[rRf]+\s+)*[\/~]`), so that part of the Round-2
defer holds. BUT **`rm --recursive /`, `rm -r --force /`, `rm --force --recursive ~`
(long-form / split flags) are matched by NONE of the three dangerous-command detectors**:
- `src/main/security/commandSafety.ts:436` (primary guard)
- `src/main/planning/matchers.ts:105` (`matchDangerousBash`, secondary)
- `src/main/tools/permissionClassifier.ts:98` (classifier fast-path deny)

In strict mode an unknown command still routes to "ask" (not auto-approve), so this is not a
silent catastrophic auto-run, but the dedicated dangerous-command detectors do have a real
long-flag blind spot.

**Resolution**: ❌ **DEFERRED / ESCALATED to owner.** This is a pre-existing security gap
spanning 3 security-critical files (2 of which this coverage PR never touched). Fixing it
means coordinated regex/flag-normalization changes across the command-safety layer + new
tests — a security-hardening task that deserves its own PR and explicit owner decision, not
a ride-along in a test-coverage PR. **Recommended follow-up: a dedicated PR that normalizes
`rm` flags once (cover `--recursive`/`--force`, mixed short/long, any order, `--` separator)
and updates all three detectors with shared tests.**

## Deferred / Escalated Items (not fixed this cycle)
- **MED `rm --recursive` long-flag bypass** across commandSafety / matchers / permissionClassifier — pre-existing, cross-file, security-logic; escalated for a dedicated hardening PR.
- **LOW `TOOL_CATEGORIES` missing `Append`** — behavior change to planning hooks; owner decision.
- **MED planManager phase ids not persisted** (from R1) — documented via test, left as a known limitation; owner decision whether to persist phase ids.

## Convergence Analysis

The change set under review converged cleanly: Round 1's two HIGH were genuine latent
production bugs (a dead safety guard and orphaned cron jobs) that the new coverage tests had
locked in — exactly the confirmation-bias class this audit exists to catch. Both were fixed
TDD-first. Round 2 found one symmetric edge case (TOCTOU) in the same file, fixed it, and the
deferrals held except for a precision correction. Round 3 confirmed no regression in the
fixes and surfaced a single pre-existing, cross-file security gap (`rm` long-flag bypass)
that is correctly out of scope for a coverage PR and is escalated for a dedicated follow-up.

Symmetric-application lesson reinforced: when a fix normalizes one literal comparison
(tool-name casing) or one early-exit (missing-file cleanup), immediately sweep siblings —
casing was a single point here, but the cleanup had a TOCTOU twin one catch-block away.
