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
| circular deps (main)| 4                     | 4           | ±0      |

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
- `tools/modules/` cross-subdir imports: baseline 75, goal ≤ 60
  (targets the glue-layer coupling specifically).
- Dynamic `require()` calls to cross-module runtime:
  baseline 4 (agentOrchestrator already fixed, still 3 others).
  Each one is a hidden dep that madge can't see.
- Circular deps: baseline 4, goal still 4 — all inside `agent/hybrid/*` +
  `ipc/swarm.ipc.ts` + `agent/subagentExecutor.ts`. They need an Actor-model
  refactor, not more protocol/.

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
