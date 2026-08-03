# Neo Onboarding Before / After Design QA

final result: passed

## Review target

- prototype: `docs/research/2026-07-30-external-cli-engine-onboarding-before-after.html`
- previous conversation source: `docs/acceptance/mock-guard/external-cli-engine-onboarding-current/correction3-implementation-conversation.png`
- corrected model page: `docs/acceptance/mock-guard/external-cli-engine-onboarding-current/correction4-model.png`
- corrected conversation menu: `docs/acceptance/mock-guard/external-cli-engine-onboarding-current/correction4-conversation-menu.png`
- execution-engine switch menu: `docs/acceptance/mock-guard/external-cli-engine-onboarding-current/correction5-engine-switch.png`
- seven-engine picker: `docs/acceptance/mock-guard/external-cli-engine-onboarding-current/correction6-seven-engine-picker.png`
- complete model menu: `docs/acceptance/mock-guard/external-cli-engine-onboarding-current/correction7-complete-model-menu.png`
- Neo engine settings view: `docs/acceptance/mock-guard/external-cli-engine-onboarding-current/correction8-neo-engine-settings.png`
- all engine icons fill: `docs/acceptance/mock-guard/external-cli-engine-onboarding-current/correction14-all-engine-icons-fill.png`
- tested states: model confirmation, direct conversation entry, WorkBuddy runtime model menu, in-session model switch
- tested viewports: 1280 × 900 and 419 × 783 CSS pixels in the in-app browser
- theme: Agent Neo dark

## Findings and fixes

- P1, fixed: the model confirmation previously opened a separate “准备好了，开始第一轮对话” screen. Onboarding now has two steps only; `继续开始` opens the current Neo conversation directly.
- P1, fixed: the conversation surface was a standalone chat mock. It now mirrors the repository’s actual `ChatView → NewSessionWelcome → ChatInput → ModelSwitcher` composition: the real empty-session copy and suggestion grid, 768px composer column, composer toolbar order, and model trigger position.
- P1, fixed: the earlier model menu invented a two-column source/model browser. The revised menu keeps the current 352px single-column `ModelSwitcher` shape. The active session source is read-only metadata and only that source’s runtime models are selectable.
- P1, fixed: horizontal engine chips did not scale beyond two or three options. The menu now shows one compact current-engine row; clicking it opens a searchable second-level list that comfortably supports seven or more engines.
- P1, fixed: adding the engine layer had displaced existing ModelSwitcher controls. The model view again includes model search, adaptive `自动`, price/status rows, and the four-level reasoning control.
- P2, fixed: CLI marks previously looked like authoritative vendor logos even though they were generic Lucide symbols. The mock now labels them as placeholders; production uses packaged, validated Manifest assets with a generic terminal fallback.
- P1, fixed: Neo itself was missing from the execution-engine layer. The picker now includes Neo as the built-in engine; selecting it shows Neo-managed Provider models and a top-right `去设置` action.
- P1, fixed: external-client selection remains honest. `runtime_catalog` renders returned models and prices; `client_default` states that the official client owns model choice without inventing a catalog.
- P2, fixed: legacy `stage=tools` and `stage=start` links now resolve to the conversation instead of reviving the removed onboarding step.

## Repository grounding

- `src/renderer/components/ChatView.tsx` renders `NewSessionWelcome` for an empty conversation and keeps `ChatInput` mounted at the bottom.
- `src/renderer/components/features/chat/NewSessionWelcome.tsx` defines the 768px welcome column, four suggestion cards, and current welcome copy.
- `src/renderer/components/features/chat/ChatInput/index.tsx` places `+`, agent, permission, context, model, voice, and send controls in the composer toolbar.
- `src/renderer/components/StatusBar/ModelSwitcher.tsx` uses a 352px menu, `主任务模型` title, single-column model rows, and the composer trigger. The proposed WorkBuddy behavior is an iteration of this component, not a separate conversation UI.
- Current production code sends an external-engine trigger to Agent Engine settings. The prototype intentionally shows the next iteration: when a selected engine exposes a trusted runtime catalog, the same trigger opens that engine-scoped catalog.

## Interaction evidence

- The model page stepper contains exactly `连接方式` and `默认模型`.
- Clicking `继续开始` changes the URL directly from `stage=model` to `stage=conversation`; no intermediate completion or first-message screen appears.
- The conversation empty state exposes the current Neo copy `想完成什么？` and the current composer placeholder.
- Clicking `WorkBuddy · Hy3` opens one `.runtime-model-menu` at the composer’s existing model-control position.
- The default menu shows only the current execution engine and its models, keeping the normal model-switching path short.
- The existing model search, adaptive Auto row, price/status information, and reasoning-strength controls remain in the default model view.
- Opening the execution-engine row shows Neo plus seven external engines in a scrollable, searchable list.
- The engine picker includes Neo plus the external CLI engines. Neo uses the repository’s real local brand asset.
- `去设置` appears only on Neo’s model view and routes conceptually to Provider/model settings; external engines do not inherit this Neo-specific action.
- Switching to CodeBuddy automatically returns to the model view, changes the trigger to `CodeBuddy Code · 自动选模`, and shows the honest `client_default` state without model rows.
- Switching back to WorkBuddy restores its runtime model catalog.
- Choosing `GLM-5.2` closes the menu, updates the trigger to `WorkBuddy · GLM-5.2`, and persists `model=glm-5-2` in the URL.

## Responsive evidence

- At 419 × 783, the conversation state has one model menu and no horizontal document overflow.
- The narrow layout collapses suggestion cards to one column and keeps the model menu within the composer width.
- The engine picker keeps all eight rows inside its own scroll area and reports no horizontal document overflow.

## Gates

- Inline JavaScript parse check: passed.
- Local HTTP response: 200.
- Browser interaction regression: passed for two-step onboarding, direct conversation entry, model-menu open, and in-session model switch.
- Seven-engine regression: passed for picker open/back state, search filtering to one result, engine selection, automatic return to the model view, and URL persistence.
- Neo regression: passed for built-in engine selection, Neo model rendering, eight-engine picker count, top-right settings action, toast target, and URL persistence.
- Icon alignment regression: every row uses a 32 × 32 slot centered against the two-line copy; both the real Neo App icon and every placeholder glyph fill the slot. Measured slot/copy center delta is `0px`.
- Dismissal regression: clicking inside the model menu keeps it open; clicking the conversation canvas removes the menu and clears both `modelMenu` and `enginePicker` URL state.
- Desktop and narrow visual review: passed.
- Incremental guard: passed with no frozen-file, protected-selector, or forbidden-target violation.
- Visual comparison against the previous conversation mock: passed at the intentional-change budget, `diffRatio = 0.260464`.

## Remaining implementation boundary

- Production implementation should extend `ModelSwitcher` with a generic engine-scoped catalog contract. It should not add WorkBuddy-specific UI branches.
- The engine descriptor must distinguish `runtime_catalog`, `client_default`, and unavailable states; model rows and entitlement labels remain probe data.
- External engines without a validated catalog continue opening Agent Engine settings.
