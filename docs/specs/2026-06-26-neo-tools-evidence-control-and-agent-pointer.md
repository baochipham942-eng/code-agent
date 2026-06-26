# Neo Tools Evidence Control and Agent Pointer

日期：2026-06-26

## Product Contract

This batch turns Neo's tool work from "the agent says it acted" into "the user can inspect what was acted on, what proof was collected, and how the run can be recovered or reviewed."

The contract is:

1. Completion claims carry verification evidence, not only model text.
2. Browser / Computer actions emit durable proof records and replayable proof timelines.
3. Agent mouse movement is visible in Browser and Computer surfaces through a Neo-styled virtual pointer.
4. Background tasks and subagents restored after restart expose recovery semantics instead of pretending the process is still live.
5. Agent tree / worktree review stays read-only and metadata-oriented until the user explicitly asks for merge or cleanup actions.

## As-Built Scope

| Area | As-built behavior | Main files |
|---|---|---|
| Evidence base | `EvidenceRef` is the shared proof unit for files, diffs, tests, CI, browser DOM/a11y, screenshots, computer AX, artifacts and traces. Domain objects extend it instead of defining separate proof bases. | `src/shared/contract/evidence.ts`, `docs/decisions/029-unified-evidence-provenance-contract.md` |
| Goal verification | Goal completion emits `VerificationEvidence` and a UI-friendly `GoalGateVerificationCard`; local command failures are attributed to test/lint/typecheck/build/env/dependency/timeout/unverifiable. | `src/main/agent/verification.ts`, `src/main/agent/runtime/goalCompletionGate.ts`, `src/shared/contract/agent.ts` |
| CI ingest | CI log text can be attributed into verification evidence with job/step/command/top error lines/candidate files. | `src/main/agent/verificationCi.ts` |
| Browser / Computer proof | Browser, Computer and Screenshot results attach `BrowserComputerProof`, proof timelines, visual-observation status, manual takeover classification and export-safe evidence refs. | `src/shared/utils/browserComputerRedaction.ts`, `src/shared/utils/browserComputerProofTimeline.ts`, `src/main/session/browserComputerProofStore.ts` |
| Agent pointer | Browser and Computer tool calls derive `AgentPointerEvent`; renderer surfaces show the latest pointer and history without requiring the user to infer where Neo clicked or typed. | `src/shared/utils/agentPointer.ts`, `src/renderer/components/workbench/AgentPointerOverlay.tsx`, `src/renderer/stores/agentPointerStore.ts`, `src/main/mcp/cuaAgentCursor.ts` |
| Replay / export | Structured replay, session export and trajectory export include browser/computer proof timelines and pointer events. | `src/main/evaluation/telemetryReplayEvidence.ts`, `src/main/evaluation/trajectory/trajectoryBuilder.ts`, `src/main/session/exportMarkdown.ts` |
| Evidence control summary | Session replay/sidebar surfaces aggregate verification, browser/computer, trajectory and background recovery items into one trust summary. | `src/main/session/evidenceControlSummary.ts`, `src/renderer/components/features/sidebar/SessionReplaySummaryDialog.tsx`, `src/renderer/components/features/sidebar/SidebarSessionItem.tsx` |
| Background recovery | Running shell/PTY/subagent records restored after restart include a recovery plan such as `running-recovered`, `dead-log-only`, or `interrupted-by-restart`. | `src/main/tasks/backgroundTaskRecoveryPlan.ts`, `src/main/tasks/backgroundTaskStore.ts`, `src/main/agent/spawnGuard.ts` |
| Browser launch split | Browser launch plumbing is split out of `BrowserService` so the service stays under the god-file guard while preserving system Chrome CDP and bundled Playwright fallback behavior. | `src/main/services/infra/browser/browserLaunchHelpers.ts`, `src/main/services/infra/browserService.ts` |

## Architecture

### Evidence flow

