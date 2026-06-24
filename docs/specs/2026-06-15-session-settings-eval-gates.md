# 2026-06-13~15 Session Surface / Settings IA / Eval Gates Spec

> Status: as-built on `main`
> Time window: 2026-06-13 00:00 through 2026-06-15 00:34 CST
> Evidence range: `b9498fd0a` through `7ae5246a3`
> Related architecture: [ARCHITECTURE.md](../ARCHITECTURE.md), [frontend.md](../architecture/frontend.md), [workbench.md](../architecture/workbench.md)

This batch turns the Alma comparison work and the 2026-06-13 reliability work into product contracts. The main movement is not a new runtime engine. It is the tightening of three surfaces:

1. the session page as the place where model strategy, memory quality, media, voice and capability selection are visible;
2. settings as grouped navigation for model strategy, voice, hotkeys, privacy, plugins, MCP, channels and memory;
3. eval and CI gates as mechanical evidence checks for capabilities that claim to be complete.

2026-06-24 update: Agent Trajectory P3 extends the eval gate surface from "a runnable smoke exists" to "a reviewed live dataset slice exists." The as-built closeout uses a fresh post-P2 live window, exports only `collection.source = manual_review` rows, and treats `core_eval` JSONL as publishable only after Review Queue decisions have been persisted.

## Product Contract

| Area | Contract |
|------|----------|
| Evidence gates | Capability completion now has a code-level evidence gate. A claimed capability must have real deliverables, implementation markers where needed, and a runnable evidence entry. Judge quality is calibrated against deterministic or human gold labels before being treated as trustworthy. |
| Agent trajectory dataset | A trajectory dataset row represents one complete session, not one API call. `core_eval` export requires telemetry-backed replay, model provenance, tool definition, tool args, paired tool result and final assistant answer. Draft machine classifications stay `audit_backfill`; final JSONL export is restricted to rows saved as `manual_review`. |
| Agent trajectory review | P3 review is an explicit data-ops loop: seed or collect candidate sessions, generate worksheet/dossier/review packet, apply only explicit reviewer decisions, then rerun `post-review-check` and strict `live-closeout`. Blank review fields must not create `manual_review` metadata. |
| Session quality | Each turn can carry a `TurnQualitySummary` with strategy, memory, capability, tooling and delivery scores. The chat surface renders a compact quality strip, and replay audit can inspect the same evidence after the fact. |
| Model strategy | Settings define task profiles (`fast`, `main`, `deep`, `vision`), fallback policy and strategy rules. Runtime model decisions expose task class, cost policy, speed policy, provider health, fallback trace and tool-token diagnostics so the session page can explain why a model was chosen. |
| Composer | The composer keeps high-frequency controls close to the input: Skills/MCP scope, Auto/Manual routing, agent selection, session memory, model strategy recommendation feedback, voice input, `/goal` contract creation, skill/capability suggestions, appshot chips, prompt commands and agent mentions. Live Preview stays in session actions. |
| Voice input | Voice capture is a first-class composer path. It loads speech settings, supports local/cloud modes, duration and silence state, shortcut toggling, retry, and microphone permission recovery through the native settings link. |
| Hotkeys | User-configurable hotkeys have shared definitions, platform defaults, conflict detection, system warning detection, a settings tab and renderer change events. Global hotkeys can be disabled without deleting per-action bindings. |
| Media and artifacts | Chat messages can show media assets and attachments with richer controls, including session media asset display, artifact delivery lifecycle status and lightbox/browser behavior. |
| Settings IA | Settings tabs are grouped by stable registry ids: basics, connections, workspace, management, memory and system. Search uses the same registry and respects access control. Admin-only tabs are hidden in the UI and still guarded by backend access checks. |
| Privacy and channels | Permission boundary copy, channel privacy strategy, notification policy, credential inventory and Browser Relay risk surfaces are collected under settings instead of being scattered across channel-specific panels. |
| Skills, MCP and plugins | Skills, MCP, plugins and capability inventory now have visible settings surfaces, search/index entries and registry-backed audit concepts. Session-side recommendations can mount installed skills or install from recommended repositories. |
| Project/session organization | Workspace preview, sidebar project grouping, project/session metadata, session search jump and session asset navigation now make project context and session context separate but navigable surfaces. |

