# Changelog

All notable changes to Code Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.26.3] - 2026-07-12

### Fixed

- **v0.26.2 发布恢复**：补齐 fresh Stability Stop/Recovery smoke，并让 app-host smoke 使用隔离数据目录，避免读取真实用户 MCP 配置造成资源竞争；本版本承接 `v0.26.2` 已推 tag 但被 evidence freshness gate 阻断的发布现场。
- **fresh-profile 首次启动超时**：远程 plugin、skill 和 MCP capability 初始化移出 HTTP listener 与首窗导航关键路径；Durable recovery 在 capability 就绪后继续并保持 fail-closed。

### Changed

- **更新 metadata 权威源收敛**：`/api/update` 只读 GitHub Release 与 OSS stable manifests，不再保留无持久化效果的 Cloud publish 兼容入口。
- **仓库结构与设计契约**：补齐代码、脚本、测试和 workflow 导航边界，增加 repository-structure gate 与根目录 `DESIGN.md`。

## [0.26.2] - 2026-07-12

### Changed

- **更新 metadata 权威源收敛**：`/api/update` 只读 GitHub Release 与 OSS stable manifests，不再保留无持久化效果的 Cloud publish 兼容入口；发布后验证会拒绝非权威 metadata source。
- **仓库结构与设计契约**：补齐 Agent、脚本、测试和 workflow 导航边界，增加自动 repository-structure gate，并建立根目录 `DESIGN.md` 作为 Agent Neo 产品设计契约。

### Fixed

- **fresh-profile 首次启动超时**：远程 plugin、skill 和 MCP capability 初始化移出 HTTP listener 与首窗导航关键路径；桌面壳可先完成健康检查和窗口导航，Durable recovery 在 capability 就绪后继续并保持 fail-closed。

## [0.26.1] - 2026-07-12

### Fixed

- **正式发布的 renderer 热更新一致性**：相同源码现在生成确定性的 renderer bundle；同一发布通道的 OSS writer 串行执行，并以 manifest 作为最后写入的完成标志，避免 main 与 tag 两条 workflow 竞争时混合不同 bundle hash。
- **v0.26.0 发布恢复**：此版本承接 `v0.26.0` 已推 tag 但未创建 GitHub Release 的失败现场，不覆盖或重发原 tag。

## [0.26.0] - 2026-07-12

### Added

- **Durable Run Kernel 与进程级恢复**：核心运行状态、owner fencing、checkpoint 和恢复分发进入统一持久化内核；应用重启后可以按可证明的副作用状态继续、观察或转人工复核。
- **统一多 Agent 执行协议**：Agent Team、Auto Agent、Multiagent 与动态工作流共享执行端口、身份关联和恢复语义，减少不同编排入口在崩溃恢复时的行为分叉。
- **外部 CLI durable lifecycle**：Codex、Claude 等外部 CLI 运行记录可持久化 provider operation、恢复证据和 resume 参数；证据不足时保持人工复核边界，不盲目重放。
- **MCP durable task 与可信工具缓存**：支持可查询的异步 MCP task、结果文件存储和 proven tool cache；只在结果身份、工具能力与允许范围可证明时复用。
- **Unified Graph Runner**：任务 DAG、动态工作流、外部引擎和子 Agent 统一接入 Graph Runner，并通过集中的 GraphEvent compatibility sink 兼容既有消费者。
- **OTel run trace**：run、operation、tool 与恢复链路传播统一 trace context，便于定位跨进程和跨执行器问题。

### Changed

- **启动恢复与生产读路径切换**：应用启动期会恢复可安全接管的 durable run，生产查询优先读取 durable 状态，并保留受控回退与 rollback round-trip 验证。
- **恢复策略更保守**：未知写副作用、外部 CLI resume 证据缺失、工作区或模型工具漂移等场景会进入 `requires_review`，避免重复执行。

### Fixed

- **symlink 越界写入防护**：文件、目录及尚不存在目标经过 symlink 指向工作区外时统一要求确认，避免路径表象绕过权限边界。
- **double ESC cancel 去重**：同步取消标记在请求传播前立即生效，连续 ESC 不会重复触发 cancel fan-out。

## [0.25.1] - 2026-07-11

### Changed

- **生产控制面更抗瞬时故障**：Supabase 依赖增加超时、缓存、陈旧数据回退与断路保护；未认证请求不再为共享密钥额外访问数据库，继续保持 fail-closed。
- **运行目录口径统一**：文档与运行时约定统一到 `~/.code-agent/code-agent.db`，避免排障时误查旧的 macOS Application Support 路径。

### Fixed

- **登录失败提示与会话信任**：认证错误可以从嵌套响应中提取可行动原因；本地退出窗口被显式识别，不会把正常退出误报成会话过期。
- **控制面降级路径**：缓存、采样和断路状态在依赖失败时确定性收敛，避免瞬时 Supabase 故障放大为连续请求失败。
- **远程 MCP 联网稳定性**：Context7、Exa 与 Tavily 连接遇到瞬时网络失败时会做一次有界重试并在重试时使用已配置代理；Tavily 统一使用 Bearer 认证，Exa 显式请求搜索与抓取工具，兼容旧控制面配置。

## [0.25.0] - 2026-07-11

### Added

- **连续共驾指针与系统光晕**：Computer Use 执行时，面板内光标连续跟随；原生桌面任务可显示穿透式系统光晕，并支持多显示器、负坐标与混合缩放。
- **Provider × Runtime 能力证据矩阵**：新增能力矩阵、请求形状 fixture、脱敏 live smoke ledger 与 release blocker，发版不再只靠声明判断渠道是否可用。
- **长会话稳定性金标**：新增历史加载、滚动锚点、持续流式输出、停止收敛和恢复路径的结构化基线与回归门。

### Changed

- **运行隔离继续收紧**：Native Run、工具状态、Agent Team 生命周期和流式快照按 Session / Run 绑定，旧 owner 不能覆盖或清理新 owner。
- **权限与脚手架分档**：新增只读探索档位，并根据模型能力选择更合适的修复脚手架密度；高密度 compact 指令仍由开关控制。
- **评测与发布治理**：compare 实验臂、工具完整性判定、文案门、自动化任务护栏和发布证据门进入持续验证链路。