```text
tool execution / verification / browser-computer action
  -> EvidenceRef or domain proof object
  -> turn trace / proof store / trajectory builder
  -> replay, export markdown, UI proof cards
```

`EvidenceRef` is intentionally small. Freshness and redaction stay on the base proof object; domain-specific fields such as `targetRef`, `manualTakeover`, `visualObservation`, `agentPointerEvent` and `recoveryPlan` stay beside it.

### Browser / Computer pointer flow

```text
browser_action / computer_use / CUA MCP bridge
  -> buildAgentPointerEventFromToolCall()
  -> tool result metadata + workbench trace
  -> browserComputerProofStore / telemetry replay
  -> AgentPointerOverlay + proof timeline
```

The virtual pointer is a product signal, not a replacement for the OS cursor. It shows Neo's target and phase inside the app surfaces. It does not claim native system cursor ownership, and it does not auto-bypass login, MFA, CAPTCHA or payment-risk flows.

### Recovery flow

```text
persisted background task or subagent state
  -> recovery status classification
  -> recoveryPlan metadata
  -> TaskPanel / replay / export summary
```

Recovered state is explicit. A restored task can be reviewable without being live, and a previously running subagent can be marked `dead-log-only` with recommended actions instead of silently becoming "running".

## User-Facing Surfaces

| Surface | What users can see |
|---|---|
| Goal notice | verification card with command counts, required status and evidence refs |
| Tool result cards | Browser/Computer proof card, manual takeover reason, visual observation and safe next actions |
| Browser / Computer panels | subtle Neo pointer overlay and live pointer history |
| Session replay dialog | evidence control summary, proof timeline and trust gaps |
| Sidebar session item | compact evidence-control signal for completed or reviewable sessions |
| Markdown export | browser/computer proof timeline, evidence refs and recovery notes |

## Verification

Current branch verification before merge:

- `git diff --cached --check`
- `npm run typecheck`
- `npx vitest run tests/renderer/utils/agentPointer.test.ts tests/renderer/utils/agentPointerFrame.test.ts tests/renderer/stores/agentPointerStore.test.ts tests/renderer/components/agentPointerOverlay.test.tsx tests/unit/evaluation/trajectoryBuilder.agentPointer.test.ts tests/unit/session/exportMarkdown.browserComputer.test.ts tests/unit/tools/vision/browserWorkbenchGating.test.ts tests/unit/tools/vision/computerSurfaceGating.test.ts tests/unit/tools/vision/backgroundAxBridge.agentPointer.test.ts tests/unit/mcp/cuaAgentCursor.test.ts tests/unit/mcp/mcpToolRegistry.test.ts`
- In-app browser manual verification page: virtual pointer move/click observed, click counter incremented, pointer trail removed.

Post-merge validation:

- `npm run typecheck`
- `npx vitest run tests/unit/agent/runtime/goalCompletionGate.test.ts tests/unit/agent/spawnGuard.test.ts tests/unit/tasks/backgroundTaskSnapshotAdapters.test.ts tests/unit/session/exportMarkdown.browserComputer.test.ts tests/unit/tools/vision/browserWorkbenchGating.test.ts tests/unit/tools/vision/computerSurfaceGating.test.ts tests/unit/tools/vision/backgroundAxBridge.agentPointer.test.ts tests/unit/mcp/cuaAgentCursor.test.ts`

## Boundaries

- Remote browser pools, external Chrome profile attach, external CDP attach and extension bridge remain backlog.
- Browser / Computer proof is evidence and recovery context; it does not authorize unsafe continuation through login, MFA, CAPTCHA, payment or account-security flows.
- Agent pointer visibility is app-surface feedback. Native OS cursor capture/control still belongs to the existing Computer Surface / CUA paths.
- CI ingest is attribution from supplied log text; it does not fetch GitHub Actions logs by itself.
- Recovery plans describe restart state and recommended next actions; they do not relaunch background work automatically.