## Architecture Map

| Layer | Files / Modules | Notes |
|------|------------------|-------|
| Capability evidence | `scripts/check-capability-evidence.ts`, `src/main/testing/ci/*`, `src/main/testing/calibration/judgeCalibration.ts`, `tests/unit/testing/*` | CI no longer relies only on typecheck/test green. It asserts that specific capabilities still have real implementation and repeatable evidence. |
| Agent trajectory gate/export | `src/shared/contract/agentTrajectory.ts`, `src/main/evaluation/trajectory/trajectoryExporter.ts`, `scripts/export-agent-trajectories.ts`, `scripts/agent-trajectory-p3-acceptance.ts` | The shared contract assigns G0/G1/G2 quality, task kind, dataset role and collection metadata. The exporter builds session-level JSONL, segmentation, trend buckets and P3 closeout evidence. |
| Agent trajectory data ops | `scripts/collect-agent-trajectory-sample.ts`, `scripts/agent-trajectory-review-status.ts`, `scripts/agent-trajectory-review-dossier.ts`, `scripts/apply-agent-trajectory-review.ts`, `docs/guides/agent-trajectory-data-ops.md` | Live collection/apply commands require DB backup, keep generated scratch data outside Application Support, and separate draft `audit_backfill` rows from final `manual_review` export rows. |
| Trajectory review UI | `SessionReplaySummaryDialog.tsx`, `Sidebar.tsx`, `SidebarSessionItem.tsx`, `useSidebarDerivedSessions.ts`, `sessionUIStore.ts`, `src/shared/contract/agentTrajectory.ts` | Sidebar and Replay expose pending trajectory review rows and persist dataset role decisions through the same collection metadata contract used by batch review. |
| Runtime model decision | `src/main/model/modelDecision.ts`, `modelRouter.ts`, `agent/runtime/contextAssembly/inference.ts`, `shared/contract/modelDecision.ts` | Model routing is a structured decision payload that can be displayed, replayed and scored. |
| Turn quality | `src/main/agent/runtime/turnQuality.ts`, `src/main/evaluation/sessionQualityScoring.ts`, `src/shared/contract/turnQuality.ts`, `TurnQualityStrip.tsx`, `ReplayAuditPanel.tsx` | The same summary feeds live chat and replay audit, avoiding two independent scoring stories. |
| Composer surface | `ChatInput/index.tsx`, `InlineWorkbenchBar.tsx`, `VoiceInputButton.tsx`, `ModelStrategyRecommendationStrip.tsx`, `GoalComposerCard.tsx`, `CapabilitySuggestionStrip.tsx`, `SessionActionsMenu.tsx` | ChatInput owns the immediate action surface; side panels and session actions remain for deeper inspection and lower-frequency controls. |
| Settings registry | `src/renderer/utils/settingsTabs.ts`, `settingsIndex.ts`, `SettingsModal.tsx`, `SettingsLayout.tsx` | Tab ids, grouping, access control and search all flow through shared registry helpers. |
| Model settings | `ModelSettings.tsx`, `TaskStrategySettingsPanel.tsx`, `shared/contract/settings.ts`, `configService.ts` | Task profiles and fallback policy live in settings, then become runtime routing inputs. |
| Hotkeys | `src/shared/keybindings/*`, `KeybindingsSettings.tsx`, `useKeyboardShortcuts.ts`, `globalShortcuts.ts` | Shared definitions keep settings UI, renderer shortcuts and platform bindings aligned. |
| Voice | `VoiceInputButton.tsx`, `useVoiceInput.ts`, `voicePaste.ipc.ts`, `speech.ipc.ts`, `shared/contract/speech.ts` | The composer only renders the button when capability and user settings allow it. |
| Media/session assets | `shared/utils/sessionMediaAssets.ts`, `MessageBubble/*`, `FileArtifactCard.tsx`, `MediaAssetControls.tsx`, `SessionActionsMenu.tsx` | Session-level generated media and file artifacts can be found from chat and session actions. |
| Privacy/channels | `permissionBoundary.ts`, `privacyBoundaryIndex.ts`, `ChannelsSettings.tsx`, `PrivacySettings.tsx`, `channelPrivacyFirewall.ts`, `platform/notifications.ts` | The UI explains data boundaries; main process services enforce channel and notification behavior. |
| Project/session organization | `projectService.ts`, `ProjectRepository.ts`, `WorkspacePreviewPanel.tsx`, `SidebarProjectDrawer.tsx`, `workspacePreview.ts` | Projects group goals, sessions and artifacts without collapsing session identity. |