### Fixed

- **长会话加载历史不再跳视口**：向上加载历史消息时保留当前阅读位置，搜索和流式跟随使用独立证据判定。
- **共驾指针所有权与终态**：外部 Session 不能改变当前光晕，失败显示可重试，终态、卸载和 `end_session` 会确定性隐藏并清理定时器。
- **原生光晕生命周期**：WebView 只创建一次并安全复用，加载代际、隐藏状态和显示器切换不会被旧 worker 或迟到事件污染。

## [0.24.4] - 2026-07-09

### Added

- **Agent engine model discovery**: Codex and Claude engine model catalogs can now be refreshed from local CLI discovery before falling back to bundled catalog data, including newer Claude aliases such as Fable and Haiku.

### Changed

- **Model settings UX**: the model provider settings page now gives the add-provider action a clearer place, explains execution-engine defaults in settings, and removes execution-engine model configuration from the main model switcher.

### Fixed

- **Local/Ollama ghost models**: Local models are no longer shown in the chat model switcher just because the provider entry is enabled. The switcher now requires a current local discovery signal, so uninstalling Ollama or its models hides the stale Local group.
- **Cloud config refresh coalescing**: concurrent cloud configuration refreshes are coalesced to avoid duplicate work and noisy renderer bundle telemetry parsing.

## [0.24.3] - 2026-07-08

### Fixed

- **Claude Code 登录态继承**: Claude Code engine now launches in safe mode while preserving the user's existing Claude CLI auth/session environment, so an already logged-in local CLI is no longer misreported as needing `/login`.
- **Model parameter compatibility**: `gpt-5.5` / `gpt-5.5-pro` requests now use the only supported default temperature `1` across AI SDK and OpenAI-compatible fallback paths. The model settings temperature control is locked with an explanatory hint for these models.
- **Model routing error readability**: raw Azure/LiteLLM temperature and missing-fallback messages are classified as model configuration failures with actionable guidance, while full provider internals stay in logs.

### Changed

- **macOS DMG Finder polish**: future release DMGs keep the standard drag-to-Applications install layout while also setting a cleaner Finder icon-view window, icon size, and app/Applications icon positions.

## [0.24.2] - 2026-07-08

### Fixed

- **macOS DMG install flow**: the release DMG now opens as an installer-style volume named `Install Agent Neo`, with `Agent Neo.app` and an `/Applications` shortcut at the root so users drag the app into Applications instead of running it from the mounted disk image. The macOS release verifier now mounts every DMG and fails if that install layout is missing.
- **Packaged relaunch after force-quit**: packaged launches clear stale `webServer` processes holding the desktop port before spawning the bundled server, and the Node server also clears the port before service initialization. This prevents a killed shell from leaving an old backend that makes the next launch look broken.

## [0.24.1] - 2026-07-06

### Fixed

- **Release packaging for platform-specific Tauri resources**: Windows release builds now delete inherited macOS-only resource keys when deriving the win32 overlay, macOS x64 overlays delete inherited arm64 native resource keys, and macOS release verification accepts both legacy `Contents/Resources/_up_` and current direct `Contents/Resources` layouts.
- Supersedes the failed `v0.24.0` CI tag; no `v0.24.0` GitHub Release was published.

## [0.24.0] - 2026-07-06

### Added

- **@Neo lightweight redesign + cross-session topic continuation**: Neo Tag now uses a lighter work-card flow and can continue project/topic work across sessions with a clearer handoff surface.
- **Evaluation flywheel expansion**: GAIA external anchors, artifact-runnable assertions, trajectory-to-case regression drafts, deterministic approval/clarification simulators, and richer static HTML triage metrics are now part of the eval path.
- **Goal and verification gates**: Goal contracts are injected into eval, verifier snapshots can prove workspace side effects, and failed gates can take a bounded repair path before deciding whether to stop or continue.
- **Cost/context accounting**: cache-aware accounting, prefix hash attribution, compression savings gates, stable request prefixes, and active tool-result pruning improve token-cost visibility.
- **Design/system gates**: token-reference integrity, source-scan self-checks, design bare-radius/z-index/important rules, and brand contrast assertions are wired into the gate suite.

### Changed

- **Settings and command UX**: Settings IA is condensed into fewer first-screen groups; `/agent` routing and `/goal` entry move toward calmer conversational confirmation; settings/navigation i18n debt is reduced.
- **Renderer/desktop startup**: renderer-ready is routed through direct invoke paths, the window waits for first-frame readiness, and startup flashes are reduced.
- **Sidebar and project chrome**: project group badges, hover actions, and Neo badge placement were simplified to avoid overlap and visual noise.
- **Internal maintainability**: collaboration rows, telemetry schema, workspace archive IPC, and Neo Tag tool guards were split out from larger files without changing behavior.

### Fixed

- **Verifier and reviewer infrastructure errors** no longer masquerade as product verification failures; infra failures now degrade explicitly.
- **Transcription rendering** is quieter, with hook cards, failed-state folding, a single thinking block, shimmer behavior, and duration thresholds tuned down.
- **Session/runtime correctness** fixes include persisted working directories across restarts, assistant message metadata round-tripping, terminal assistant persistence checks, export transcript cache wiring, and agent badge routing.
- **Desktop packaging** now stages the `cua-driver` helper outside Spotlight/Launchpad indexing paths.

## [0.23.0] - 2026-07-01

### Added

