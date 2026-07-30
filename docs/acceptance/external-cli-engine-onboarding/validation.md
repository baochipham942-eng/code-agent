# External CLI engine onboarding acceptance

Date: 2026-07-30
Branch: `codex/external-cli-engine-onboarding`
Runtime: production host + production renderer at `http://127.0.0.1:8192`

## Automated checks

- `npx vitest run ...`: 24 relevant files, 300 tests passed after the WorkBuddy adapter was enabled.
- `npx vitest run tests/renderer/components/modelOnboardingFunnel.test.tsx`: 5 tests passed after the final Anthropic-compatible copy correction.
- Scoped ESLint for the manifest, registry, IPC, onboarding, switcher, session-default integration, and their tests: passed.
- `npm run typecheck`: the WorkBuddy changes typecheck cleanly; the full command remains blocked by two pre-existing `clearHookRunning` errors in `useConversationStreamEffects.ts` against the user-owned `turnExecutionStore.ts` edit.
- `npm run build:renderer`: passed.
- The same production renderer was loaded in the in-app browser for the flow checks below.

## Runtime evidence

1. `01-onboarding-real-client-detection.png`
   - Codex CLI `0.146.0` was installed and its non-interactive login probe confirmed the official-client session.
   - Claude Code was installed but the safe auth probe reported that login was required.
   - Comate / Zulu was detected but remained non-selectable because its production adapter is not open.
   - At the time of this earlier screenshot, CodeBuddy Code and Cursor CLI were recommendations. WorkBuddy was promoted only after the live adapter gate recorded below passed.
2. `02-onboarding-real-codex-models.png`
   - The Codex model list came from the runtime catalog. No marketing entitlement or free-period label was injected.
3. `03-onboarding-anthropic-compatible.png`
   - The real onboarding component exposes an Anthropic-compatible endpoint, labels it as Anthropic Messages/models, and leaves submit disabled without a key.
   - No credential was entered or persisted during acceptance.
4. `04-onboarding-enters-real-chat.png`
   - Completing the second step closed onboarding and returned directly to the real conversation surface.
5. `05-session-engine-picker-8-sources.png`
   - The real `ModelSwitcher` renders eight manifest sources in a searchable, scrollable engine-first picker with uniform icon slots.
   - This screenshot predates the WorkBuddy production-adapter promotion and is retained as the before-state.
   - Clicking outside the popover removed both the engine and model panels from the DOM.
6. `06-session-codex-real-model-selected.png`
   - A real workspace session switched from Neo to Codex CLI, selected `gpt-5.6-terra`, persisted the label, exposed reasoning-depth controls, then switched back to Neo.
7. `07-session-workbuddy-real-client-selected.png`
   - The production renderer shows the WorkBuddy / CodeBuddy App-bundled CLI as installed, version `2.115.0`, and selected for the current session.
   - The real session trigger displays `WorkBuddy · 默认模型`; the settings row shows the App-bundled binary path and no hard-coded entitlement claim.
8. `10-onboarding-two-step-workbuddy.png`
   - The current production renderer exposes only `连接来源 → 默认模型`; there is no 日常工具 or intermediate 开始使用 step.
   - Official subscription and API Key are real tabs. Neo is excluded from the official-client group, while every external source shows its independent adapter/detection state.
   - Qoder Work 1.0.47 is detected from the App-bundled `qoderclicn`, displayed as `CLI 未登录 · 生产 Adapter 未开放`, and remains non-selectable.
9. `09-session-workbuddy-model-popup.png`
   - The real `ChatView` model popover states that the official client owns model selection because WorkBuddy 2.115.0 did not return a trustworthy enumerable catalog.
   - Fixture-only GLM/Kimi entries and the unverified HY model are not presented as live capabilities.
10. `08-session-workbuddy-live-conversation.png`
    - The production host selected WorkBuddy with no synthetic model ID and persisted the exact reply nonce `NEO_WORKBUDDY_DEFAULT_20260730_001`.

`scripts/acceptance/workbuddy-engine-live-smoke.ts` started the production `dist/web/webServer.cjs`, created an isolated real session, selected `codebuddy_code / read_only / client_default`, sent nonce `NEO_WORKBUDDY_DEFAULT_20260730_001`, and received the exact nonce in both SSE and the persisted assistant message. The model remains client-managed because the installed CLI does not provide a trustworthy model enumeration contract.

The Web runtime did not have its optional directory bridge, so the isolated acceptance project was created through the product's authenticated project/session domain routes. Engine and model changes themselves were performed through the rendered product UI and its production session validation path.

## Evidence boundaries

### Verified on this machine

- Generic manifest probe and fail-closed source classification.
- Codex CLI installation, version, official login status, runtime model catalog, engine selection, and model selection.
- Claude Code installed / login-required classification.
- Comate / Zulu detected / adapter-blocked classification.
- WorkBuddy App-bundled CLI discovery, version, official-client state marker, engine selection, stream-json transport, and persisted assistant reply.
- Qoder Work App-bundled CLI discovery, version, login probe, and fail-closed source presentation.
- Cursor CLI remains recommendation-only.
- Two-step onboarding, direct entry to chat, eight-source search/scroll, Neo/Codex switching, and outside-click close.

### Fixture-backed only

- Anthropic-compatible connection, model discovery, and save payload, because acceptance did not receive or request a new API key.
- Other CLIs' `client_default` rendering when they cannot safely enumerate models.
- MiMo-Code and Kimi Code authentication. Their installed binaries were visible to the probe, but no safe non-interactive auth proof was available, so the product kept them non-selectable.
- Qoder Work execution, event normalization, and model enumeration. The installed 1.0.47 CLI exposes the required flags, but both `status` and a real non-interactive request confirmed that its CLI login is absent; no request reached a model.

A real WorkBuddy subscription call was invoked for the live nonce smoke. Neo passed only `CODEBUDDY_CONFIG_DIR`, never copied, displayed, or persisted the official login credential, and forced plan mode with all built-in tools disabled.
