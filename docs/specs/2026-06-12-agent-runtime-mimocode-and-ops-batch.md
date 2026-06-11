# 2026-06-12 Agent Runtime / MiMoCode / Ops Batch

> Status: as-built through 2026-06-12 local main and pending worktree merge.
> Scope: commits after `v0.16.103` plus the current uncommitted Admin / MCP / renderer hot-update / UI diagnostics diff.

This batch folds two days of work into the product contract: Windows support had already been closed in v9.22, and the following day moved into agent reliability, MiMoCode-inspired runtime improvements, multi-agent nesting, memory/dream learning loops, and operator surfaces.

## Product Contract

| Area | Contract |
|------|----------|
| Runtime safety | Agent runs now have explicit doom-loop guards, task completion gates, max-step fallback summaries, retry classification, abortable retry sleep, context-overflow no-retry handling, and generic provider failures rendered as user-actionable messages. |
| Edit robustness | MultiEdit gained a staged replacer chain: line-trimmed fallback, block-anchor matching, and indentation-flexible matching, with follow-up hardening against partial block corruption and ambiguous `replace_all`. |
| Prompt and provider behavior | The main prompt carries completion requirements for everyday runs, provider-family variants can specialize behavior, and A/B prompt tests can compare variant output without changing default routing. |
| Memory and history | Transcript FTS indexes tool input/output, user text, assistant text, and reasoning by kind; the History tool becomes discoverable through deferred tools; local memory packing uses SQLite FTS/BM25 as a recall channel. |
| Dream learning loop | Dream consolidation is gated by transcript evidence, can run on schedule, and treats memory as a cache over source-of-truth session traces rather than as unchecked model invention. |
| Commands | Slash command assets now have a registry, frontmatter metadata, template arguments, file-defined custom commands, and MCP prompt ingestion. |
| Methodology skills | The superpowers-style development methods are bundled as built-in skills, filling the process-method gap alongside task-oriented skills. |
| Multi-agent nesting | Subagents can delegate to nested subagents up to configured depth, with hard depth caps, tree-wide quota, timeout and token budget propagation, subtree cancellation, orphan reclamation, and distilled child output. |
| Max Mode | Best-of-N runs in propose-only mode, judges candidates, then replays the winner for real execution. Candidate/judge overhead is accounted separately; cancellation and judge parsing have explicit safety handling. |
| CUA governance | Computer-use now has a cross-session file lock, trajectory soft-stop budget, failure classification stats, and CUA driver registration fixes across CLI and desktop. |
| MCP operations | MCP management is self-service for normal signed-in users, while low-level bridge diagnostics remain admin-only. `mcp_add_server` and `MCPUnified.add_server` accept HTTP Streamable MCP servers, `url` aliases, and remote headers. Explicit MCP management requests preload `MCPUnified`. |
| Admin operations | Admins can grant or revoke another user's admin role from the dashboard through a `SECURITY DEFINER` Supabase RPC. A user cannot revoke their own admin role. Shared relay entitlement management remains in the same admin surface. |
| Renderer hot-update safety | The web static router refuses to serve an active renderer bundle whose version is older than the current shell version, falling back to the built-in renderer to prevent stale UI from masking shell fixes. |
| Diagnostics UX | Session diagnostics export failures time out instead of hanging, then open or point to the runtime logs directory so support can get the real app logs. |

## Architecture Map

| Layer | Files / Modules | Notes |
|------|------------------|-------|
| Agent runtime | `doomLoopGuard.ts`, `goalCompletionGate.ts`, `maxStepsFallback.ts`, `retryStrategy.ts`, `messageProcessor.ts`, `runtime/contextAssembly/*` | Runtime safety is now a set of explicit gates and helpers rather than a single prompt expectation. |
| Context and memory | `transcriptHistoryService.ts`, `transcriptFts.sql.ts`, `MemoryRepository.ts`, `dreamMemoryService.ts`, `dreamScheduler.ts` | History search, BM25 memory packing, and dream consolidation share the same "trace first" stance. |
| Tools and commands | `promptCommandService.ts`, `promptCommands.ts`, `deferredToolPreload.ts`, `mcpAddServer.ts`, `mcpUnified.schema.ts` | Deferred visibility now includes intent-triggered tools such as History and MCP management. |
| Multi-agent | `spawnGuard.ts`, `subagentPipeline.ts`, `subagentUsageAccounting.ts`, `subagentExecutorCancellation.ts`, `orphanLiveness.ts`, `parallelAgentCoordinator.ts` | The spawn tree owns quota and liveness, not each individual level. |
| Ops/admin | `adminService.ts`, `admin.ipc.ts`, `UserDashboardSettings.tsx`, `20260611000000_admin_set_user_admin.sql` | Admin role toggling is an RPC-backed privileged action, not direct client table mutation. |
| Renderer delivery | `rendererBundleCache.ts`, `static.ts`, `webServer.ts`, `UpdateSettings.tsx`, `Sidebar.tsx` | Delivery safety covers both bundle selection and support diagnostics. |

## Verification Evidence

The implementation history includes targeted unit suites for the changed surfaces:

- MiMoCode phase one audit: 4 Codex audit rounds, then an independent two-round review; phase one fixes were verified with typecheck and agent/tools/model suites.
- Nested subagent: 23 test files / 306 tests passed, followed by `npm run build:web` and an in-app browser live run proving root -> child -> grandchild output propagation.
- Max Mode: `runtime/maxMode` and `inference.maxMode` suites converged after 3 audit rounds; the subset eval showed no score lift on easy cases and a clear 9.1x cost ratio, so the feature remains an explicit mode.
- Current pending diff adds tests for Admin IPC/RPC, MCP HTTP Streamable add-server, MCP self-service settings, renderer bundle stale fallback, diagnostics fallback, and provider failure copy.

## Boundaries

- Max Mode is off by default and should be used for hard cases where best-of-N may justify cost.
- Nested subagent support is for context offload and recursive investigation, not a way to multiply parallelism without limits.
- MCP self-service does not expose LocalBridge / native connector diagnostics to normal users.
- Renderer hot-update fallback only compares active bundle version against shell version; it does not prove the remote latest bundle has been published.
- Dream consolidation may schedule automatically, but source-trace verification remains required before writing durable memory.