- **Multimodal bridge — chat providers auto-bridge to the media page** (Spec 1): a chat provider whose model advertises generation capability (`imageGen` / `videoGen` / `musicGen`) is now derived into a usable image/video/music model on the multimodal page, reusing the source provider's `baseUrl` + key (key never leaves the host). Pure-generation models are hidden from the conversation selector. Adds the derivation layer `deriveBridgedVisualModels`, three merged list handlers, an exhaustive key-set guard against `apiKey`/`baseUrl` leaking into bridge entries, and a compat video flavor-poll registry (standard/agnes/openrouter). Bridged image goes through the openai-compat engine; video through a generic openai-compat video engine with flavor polling; music through the MiniMax `music_generation` engine (hex audio decode).
- **Native Veo video provider** (Spec 3): new built-in `google` video provider hitting the Gemini-API light path (`predict` + long-running-operation poll, `x-goog-api-key`, not Vertex), reusing the existing `gemini` key slot. Defaults to `veo-3.1-fast`. Proxy is wired through a dedicated `veoFetch` helper (axios + gemini proxy agent + `maxRedirects: 0` + Google-API allowlist to block SSRF); all guards run before any paid call, with buffer-direct output and a self-guarded download allowlist.
- **Native Seedance video provider** (Spec 2): new built-in `ark` video provider on Volcengine Ark (`submitAndPollArkVideo` → poll to `succeeded` → `content.video_url`), authenticated with a plain Bearer Ark API key that reuses the existing `volcengine` slot (zero new config surface). Seedance is registered into `VIDEO_MODELS` with placeholder pricing pending dogfood calibration.
- **Music generation** (MiniMax): music-generation IPC handler + on-disk output + bridged/built-in `minimax` branch, a shared `resolveMusicModelEndpoint` endpoint resolver, and a `music_generate` built-in agent tool.
- **@Neo tag — work-card collaboration workflow**: mentioning `@neo` drafts a work card and drives a draft → approve → run → result-review loop, with an inline work-card card in chat, a project-collaboration page exposed from the sidebar, and a Neo work-card repository + schema/indexes.

### Fixed

- **Neo runtime safety guard (fail-closed)**: approved Neo Tag runtime runs (scoped by the `neoTag` runtime context) can no longer mutate state through non-file tools. Blocked during Neo runs: direct git/shell mutation (`git_commit` add/commit/push, `git_worktree` add/remove/prune, `kill_shell`), multi-agent/workflow/teammate writes, planning/findings/task/plan-mode mutations, `MemoryWrite` write/delete, `SkillCreate`/`propose_role`, calendar/reminders/mail connector writes, MCP `add_server` and non-read-only tool invocations, and process submit/write/kill. Read-only observation (status/log/diff/list/get) stays allowed. Ordinary non-Neo tool calls keep their existing permission path.
- **Multimodal i2v base-image guard hoisted to a provider-shared gate** (Codex audit round 2–3): the image-to-video base-image validation was previously hardcoded to a single provider's key gate, leaving Seedance `ark` i2v dead-on-arrival on the real IPC path (unit tests passed but the canvas produced nothing). Guard hoisted above provider routing so it covers wanx/minimax/ark uniformly, and Seedance i2v now selects the provider-appropriate key.
- **Control-plane public-key source merge** (release infra): env policy / cloud release policy / OSS direct-connect fallback now resolve public keys from a single merged source.
- **Compat video `create` timeout widened to 120s**: a free-tier compat provider (Agnes) queued the create call ~89s; the engine's 30s submit budget mis-killed it. A compat-specific `createTimeoutMs` avoids the false timeout (the earlier proxy suspicion was actually slow create).

## [0.22.2] - 2026-06-29

### Fixed
- **in-app 软件更新整包下载间歇性失败**：更新检查（Vercel `/api/update?action=check`）返回的 `downloadUrl` 此前指向 GitHub release **网页** 而非安装包直链，客户端 in-app updater 的 `downloadFile()` 抓到 HTML 而非 dmg/exe，导致更新装不上。改为返回 OSS 安装包直链（与原生 Tauri 更新器同源），并由发布管线（`build-stable-release-json.mjs --compute-asset-sha256`）为每个安装包计算 sha256 写入 `release.json`，客户端校验从「缺 sha256 时 override 放行」升级为真校验。
- 经 4 轮独立对抗审计硬化 `(downloadUrl, sha256, version)` 同源不变量：env policy override、cloud release policy、OSS 直连 fallback、`check` 与 `action=download` 两端，全部做到三者同源或 fail-closed；并修复发布脚本对非安装包响应（HTML 错误页/占位）误算 sha256、`normalizeSha256` 对非字符串输入崩溃、auto-download 未捕获 rejection 等健全性问题。

## [0.22.1] - 2026-06-29

### Fixed

- **IME composition guard on popup/search/rename inputs**: pressing Enter to confirm a Chinese (or other IME) candidate was treated as select/submit/close — it closed the model-switcher popup, submitted partial searches (chat search, skill discover), and committed half-composed renames (project / design layer / session title / new file). Added `isComposing` / `keyCode === 229` guards to ModelSwitcher + 7 text inputs (URL/path inputs and non-text `role=button` keydowns left untouched).

## [0.22.0] - 2026-06-29

### Added

- **Design mode is conversational again** (recovered): switching to Design activates a session-bound canvas + opens the canvas tab instead of popping a fullscreen brief form (form demoted to an on-demand entry for web/slides/video). Recovered from `feat/design-conversational-surface` (never merged; production renderer had regressed to the form after the 2026-06-27 hot-update was published from form-only main). Brings per-session design-active flag, canvas injection gate, intent-driven canvas tools, cross-session owner isolation.
- **Generation model defaults** (ADR-027): a "Generation defaults" settings tab to pick default image/video models; design pulls them on launch.
- **Settings IA regroup**: model-related tabs (model / generation / execution engine / search / voice) consolidated into a top "Models & capabilities" group; budget-alert tab entry removed (underlying budget logic kept).
- **Tool-error observability (Sentry) + telemetry session-restore** (ADR-030): handled tool failures of actionable categories report to Sentry (auth-free, allowlist + dedup + scrubbed); session-expired-with-cached-identity surfaces a non-blocking reconnect nudge instead of silently clearing; Keychain session-persistence dead-code fixed.

### Fixed

- **Chat — local HTML links open in-app preview**: model-generated games/pages written as `[file.html](file://...)` open Neo's in-app artifact preview (playable) instead of the system browser.
- **Chat — external/file link clicks work in packaged app**: `openExternalLink` routes through the webServer IPC bridge instead of the Tauri opener plugin, which silently no-op'd in the http-origin webview.
- **Chat — Sources card collapsed by default**: web-fetch provenance card folds by default (expand on click).

## [0.21.1] - 2026-06-27

### Added

