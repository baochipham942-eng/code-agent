# ADR 007 — Protocol Migration: What the Fan-in Numbers Actually Mean

**Date**: 2026-04-13
**Status**: accepted
**Context**: P0-5 phases A/+1/B/C (protocol-layer migration, second pass)

## Background

The plan in `~/.claude/plans/rustling-yawning-snowflake.md` and the earlier
`docs/architecture/protocol-layer-migration-plan.md` set three quantitative
targets for the second migration pass:

| metric              | baseline (2026-04-13) | target      | delta   |
|---------------------|:---------------------:|:-----------:|:-------:|
| services fan-in     | 618                   | ≤ 450       | −168    |
| tools fan-in        | 531                   | ≤ 400       | −131    |
| protocol/* fan-in   | ~5                    | ≥ 80        | +75     |
| EventBus consumers  | 4                     | ≥ 20        | +16     |
| circular deps (main)| 4                     | 4 → 0 (ADR-008) | -4 |

After executing phases A (EventBus merge), +1 (hook-type sinkdown),
and B (services repository-type sinkdown), the `services fan-in 618 → 450`
target looks unachievable by type-sinkdown alone. This ADR records the
reality check so the next iteration doesn't re-litigate the same analysis.

## The services/ 618 number is mostly one file

`services/infra/logger.ts` is **337 of the 618** (54.5%). Every consumer
imports `createLogger(context)` — a runtime function that must live in a
mutable module (it holds a write stream, a log directory, a level filter,
and a ServiceRegistry registration). It is not a "type" that can be
relocated to `protocol/`, and moving the function itself would violate the
invariant that `protocol/` contains declarations only.

Subtracting logger, the remaining services fan-in is 281 spread across
~60 files. A targeted scan (`type exports ≥ 50% of file exports`,
`fan-in ≥ 3`) returned only three candidates with combined fan-in of 12:

```
services/infra/supabaseService.ts  4
services/infra/browserService.ts   4
services/infra/toolCache.ts        4
```

**Conclusion:** the realistic ceiling for "services type sinkdown without
touching logger or DI class interfaces" is ~20–30 fan-in, not 168.
Reaching 450 would require either (a) relocating logger (architecturally
wrong), or (b) extracting interfaces from long-lived DI classes like
`ConfigService` — high-risk surgical work that wasn't scoped here.

## The tools/ 531 number is 94.7% internal self-reference

Cross-layer import analysis:

```
tools/ → tools/           503 edges  (94.7%)
tools/ → outside tools/    28 edges  ( 5.3%)
```

So the 531 isn't "many other modules depending on tools/" — it's **tools/
depending on itself** across 277 files. The 28 edges that actually reach
out are dominated by five top-level utilities:

```
tools/dataFingerprint.ts   6
tools/executionPhase.ts    6
tools/fileReadTracker.ts   6
tools/protocolRegistry.ts  5
tools/toolExecutor.ts      2
```

**And every one of those 28 is a runtime import** — consumers reach for
`classifyExecutionPhase()`, `fileReadTracker` (the singleton),
`dataFingerprintStore` (the singleton). Extracting type shapes to
`protocol/tools.ts` does not reduce those counts because the value-level
binding is still needed.

Inside `tools/` the real coupling story is `tools/modules/` — the
P0-6 "migrated" tool wrappers — as a glue layer:

```
modules → network     23
modules → planning    13
modules → multiagent   9
modules → shell        7
modules → vision       7
modules → root         5
modules → lsp          4
modules → utils        4
modules → mcp          3
                     ---
                      75  (14% of tools/'s total internal edges)
```

That matches the pattern the ESLint "P0-6 Gate" already encodes: legacy
category directories are grandfathered for `tools/modules/**` only.
Adding a new restriction layer here would collide with the existing gate
rather than reinforce it.

**Conclusion:** tools/ isn't a God Module, it's a tool *box*. The 531
reflects its size, not a design failure. Size-driven metrics over a
complete tool catalogue are a weak signal.

## What phases A / +1 / B / C actually shipped

- **A** — EventBus runtime moved from `events/` to `protocol/events/`;
  `events/eventBatcher.ts` `AgentEvent` category file split into
  `protocol/events/categories.ts`. EventBus consumers: 4 → 7 (value-level).
  `agentOrchestrator.ts` replaced its dynamic `require('../../events/eventBus')`
  with a static import — a small but real bit of architectural integrity.

- **+1** — The plan said "hook runtime missing". That observation was
  wrong: `HookManager` exposes 12 trigger methods (PreToolUse / PostToolUse /
  UserPromptSubmit / SessionStart / SessionEnd / PreCompact / Stop /
  PermissionRequest / SubagentStart / SubagentStop / PostToolUseFailure /
  PostExecution) and they are invoked live across `toolExecutionEngine`,
  `conversationRuntime`, `runFinalizer`, `autoCompressor`, `planningService`,
  `subagentExecutor`. The real debt was **two parallel dictionaries**:
  `protocol/events/categories.ts` had a dead 16-entry `HOOK_EVENTS` const,
  while `hooks/events.ts` held the live 19-entry `HookEvent` union.
  Phase +1 collapsed them — `hooks/events.ts` was moved to
  `protocol/events/hookTypes.ts`, JSDoc `@deprecated` tags were converted
  to inline comments (they were propagating to the whole union and marking
  every consumer site), 14 internal and 3 external imports were rewritten.

- **B** — Nine SQLite record types (Session / Memory / Config repositories)
  were sunk into `protocol/types/repositories.ts`. The repository classes
  re-export from protocol for backward compat; two external type-only
  consumers (`desktop/workspaceArtifactIndexService`,
  `desktop/desktopActivityUnderstandingService`) now import directly from
  protocol. Services fan-in *number* stayed at 618 because madge ignores
  `import type`, but `protocol/types/repositories.ts` is now the source
  of truth so future divergence is architecturally blocked.

- **C** — `ExecutionPhase` / `DataFingerprint` / `ToolFact` shapes moved
  into `protocol/tools.ts`. Runtime (`classifyExecutionPhase()`,
  `dataFingerprintStore`) remains in `tools/` because it's holds singletons.
  No consumer paths changed.

## What the next iteration should target instead

**Kill the size-driven fan-in targets.** Use them as a tripwire ("did
anything go badly sideways?") but not as a goal.

**Better indicators for P0-5 follow-ups:**
- `protocol/` directly imported from outside protocol/ *at the value level*:
  baseline 9, goal 20+ (forces new runtime boundaries through protocol).
- Dynamic `require()` calls to cross-module runtime:
  baseline 35 total / ~19 intentional. Each one is a hidden dep that
  madge can't see. (See "P0-6 dynamic require pass" below.)
- Circular deps: baseline 4, goal still 4 — all inside `agent/hybrid/*` +
  `ipc/swarm.ipc.ts` + `agent/subagentExecutor.ts`. They need an Actor-model
  refactor, not more protocol/.
  **Update (2026-04-13): Resolved by [ADR-008](./008-swarm-actor-refactor.md)** —
  all 4 swarm cycles eliminated via EventBus pub/sub + bridge subscriber
  pattern. `madge --circular src/main/` now reports 0.

### Retracted sub-goal: "tools/modules cross-subdir 75 → 60"

The original version of this ADR proposed targeting `tools/modules/`
cross-subdir imports as the next thing after protocol/. That number was
based on flat "which subdir imports which subdir" counting and didn't
distinguish the two very different things buried inside it:

```
tools/modules/<X>/ → tools/<X>/   (wrapper delegating to its own
                                    category's legacy impl, **by design**
                                    per P0-6 Gate)
tools/modules/<X>/ → tools/<Y>/   (cross-category, potentially debt)
```

Breaking it down with the category match requirement:

```
tools/modules/<X> → tools/<X>    69 edges  ( same-category, intentional )
tools/modules/<X> → tools/<Y>    12 edges  ( cross-category               )
                                 --
                                 81 edges total
```

The 69 same-category edges **are the whole point of the modules/ layer**:
every `modules/<cat>/wrappers.ts` delegates to the legacy impl in
`tools/<cat>/`. Removing them would remove the wrappers themselves.

Of the 12 cross-category edges, every one is a utility dependency:

```
modules/file     → tools/utils/   4  (atomicWrite, safeRename, etc.)
modules/file     → tools/root/    3  (fileReadTracker, executionPhase)
modules/file     → tools/lsp/     2  (diagnosticsHelper for post-edit check)
modules/document → tools/excel/   1
modules/network  → tools/root/    1  (dataFingerprint)
modules/shell    → tools/root/    1  (backgroundTasks helper)
```

These are all legitimate "my wrapper needs the shared util in tools/root
or tools/utils". There is no hidden glue-layer to untangle — it was a
statistical artifact of collapsing both classes of edge into one metric.

**Retraction:** don't target `75 → 60`. The real count is 12 and there
is no action to take on them.

## P0-6 dynamic require pass (appended 2026-04-13 after ADR landed)

First pass eliminated 12 of ~35 `require()` call sites in src/main:

- `agentOrchestrator.ts` ×3 — comboRecorder singleton (now static import)
- `configService.ts` — getCloudApiUrl (`shared/constants` is a leaf)
- `logger.ts` — getLogDir (`platform/appPaths` is a leaf)
- `telemetryCollector.ts` ×2 — telemetryStorage was **dead duplication**
  (the same function was already statically imported at the top of the
  file; the require was copy-paste noise, not a cycle-break)
- `contextBuilder.ts` — appPaths for runtime-mode block
- `agentAdapter.ts` — platform availability probe
- `crossVerify.ts` ×2 — mcpClient. A comment claimed "lazy to avoid
  circular dep", but mcpClient has no back-edge to agent/. It was a
  stale comment carried over from an older file layout.
- `taskRouter.ts` — **dead code**: `require('../profiling/agentProfiler')`
  pointed to a module that has never existed in this repo. The try
  block always fell through. Removed the block entirely.

Retained as intentional cycle-breaks or CJS interop:

- `logger.ts:283` ↔ `serviceRegistry.ts:122` — real 2-cycle: logger
  registers itself into ServiceRegistry; ServiceRegistry needs logger
  to log. Breaking this cleanly requires inverting the init path
  (have app bootstrap pull the logger into the registry from outside),
  which is a separate piece of work.
- `taskRouter.ts:404 → app/bootstrap` — reverse-direction read (agent
  layer reaching up to read app-level settings). Forward-wiring would
  require a context parameter plumbed through taskRouter's callers.
  Out of scope for this pass.
- `swarm.ipc.ts:386 → teammateService` — on the swarm cycle already
  blocked on the Actor-model refactor.
- 16 CJS-interop / optional-dep requires: better-sqlite3, keytar,
  jszip, pptxgenjs, exceljs, node-fetch, onnxruntime-node, etc.
  These are legitimate and will stay.

Verification: circular deps 4/4, typecheck pass, no value-graph changes
in madge.

## Decision

- Close phases A / +1 / B / C with the honest story (this ADR is the story).
- Don't try to hit 450 / 400 by contorting logger or the tools tree.
- Next protocol-layer pass should target *runtime boundaries* (dynamic
  requires, value-level cross-layer imports) instead of type locations.

## Consequences

- `rustling-yawning-snowflake.md` targets §6 are revised (see the phase 5
  wrap-up commit). The old targets stay in git history as context.
- `protocol/tools.ts` grows a small "behavior shapes" section —
  `ExecutionPhase` / `DataFingerprint` / `ToolFact` — which future tools
  utilities should extend rather than define locally.
- `protocol/events/hookTypes.ts` is now the single place where hook event
  shapes live. Adding a new hook event requires touching this one file plus
  a trigger method on `HookManager`.