## Verification Evidence

The commit window includes targeted coverage for the changed surfaces:

| Scope | Evidence |
|------|----------|
| Evidence gate | `tests/scripts/checkCapabilityEvidence.test.ts`, `tests/unit/testing/judgeCalibration.test.ts`, `tests/unit/testing/ci.mode.test.ts` |
| Agent trajectory gate/export | `tests/unit/evaluation/trajectory/agentTrajectoryGate.test.ts`, `tests/unit/evaluation/trajectory/applyAgentTrajectoryReview.test.ts`, `npm run trajectory:review-status -- --since=2026-06-24T20:27:00+08:00`, `npm run trajectory:live-closeout -- --since=2026-06-24T20:27:00+08:00` |
| Agent trajectory P3 dataset | `docs/audits/agent-trajectory-live-closeout-latest.md`, `docs/audits/agent-trajectory-p3-acceptance-latest.md`, `eval-datasets/agent-trajectory/core-eval.jsonl` |
| Runtime and scoring | `tests/unit/agent/turnQuality.test.ts`, `tests/unit/evaluation/sessionQualityScoring.test.ts`, `tests/unit/evaluation/transcriptReplayBuilder.test.ts`, `tests/unit/model/modelDecision.test.ts` |
| Composer | `tests/renderer/components/voiceInputButton.test.tsx`, `tests/renderer/components/voiceInputButton.privacy.test.tsx`, `tests/renderer/components/goalComposerCard.test.tsx`, `tests/renderer/components/capabilitySuggestionStrip.test.ts`, `tests/renderer/components/chatInput.modelStrategyRecommendation*.test.*` |
| Settings | `tests/renderer/utils/settingsIndex.test.ts`, `tests/renderer/components/modelSettings.management.test.ts`, `tests/renderer/components/taskStrategySettingsPanel.test.tsx`, `tests/renderer/components/privacySettings.boundaryCopy.test.tsx`, `tests/renderer/components/pluginsSettings.test.ts`, `tests/renderer/components/channelsSettings.management.test.ts`, `tests/renderer/components/mcpSettings.status.test.ts` |
| Hotkeys | `tests/unit/shared/keybindings/keybindings.test.ts` |
| Media/session assets | `tests/unit/shared/sessionMediaAssets.test.ts`, `tests/renderer/components/mediaAssetRendering.test.tsx`, `tests/renderer/components/mediaAssetLightbox.browser.test.ts`, `tests/unit/renderer/sessionAssetsNavigation.test.ts` |
| Project/session organization | `tests/unit/renderer/workspaceGrouping.test.ts`, `tests/renderer/utils/workspacePreview.test.ts`, `tests/renderer/components/sidebarProjectDrawer.test.tsx`, `tests/unit/renderer/sessionSearchJump.test.ts` |

## Boundaries

- Alma research docs under `docs/research/` are source material, not product contract. This spec records only the parts that landed in product code.
- Turn quality is a diagnostic and review surface. It should not block ordinary user turns unless a separate gate explicitly consumes it.
- Agent Trajectory P3 closeout proves the controlled fresh live sample. Historical mixed-window diagnostic/excluded rows remain useful for capture-quality debugging, but they are not part of the final P3 `core_eval` slice.
- Agent trajectory `manual_review` can be written by Replay UI or the reviewed worksheet apply path. Machine-generated `audit_backfill` classifications are never enough for final JSONL export.
- Task model strategy controls the app's routing policy; it does not guarantee a provider will honor availability, quota or saved-token accounting.
- Voice input remains user-initiated. Opening settings or the composer does not request microphone permission.
- Hotkeys are settings-backed and conflict-aware, but system-reserved combinations can still be blocked by the OS.
- Settings UI access control is convenience and clarity. Admin operations, plugin visibility and control-plane mutations still need backend guard checks.