- **Sidebar — Codex-style conversation list redesign** (#287): each row reduced to title + relative time; running sessions show a spinner, attention states (error/approval/paused/incomplete) a quiet semantic dot. Eval diagnostics (trajectory quality `G0·Diag`, evidence level `EV`), type/automation badges, the summary line and replay-evidence buttons moved out of the default row (still reachable via project console / replay panel). Replay/assets/archive actions are hover-only. Project group header collapses its console/details/assets/new toolbar to hover; long lists fold to the first 5 sessions with an "expand all" toggle (auto-expands under search or when the current session is past the cap).

### Fixed

- **Keybinding — unbind resend by default** (#290): `Cmd/Ctrl+Shift+R` clashed with the browser/desktop hard-reload shortcut; an accidental press re-sent the last message, which for paid image/video generation meant silently paying again. The `session.retry` action now ships unbound by default (users can rebind it in settings).
- **Design canvas — proposal design-mode gate** (#291): `useCanvasProposalReview` was missing the design-mode gate that `useCanvasVideoRequest` already enforces, so canvas writes could land outside a design context. Mirrors the sibling fail-closed gate (reject + immediate respond so the blocking host tool resolves) without reintroducing per-session ownership complexity.

### Changed

- **Design-system bare-button ratchet** (#289): baseline lowered 772→736 with token-based buttons across NativeDesktopSection / RolesTab / SidebarProjectDrawer.
- Internal refactors: `src/main` → `src/host` directory rename; god-file splits (decision-trace recording, prompt-budget helpers, cron row/schedule normalizers, godfile-host #288); repo cleanup of mistakenly-tracked runtime artifacts; release gate now verifies the updater public key is injected into build artifacts.

## [0.21.0] - 2026-06-27

### Added

- **Design canvas — agent-operated edits**: the design agent can now propose canvas operations (ghost preview + approval UI, ADR-026), with per-op accept/discard, soft-delete + restore of nodes, and design-agent medium tool gating (ProposeVideoOps/ProposeSlidesOps + `designCanvasActive`).
- **Design canvas — bounded autonomy** (ADR-027): set a budget envelope (max variants + max spend), the agent generates N divergent variants within it, you pick the winner; budget gate hard-stops on overrun, with envelope approval UI, progress, lifecycle, and i18n.
- **Design — custom image-gen models + health-aware selection**: register custom image models in Settings; the canvas avoids unconfigured models and falls back on balance/credential failure.
- **Design — video cover + auto-fit + design→code handoff**: video gets an auto cover and viewport auto-fit; large (>2MB) videos play inline via Blob URL; design output can carry code-handoff context with an acceptance/constraint contract.
- **Preview/QA — artifact verification pipeline**: deterministic artifact health check + subjective vision QA layer + automatic repair loop; artifact QA routed through the in-app browser by default; PPT pixel-level per-page screenshot preview.
- **Web search — query planning & evidence ranking**: plan queries before searching, rank primary evidence, mark recency-constraint strength, provider capability health matrix, and configurable search sources (multi-source enable/disable + priority).
- **Agent — collaboration tree**: read-only agent tree snapshot + worktree review surface; unified agent failure codes; success write-storm detection + delivery-review evidence.
- **Telemetry — cost calendar**: daily/weekly/monthly cost aggregation.
- **Unified evidence contract** across file/shell/discovery/browser-computer tools, with hardened read gates and discovery pagination.

### Fixed

- Sidebar session-list flicker on refresh (signature memoization) and startup white-screen flash (`#18181b` window background).
- Security hardening: closed `rm` long-option / arbitrary-order flag bypasses across the dangerous-command defenses.
- Numerous design-mode adversarial-audit fixes (illustration cost ceiling, abort-timer leak, SSRF-via-redirect, filename traversal, region-lock strict defaults).

### Changed

- Internal source tree renamed `src/main` → `src/host` and de-Electron-ized API shims; god-file splits across DesignCanvas, Sidebar, host, telemetry, and workspace IPC. No user-facing behavior change.

## [0.20.0] - 2026-06-22

### Added

- **Design mode — tab reorganized by delivery medium**: Web / Image / Slides / Video, so users pick "I want to make a ___" up front (`DesignOutputType` UI aggregation, zero-breaking).
- **Design mode — thick slides pipeline**: requirement →（optional AI）outline → per-slide editing (title/points/reorder) → pixel preview (LibreOffice real-layout render) →（optional AI illustrations, model chosen on the page）→ real-layout PPTX export with brand-color theming. Engine extracted to `services/design/slidesGenerator` (SlideData[] single source of truth); enhancements are opt-in with cost shown up front.
- **Design mode — reference-image priming**: paste a reference image before generating ("Add reference" entry, sky badge on the canvas); the first reference is fed to the model as visual guidance (Tongyi Wanxiang `wanx2.1-imageedit` / `description_edit`), preserving the reference layout while restyling per the requirement.
- **Design mode — unified history**: design history consolidated into the left composer — image/video step timeline (reference images grouped separately, not counted as versions), and prototype version view/compare/finalize moved from the preview toolbar into the left panel. Image and prototype share the non-destructive variant spine.

### Fixed

- Reference-image path: fails loudly when the reference image can't be read (no silent fallback to text-only generation); reference images don't expose the region-repaint toolbar; continuing-edit clears stale compare state.

## [0.19.1] - 2026-06-22

### Fixed

- Fixed packaged-app startup failure introduced in v0.19.0 ("Web server exited before healthcheck completed: exit status: 1"): the design-mode PDF/PPTX export eagerly loaded `pdfkit`/`pptxgenjs` at startup, but those deps were esbuild-external and not shipped in the app, so the backend web server crashed on launch. Both are now bundled into the backend (`pdfkit` via its font-inlined standalone build). Functionally identical to v0.19.0.

## [0.19.0] - 2026-06-22

### Added

- **Design mode — switchable image models**: text-to-image can switch among Tongyi Wanxiang / CogView-4 / FLUX.2 / **gpt-image-2**, driven by a capability-tagged visual-model registry; the switcher only lists visual-generation models with a configured key (chat models filtered out). gpt-image-2 is wired via a custom OpenAI-compatible endpoint.
- **Design mode — video generation (new)**: text-to-video and image-to-video on the canvas via Tongyi Wanxiang Video and MiniMax Hailuo, as first-class canvas nodes on the non-destructive variant spine, with a prominent per-duration cost estimate before generation.
- **Annotation-redraw editing**: annotate on the canvas (pen/arrow/rect/text), bake the annotations into a screenshot, and have the model redraw a clean revised image — a mask-free edit path for models that don't support mask inpaint (e.g. gpt-image-2).
- **Brand/design-system reuse**: persist your own brand palette, fonts, and component tokens and inject them into subsequent generations for cross-generation consistency.
- **In-place text editing** for interactive prototypes (click text to edit, no regeneration).
- **PDF and PPTX export**.
- **Agent execution-engine compatibility matrix** + a settings section for execution engines; **MiMo-Code and Kimi Code** execution engines integrated.

### Fixed

- SSRF guard on image URL downloads: https public hosts only, rejecting private/loopback/metadata addresses (fixes an IPv6-literal bypass that was dead code).
- Design IPC actions reject blank/out-of-range params before any paid call, avoiding wasted paid requests.
- All new design-canvas IPC capabilities registered in the shell capability manifest so renderer hot-update gates pass.
- Stability batch fixes across execution paths.

## [0.18.0] - 2026-06-21

### Added

- **Design Mode (full)**: a top-level design workspace alongside Code, covering interactive prototypes (HTML), mockups/infographics on an infinite konva canvas (text-to-image + true mask inpaint via Tongyi Wanxiang), and a deterministic design-quality self-review hook. Informed by an OpenDesign/Lovart competitive-borrow study (`docs/competitive/opendesign-lovart-借鉴清单.md`).
- **Variant version spine (T1)**: canvas and prototype share a non-destructive variant model — every operation lands a new pinned variant (never overwrites), discards are soft-deletes, with side-by-side compare and set-as-main.
- **Cost transparency + reversible history (T2)**: pre-generation cost estimate, named/undoable history steps, and BYOK actual-spend visibility (IPC returns `actualModel`/`costCny`).
- **Image expand + watermark removal (T3)**: Wanxiang `expand` (directional ratio outpaint) and `remove_watermark`, landing into the variant spine.
- **Consistency-locked re-editing (T4)**: region-lock + diff-gate keeps the unselected region pixel-identical after inpaint (out-of-bound pixels are pasted back and a diff-evidence image is written).
- **Direction cards + reference-screenshot intake (T5)**: a mandatory pre-generation clarification form with multi-direction cards, a "match a reference screenshot" branch, and a "just generate" escape hatch.
- **Runtime reskin + real-image placeholders (T6)**: prototype preview supports 5 instant theme palettes (no regeneration), and generated prototypes use deterministic real images instead of gray placeholders.

### Fixed

- Registered new design-canvas renderer IPC capabilities (generate/edit/import design image) in the shell capability manifest so renderer hot-update gates pass.
- Family-level path-traversal guard (`assertWithinDesignDir`) across all design IPC actions.
- Multiple adversarial-audit hardening passes on the variant spine, expand/remove, and the consistency gate (symmetric application + boundary fixes).

## [0.17.2] - 2026-06-18

### Added

- **Firecrawl default web data layer**: `WebSearch` and `WebFetch` now prefer Firecrawl for public web search/scrape, with keyless mode, authenticated API key support, native fetch fallback, and local/private/raw URL exclusions.
- **Post-publish release verification**: added `release:post-publish` / `release:neo --post-publish-verify` checks for update metadata, download redirects, landing version slot, renderer rollout, OSS manifests, `release-record.json`, rollback state, and optional Vercel log audit.

### Changed

- Search routing now starts from Firecrawl and adds premium sources by query type; configured but unused premium sources are surfaced as a soft `sources` hint.
- Chat input recommendations are quieter: skill recommendations are capped at two, capability suggestions at three, and duplicate skill/capability chips are filtered.

### Fixed

- Firecrawl keyless rate limits now show a concrete `FIRECRAWL_API_KEY` setup hint, and repeated Firecrawl transport/HTTP failures trigger a short cooldown instead of adding timeout cost to every request.
- Non-streaming OpenAI-compatible and Claude tool-call responses now preserve preamble text and ordered `contentParts`, keeping tool blocks in the same order as streaming responses.
- Models with tool-calling capability no longer get false composer warnings that they cannot handle search tasks.
- Packaged runtime logging now honors `CODE_AGENT_LOG_DIR`, keeping Tauri and Node webServer log paths aligned for diagnostics.

## [0.17.1] - 2026-06-17

### Fixed

- Registered budget settings shell capabilities for renderer hot-update manifests so `getBudgetStatus` and `setBudgetConfig` no longer block release gate verification.

## [0.17.0] - 2026-06-17

### Added

- **Event ledger and recovery**: append-only ledgers now cover permission decisions, tool execution lifecycle, session replay projections, Swarm rollups, crash recovery snapshots, and reconcile diagnostics.
- **Budget alerts**: budget config, runtime budget IPC, StatusBar usage coloring, and threshold / over-limit toast notifications are now wired into the app.
- **Design system gates**: design-system contract docs, baseline checks, hex-color ratchet rules, and Modal primitive migrations start turning UI consistency into enforceable checks.
- **Model, voice, and workflow surfaces**: model strategy visibility, prompt stack summary, configurable hotkeys, end-to-end voice input, session media assets, project/session organization, and capability evidence gates have been added.

### Changed

- Chat, sidebar, composer, route trace chips, and tool result presentation have been decluttered so user-facing state is clearer and engine internals stay out of the main path.
- Swarm ledger read paths can rebuild rollups from the ledger and fail-safe back to existing sources when a projection is incomplete.
- Release and quality gates now include additional console, accessibility, stale-dist, eval, and capability-evidence checks.

### Fixed

- Fixed voice transcription privacy bypasses, hotkey focus gating, shell capability boundaries, budget startup config sync, stale session status semantics, and model/tool-result echo issues.
- Fixed several chat reliability problems around auto-load retries, fake edits, streaming code/diff layout shifts, search-source quota failures, and schema parse-error feedback.
- Fixed renderer polling, duplicate requests, and empty-draft model inheritance behavior.

## [0.16.104] - 2026-06-12

### Added

- **Agent runtime hardening**: MiMoCode 对照后的多级 Edit replacer、doom-loop guard、Task gate、goal impossible 止损、max-step 三段式兜底、retry 分类和 provider 失败友好提示进入主链路。
- **History / memory / dream**: transcript FTS 按 kind 索引工具输入输出、用户文本、assistant 文本和 reasoning；History 工具进入 deferred tools；memory packing 增加 BM25；dream consolidation 以原始轨迹为证据。
- **Experience distillation**: `/distill`、skill executor registry、六阶段 pipeline、LLM 提案生成器和 30 天自动调度落地；生成 skill 仍先入草稿，需用户确认后才安装。
- **Nested subagent and Max Mode**: 子代理可递归委派，整棵 spawn tree 共享深度、配额、超时和 token budget；Max Mode 支持 propose-only best-of-N、judge 选优和 winner replay。
- **MCP / admin ops**: 普通登录用户可自助添加、启停、重连 MCP server；HTTP Streamable MCP、`url` alias 和 headers 进入 `mcp_add_server` / `MCPUnified`；管理员可通过 Supabase RPC 授予或撤销他人 admin。

### Changed

- checkpoint writer 保持后台 LLM 子代理路径，但前台重建边界只短等窗口，超时或无明确成功结果时 fail-closed 回 summary 压缩。
- renderer production verifier 给 control-plane/app update/manifest/release-record metadata 和 renderer bundle hash 下载设置超时，并输出 stage diagnostics，避免发版验收无限等待。
- skill distillation 草稿拒绝 `grep-read-edit`、`bash-bash-bash` 这类低价值工具序列名，防止把机械操作串误沉淀为方法论。

### Fixed

- renderer active bundle 版本低于当前 shell version 时回退 builtin renderer，避免旧前端遮住新壳修复。
- dream 防幻觉门收紧，避免弱证据候选写入长期记忆；无近 7 天会话时不再降级全历史。
- prompt provider variant A/B 结果写入 eval metadata；`PROMPT_VERSION` 回退到真实内容版本，避免无内容 bump 污染归因。
- unsupported weekly cron interval 在主进程拒绝，前端不再展示不可用 weekly interval 选项。
- vision analysis 现在保留最后失败原因，空响应会报告为 `empty_response`，不再被误归为 generic exception。
- `session_tasks.parent_task_id` 进入 runtime recovery state，恢复时保留任务树父子关系。

## [0.16.103] - 2026-06-11

### Added

- **Windows (win32-x64) 测试版首次随版发布**：NSIS unsigned perUser 安装包（无 UAC），release.yml 独立 build-windows job 进正式发版链，三平台 latest.json（darwin-aarch64 / darwin-x86_64 / windows-x86_64）；windows leg 失败自动降级 mac-only 发版。
- 分发页设备感知：按访问者 OS/芯片推荐对应安装包（只决定排序与高亮，所有平台入口保持可见可点）。
- PII 安装链 Node 化（setup-gliner-pii.mjs 双平台一份实现），Windows 包可启用本地 PII 防线。

### Fixed

- Local(Ollama) 假性"已可用"：列表展示前先探测本地服务，未装 Ollama 不再显示本地模型可用。
- 配好 provider 后默认模型自动接管，消除"明明配置了还说没配置"。
- MiMo 托管 key 登录后下发（sharedProviderKeys 控制面到客户端全链路）。
- 更新分发资产选择两处隐患：服务端/客户端均不再可能把 runtime manifest（JSON）当安装包下发；Intel mac OSS 降级路径不再误取 arm64 dmg。
- 权限路径白名单 Windows 语义旁路（path.relative 体系 + NTFS 大小写不敏感）+ 归档解压反斜杠/盘符条目逃逸。
- ConnectorRegistry 平台过滤：非 macOS 不再注册 AppleScript connector 组（11 个工具不进 LLM 工具列表）。

## [0.16.102] - 2026-06-10

### Fixed

- 会话导出（Markdown / 会话日志）打包态静默失败：改主进程直写「下载」文件夹 + 访达定位 + toast 反馈，废弃 webview 另存为对话框链路。
- conversationRuntime 测试 mock 补 PROMPT_VERSION 导出（16 用例恢复）。

## [0.16.101] - 2026-06-10

### Added

- **Intel Mac (x64) 双架构首发**：发版矩阵 arm64 + x64（macos-15-intel 原生构建），单 manifest 双平台键（darwin-aarch64 + darwin-x86_64），分发页按芯片选包，`/api/update` 按 arch 路由。x64 限制：VAD 不适配（onnxruntime-node 无 darwin-x64），静默降级。
- Computer Use 新底座（CUA，默认关闭）：cua-driver 重签为「Agent Neo Computer Use.app」，stdio MCP 接入，权限 UI（Accessibility 必需 + 一键授权），重签产物走 OSS 预构建分发（sha256 锁定）。
- 会话右键「导出会话日志」：脱敏诊断包 + 当天日志尾部，未登录可导；会话导出改原生「另存为」对话框。

### Fixed

- 中转站「测试连接成功但会话 404」：baseUrl 末尾斜杠解析层统一 trim；404 错误带实际请求 URL + /v1 提示；aiSdk 路径 HTTP≥400 落带 URL 日志。
- 工具结果落库前 eager 压缩导致模型重试循环：observation 原样可见，L1 投影层跨轮幂等重截断。
- WKWebView 启动连刷：启动 URL 唯一 `?boot=` 参数 + index.html `Cache-Control: no-store`。
- 视觉分析智能候选路由；默认视觉模型对齐默认 provider；MCP 认证失败路由到重新授权。

## [0.16.100] - 2026-06-09

### Added

- 经验沉淀重做（ADR-020）：废弃 telemetry n-gram 频次蒸馏，skill 自动沉淀统一收口到 LLM 语义复盘（Hermes/Anthropic 规格），入口闸 + 反思门 + 命名禁用清单 + 结构化 SKILL.md。
- Telemetry 可诊断性：trace/session 版本指纹（agentVersion/promptVersion/toolSchemaVersion），本地全量诊断旁表 + 失败 session 脱敏诊断包上报，Langfuse 默认开启 + opt-out 开关。

### Changed

- 删除/卸载操作直接调用工具，确认交给权限卡片；命令安全分级松绑误杀（目标明确单路径删除从硬毙降为一次确认，删根/家/通配仍硬毙）。

### Fixed

- 解除挂起权限请求死锁：新消息/取消时 resolve 挂起请求，不再冻结到 60 秒超时。
- 强化 provider 选择与诊断；截图发非视觉模型不再丢图；云端同步会话改幂等 upsert 修 NULL-owner 主键冲突刷屏；sseStream 响应头首字节超时修 accept-then-hang；skill 名称容错 + did-you-mean。
- LogMasker 超大输入预截断，修复脱敏 ~110s 卡顿。

## [0.16.99] - 2026-06-08

### Fixed

- 修复 notarized app 在慢启动环境下可能因 webServer 初始化超过 30 秒而被 Tauri healthcheck 杀掉的问题；启动等待窗口调整到 90 秒，覆盖 Supabase session timeout、旧库迁移和首次插件初始化的组合耗时。

## [0.16.98] - 2026-06-08

### Fixed

- 修复 Claude 连接测试仍使用废弃 `claude-3-haiku-20240307` 的问题，改为优先使用当前选择模型，并在缺省时使用 provider 当前默认模型。
- 修复 AI SDK 流式工具调用可能被终态空 `tool-call.input` 覆盖已累积参数的问题，避免 Write 等工具在执行层收到空参数。
- 修复默认 provider 未配置但其他 provider 已配置时仍放行发送的问题，避免 Claude 配好后默认配置残留到 MiMo 造成 `Invalid API Key`。
- 增强模型决策与工具参数校验失败的本地 replay 和低敏远端上报，便于定位实际 provider/model、路由原因和 `tool_args_validation` 失败。

### CI

- PR 阶段左移 renderer bundle capability 校验，提前暴露热更新 manifest 能力差异。

### Added

- 🎯 **Goal Mode（`/goal` 自治目标循环）**：用户给目标 + 完成条件，Agent 自己反复跑、每轮自判、达成才停。完成判定权落在**代码层**（模型只能"申请退出"），三层闸：闸1 确定性 `--verify` 命令退出码（`/bin/sh -c` 直接 exec，不经 LLM）、闸2 可选 `--review` 软条件（派强模型 Reviewer 子代理判 PASS/FAIL）、闸3 代码层兜底（token 预算 / max-turns / 连续无进展）。`--verify` 与 `--review` 二选一即可（支持纯软目标）。详见 [docs/designs/goal-mode.md](docs/designs/goal-mode.md)。
- 🎯 `/goal` 斜杠命令 UI：触发卡片 + ChatInput 上方实时状态条（轮次 / 预算 / 计时）+ 生命周期完成卡片；走桌面 IPC + headless REST 两条链路。新增 `attempt_completion` 工具（仅 goal-mode 暴露）+ Codex 式审计 nudge（每 checkpoint 注入"先假设没做完、逐项找证据"自检）。
- 📸 **Appshots（左右 Command 双击截窗）**：macOS `CGEventTap` listen-only 监听左+右 Command，捕获当前前台 app 窗口截图（`screencapture -l`）+ AX 无障碍树文本（OCR 兜底），以隐藏 `<appshot>` XML + 图片附件注入聊天上下文，输入框展示可预览 chip。详见 [docs/designs/appshots.md](docs/designs/appshots.md)。仅 macOS。
- 🔒 **bypassPermissions 档接入 OS 级沙箱**：YOLO 权限档的 bash 执行用 macOS `sandbox-exec` / Linux `bwrap` 包装（命令前缀注入，复用前台执行器保住流式 / 中断 / 错误语义）；沙箱不可用时 **fail-fast 硬报错拒绝执行**，绝不静默裸跑。新增 `wrapCommand` 命令包装 API，由 `SANDBOX.OS_SANDBOX_ENABLED` flag 门控，其余权限档行为零变化。
- 📎 **附件管线 v2（多类型附件 → 端侧摘要 → 模型上下文）**：补齐 `audio` / `video` / `presentation`(PPTX) / `archive`(ZIP) 四类附件。上传时在端侧用 `jszip` 解 PPTX 逐页提文字/图/表（≤20 页）、解 ZIP 出目录清单（≤200 条 + zip-slip 危险路径检测），**不自动解压**；重二进制本体既不喂模型也不写库，持久化只留轻量摘要（`pptJson` / `archiveManifest`）。`<attachment>` 内联块沿用 Appshots 的"对用户隐藏、对模型可见"模式（`stripInlineAttachmentBlocks`），desktop + web 双链路在持久化边界统一 strip/sanitize。详见 [docs/designs/attachments.md](docs/designs/attachments.md)。🚧 来自验收迭代，未经逐行 review，待后续处理。

### Changed

- 🔌 **Provider 层迁移到 Vercel AI SDK（双引擎）**：新增 `aiSdkAdapter`，实现现有 `ModelRouter.inference` 契约，把 provider 原生响应归一成统一 `tool-call` / `tool-result`（流式 `streamText` + 非流式 `generateText` 同源）。子代理与主 loop 默认走 AI SDK，`CODE_AGENT_MODEL_ENGINE=legacy` 一键全回退；gemini 等非 OpenAI 兼容 provider 自动留旧路径。`providerResolution.ts` 收口 baseURL/apiKey 解析为单一来源。从根上消灭"两套解析不对称"的整类 bug（DeepSeek 非流式 DSML 漏 tool call 等）。

### Fixed

- 修 AI SDK 主 loop regression：`toAiMessages` 漏带消息重排（夹层 system 消息导致 `MissingToolResultsError`），补 `reorderToolResultsAfterAssistant` 镜像旧路径 `sanitizeToolCallOrder`。
- 修 `agent_complete` SSE 终态双发（runFinalizer + route 兜底各发一次）→ `emitAgentEvent` 对终态幂等。
- 补 AI SDK 适配器丢失的 per-request / 流式超时契约（request-timeout / first-byte / inactivity 看门狗）+ 子代理 idle 看门狗死配置。
- `postinstall` 恢复 node-pty `spawn-helper` 执行位（资源扫描 EACCES / PTY 起不来）。

## [0.16.75] - 2026-05-18

### Added

- 🍎 首个经 Apple Developer ID 签名 + Apple Notarization 的 macOS release：下载 dmg 双击即装，Gatekeeper 直接放行，零警告。
- `scripts/tauri-release-bundle.sh`：自动递归签 14 个 nested Mach-O 二进制（sharp / keytar / better-sqlite3 / onnxruntime / node-pty 等 third-party native modules）。
- `scripts/tauri-release-bundle.sh`：build 完成后自动用 `hdiutil` 重建 dmg + 重签。
- `scripts/publish-release.sh`：一键 release 发布流程。

### Changed

- `src-tauri/tauri.conf.json` `bundle.resources`：收紧 `onnxruntime-node` 和 `node-pty` 的 glob，剔除 win32 / linux / darwin-x64 跨平台 prebuilds，dmg 体积从 147 MB → 51 MB（-65%）。

### Fixed

- nested third-party native modules 未签导致 notarytool 拒收。
- `TAURI_SIGNING_PRIVATE_KEY` 必须是私钥内容（之前误设 `_PATH` 导致 `cargo tauri build` 中断）。

---

### Added (Unreleased — 后续发布)

#### 2026-04-26 Productization Pass

- Chat-Native Workbench B+ IA: ChatInput `+` menu, model+effort capsule, Settings “Conversation” tab, Sidebar User Menu, and slimmer TitleBar.
- Live Preview V2-A/B: devServerManager / DevServerLauncher, bridge protocol 0.3.0, TweakPanel, `applyTweak` IPC, and Vite-only MVP scope.
- Browser / Computer Workbench productionization: managed BrowserSession/Profile/AccountState/Artifact/Lease/Proxy/TargetRef, browser task benchmark, and background AX / CGEvent smoke paths.
- Activity Providers: provider-neutral ActivityProvider / ActivityContext contracts for OpenChronicle, Tauri Native Desktop, audio, and screenshot analysis.
- Semantic Tool UI: `_meta.shortDescription` schema/parser path, fallback shortDescription generator, target context icons, memory citation group, session diff summary, and raw URL preview chips.

#### Security Module (Session A: A1-A5)
- **Command Monitor** (`src/host/security/commandMonitor.ts`)
  - Pre-execution validation for shell commands
  - Configurable blocked/warning patterns
  - Post-execution auditing

- **Sensitive Information Detector** (`src/host/security/sensitiveDetector.ts`)
  - Detection of 20+ sensitive patterns
  - API keys, AWS secrets, GitHub tokens, private keys
  - Password and database URL detection

- **Audit Logger** (`src/host/security/auditLogger.ts`)
  - JSONL audit log files at `~/.code-agent/audit/`
  - Tool execution recording with duration and status
  - Query support by time range, session, tool name

- **Log Masker** (`src/host/security/logMasker.ts`)
  - Automatic masking of sensitive information in logs
  - Configurable masking patterns

#### Tool Enhancements (Session B: B1-B6)
- **File Read Tracker** (`src/host/tools/fileReadTracker.ts`)
  - Tracks file read operations
  - Enforces read-before-edit pattern
  - Records read timestamps and mtimes

- **Quote Normalizer** (`src/host/tools/utils/quoteNormalizer.ts`)
  - Converts smart/curly quotes to straight quotes
  - Enables fuzzy string matching
  - Improves edit_file reliability

- **External Modification Detector** (`src/host/tools/utils/externalModificationDetector.ts`)
  - Detects files modified outside Code Agent
  - Warns before overwriting external changes

- **Background Task Persistence** (`src/host/tools/backgroundTaskPersistence.ts`)
  - Persists running background tasks
  - Recovery after application restart

- **Enhanced Grep Parameters**
  - `-A`/`-B`/`-C` context line support
  - `--type` file type filtering

#### Prompt Enhancements (Session C: C1-C4, C8)
- **Injection Defense Rules** (`src/host/generation/prompts/rules/injection/`)
  - Core instruction source verification
  - Response verification guidelines
  - Meta-level rule protection

- **Detailed Tool Descriptions**
  - Bash tool: parameters, examples, anti-patterns
  - Edit tool: error handling, best practices
  - Task tool: subagent types, use cases

#### Hooks System (Session C: C9-C14)
- **Hook Configuration Parser** (`src/host/hooks/configParser.ts`)
  - Parse `.claude/settings.json` hooks configuration
  - Validation and error reporting

- **Script Executor** (`src/host/hooks/scriptExecutor.ts`)
  - Execute external shell scripts
  - Environment variable injection
  - Timeout handling

- **11 Event Types** (`src/host/hooks/events.ts`)
  - PreToolUse, PostToolUse, PostToolUseFailure
  - UserPromptSubmit, Stop, SubagentStop
  - PreCompact, Setup, SessionStart, SessionEnd, Notification

- **Multi-Source Hook Merging** (`src/host/hooks/merger.ts`)
  - Merge global and project-level hooks
  - Priority handling and deduplication

- **Prompt-Based Hooks** (`src/host/hooks/promptHook.ts`)
  - AI-powered hook evaluation
  - Dynamic prompt support

#### Testing Infrastructure (Session D: D1-D5)
- **Integration Test Framework** (`tests/integration/`)
  - Test environment setup utilities
  - Mock services for Electron, database, auth
  - Example tests demonstrating framework usage

- **Test Scaffolds**
  - Security module unit tests (91 tests)
  - Tool enhancement unit tests (57 tests)
  - Prompt builder tests (56 tests)
  - E2E security scenario tests (29 tests)

### Changed

- Live Preview V2-C Next.js App Router support is deferred; V2 scope is now Vite-only MVP.
- Evaluation `max_tool_calls` assertions are weighted process-quality signals instead of critical failure gates.
- Thinking-mode providers send `reasoning_content` consistently for assistant history, scoped through provider overrides.
- **edit_file**: Now requires file to be read first (read-before-edit)
- **edit_file**: Smart quote normalization for better string matching
- **edit_file**: Warning on external file modification
- **grep**: New `-A`, `-B`, `-C`, `--type` parameters

### Deprecated

- None

### Removed

- None

### Fixed

- None yet

### Security

- Added runtime command monitoring
- Added sensitive information detection and masking
- Added comprehensive audit logging
- Added injection defense rules to system prompts

---

## [0.9.1] - 2026-01-22

### Changed
- Version bump

---

## [0.9.0] - 2026-01-XX

> **Note**: This version is in development. See [Unreleased] for upcoming changes.

---

## [0.8.x] - Previous Releases

See git history for previous release notes.
