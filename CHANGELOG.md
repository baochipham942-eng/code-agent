# Changelog

All notable changes to Code Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **Command Monitor** (`src/main/security/commandMonitor.ts`)
  - Pre-execution validation for shell commands
  - Configurable blocked/warning patterns
  - Post-execution auditing

- **Sensitive Information Detector** (`src/main/security/sensitiveDetector.ts`)
  - Detection of 20+ sensitive patterns
  - API keys, AWS secrets, GitHub tokens, private keys
  - Password and database URL detection

- **Audit Logger** (`src/main/security/auditLogger.ts`)
  - JSONL audit log files at `~/.code-agent/audit/`
  - Tool execution recording with duration and status
  - Query support by time range, session, tool name

- **Log Masker** (`src/main/security/logMasker.ts`)
  - Automatic masking of sensitive information in logs
  - Configurable masking patterns

#### Tool Enhancements (Session B: B1-B6)
- **File Read Tracker** (`src/main/tools/fileReadTracker.ts`)
  - Tracks file read operations
  - Enforces read-before-edit pattern
  - Records read timestamps and mtimes

- **Quote Normalizer** (`src/main/tools/utils/quoteNormalizer.ts`)
  - Converts smart/curly quotes to straight quotes
  - Enables fuzzy string matching
  - Improves edit_file reliability

- **External Modification Detector** (`src/main/tools/utils/externalModificationDetector.ts`)
  - Detects files modified outside Code Agent
  - Warns before overwriting external changes

- **Background Task Persistence** (`src/main/tools/backgroundTaskPersistence.ts`)
  - Persists running background tasks
  - Recovery after application restart

- **Enhanced Grep Parameters**
  - `-A`/`-B`/`-C` context line support
  - `--type` file type filtering

#### Prompt Enhancements (Session C: C1-C4, C8)
- **Injection Defense Rules** (`src/main/generation/prompts/rules/injection/`)
  - Core instruction source verification
  - Response verification guidelines
  - Meta-level rule protection

- **Detailed Tool Descriptions**
  - Bash tool: parameters, examples, anti-patterns
  - Edit tool: error handling, best practices
  - Task tool: subagent types, use cases

#### Hooks System (Session C: C9-C14)
- **Hook Configuration Parser** (`src/main/hooks/configParser.ts`)
  - Parse `.claude/settings.json` hooks configuration
  - Validation and error reporting

- **Script Executor** (`src/main/hooks/scriptExecutor.ts`)
  - Execute external shell scripts
  - Environment variable injection
  - Timeout handling

- **11 Event Types** (`src/main/hooks/events.ts`)
  - PreToolUse, PostToolUse, PostToolUseFailure
  - UserPromptSubmit, Stop, SubagentStop
  - PreCompact, Setup, SessionStart, SessionEnd, Notification

- **Multi-Source Hook Merging** (`src/main/hooks/merger.ts`)
  - Merge global and project-level hooks
  - Priority handling and deduplication

- **Prompt-Based Hooks** (`src/main/hooks/promptHook.ts`)
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
