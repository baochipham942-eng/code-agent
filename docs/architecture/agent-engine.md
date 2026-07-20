# Agent Engine 架构（执行引擎 as-built）

> **范围**：执行引擎（执行内核 `AgentEngineKind`）这条特性线——Native + 4 个外部 CLI 引擎（Codex / Claude Code / MiMo-Code / Kimi Code）的接入、Runtime×Model 兼容矩阵 + 计费模式、设置页「执行引擎」section、StatusBar 引擎切换器。
> **状态**：引擎链（适配器/分发/探测/catalog/权限）+ 兼容矩阵 + 设置页 IA + Durable Run 生命周期均已合 main。MiMo / Kimi 是 2026-06-22 新增的两个引擎，Durable 终态与恢复边界于 2026-07-12~18 收口。
> **配套**：计划 `docs/plans/engine-expansion-mimo-kimi.md`（意图，非 as-built）；早期 Agent Engine 抽象见 `docs/ARCHITECTURE.md` v9.18 批次（codex/claude 接入、签名 catalog、task ledger）。

---

## 1. 核心概念：引擎 ≠ 模型 provider

引擎是「**谁来跑这一轮**」的执行内核，与「用什么脑子」的模型 provider 正交两层。先选引擎，再选模型。

| 引擎 `AgentEngineKind` | 本质 | 计费 | 入口命令 |
|---|---|---|---|
| `native` | Neo 自家 ConversationRuntime（现有 provider/工具/权限/trace/review 栈） | `api_key_payg`（随所选 provider） | — |
| `codex_cli` | Codex CLI（受控 workspace cwd + 归一事件流） | `subscription` | `codex exec --json` |
| `claude_code` | Claude Code（非交互 plan 模式 + 只读工具） | `subscription` | `claude -p --output-format stream-json --permission-mode plan` |
| `mimo_code` | **MiMo-Code CLI**（OpenCode fork，归一 JSON 事件流） | `subscription` | `mimo run --format json` |
| `kimi_code` | **Kimi Code CLI**（归一 stream-json 事件流） | `subscription` | `kimi -p --output-format stream-json` |

> 选外部引擎 = 用它的 harness + 你自己登录的订阅，**吃不到 Neo harness 红利**。加它们的价值定位是**计费**（让用户烧自己的订阅/账号额度，吃 API key 拿不到的额度），不是 harness 质量。

类型定义：`src/shared/contract/agentEngine.ts`
- `AgentEngineKind = 'native' | 'codex_cli' | 'claude_code' | 'mimo_code' | 'kimi_code'`
- `ExternalAgentEngineKind = Exclude<AgentEngineKind, 'native'>`（external engine 单一真源；IPC/helpers 都收窄到它，避免漏同步 mimo/kimi）
- `AgentEngineDescriptor`（label/installState/runtimeState/command/version/capabilities/defaultPermissionProfile/reliability…）

---

## 2. Runtime × Model 兼容矩阵 + billingMode

唯一真源：`src/shared/constants/engineCompat.ts`（纯函数、零 IO、main/renderer 共用，只产出枚举 + reasonCode，文案在 renderer 经 i18n 派生）。

### 2.1 引擎级计费 `EngineBillingMode`

`'subscription' | 'api_key_payg' | 'free_tier' | 'unknown'`

| 引擎 | billingMode | 语义 |
|---|---|---|
| `native` | `api_key_payg` | 随所选 provider，主体按 API key 用量计费（provider 级 free/plan/payg 仍由 `BillingMode` 在模型层表达） |
| `codex_cli` / `claude_code` / `mimo_code` / `kimi_code` | `subscription` | 外部 CLI 经各自 login 吃订阅/账号额度，**适配器从不注入 API key** |

- `ENGINE_BILLING_MODE: Record<AgentEngineKind, EngineBillingMode>`（出厂映射，上表即其内容）
- `getEngineBillingMode(kind)` → 兜底 `unknown`
- `engineBillingModeIsAuthoritative(kind)` → `kind !== 'native'`（native 随 provider，引擎层无法只凭 kind 断定 billing；其余可）
- `free_tier` 当前出厂矩阵默认不命中，预留（如 mimo 免费档）

### 2.2 模型兼容判定 `getEngineModelCompat(kind, modelId, ctx)`

返回 `{ supported, reasonCode? }`。`reasonCode` 枚举：

| reasonCode | 含义 |
|---|---|
| `not_in_signed_catalog` | codex/claude：模型不在该引擎签名目录（fail-closed，绝不静默替换默认模型） |
| `disabled_in_catalog` | 模型在签名目录但被 `disabledReason` 停用（比"不在目录"更精确） |
| `provider_not_registered` | native：模型解析不到注册表内 provider |
| `resolved_by_cli` | mimo/kimi：模型由 CLI 自身解析，引擎层不校验（`supported=true` 但带注解） |

判定规则（与 run 派发路径一致）：
- `native` → `ctx.isRegisteredNativeModel(modelId)` 命中则 supported，否则 `provider_not_registered`
- `codex_cli` / `claude_code` → 仅签名目录"已启用"集合内 supported；命中"停用"集合 → `disabled_in_catalog`；否则 `not_in_signed_catalog`（均 false）
- `mimo_code` / `kimi_code` → 恒 `supported=true` + `resolved_by_cli`
- `modelId` 为空（走引擎默认）→ 一律 supported 且无 reasonCode（对齐 `resolveAgentEngineCatalogModel` 未显式请求时回落默认、不 fail-closed）

判定上下文 `EngineModelCompatContext` 由调用方按各自数据源注入（renderer 用 catalog 结果，main 用签名 catalog / provider 注册表），保持本模块零 IO：
- `signedCatalogEnabledModelIds` / `signedCatalogDisabledModelIds`（codex/claude）
- `isRegisteredNativeModel(modelId)`（native）

renderer 翻译层在 `modelSwitcherHelpers.tsx`：`buildEngineBillingSummary`、`resolveEngineModelCompatReason`、`buildEngineModelCompatContext`（从 catalog 模型列表拆 enabled/disabled id 集合）、`getEngineModelCompatReasonText`（优先展示 `disabledReason` 原文，否则回落 reasonCode）。文案在 `t.engineCompat.{billing,reason}`。

---

## 3. 引擎接入：registry 探测 + 适配器分发 + catalog 登记

### 3.1 registry 探测（PATH 发现 + fail-closed）

`src/host/services/agentEngine/agentEngineRegistry.ts`
- `list()` 并行探测 codex/claude/mimo/kimi（`which`/`where` 定位 binary + `--version` 探活，3s 超时），加 native，按 **native → codex → claude → mimo → kimi** 排序
- 探测结果带 **5s TTL 缓存**（`DETECT_CACHE_TTL_MS`）——去重一次交互内多次 `list()`；`invalidate()` 强制重探
- 探活用 shell PATH（`getShellPath()`），未装 → `installState: 'missing'` + `runtimeState: 'not_configured'`
- 每个外部引擎的 descriptor 带 `auditNotes`（如"凭据由 CLI 从 MIMO_HOME/KIMI_CODE_HOME 读，适配器从不注入 API key"）+ `reliability`（streamingMode/toolSupport/transcriptMode…）
- 单例 `getAgentEngineRegistry()`

### 3.2 适配器（spawn + 解析 + 归一）

| 引擎 | 适配器 | wire format |
|---|---|---|
| mimo_code | `mimoCliAdapter.ts`（`MimoCliAdapter`） | `mimo run "<prompt>" --format json`，逐行解析 JSON 事件 → 内部 `AgentEvent` |
| kimi_code | `kimiCliAdapter.ts`（`KimiCliAdapter`） | `kimi -p "<prompt>" --output-format stream-json`，逐行 JSONL，只读 stdout 取正文 |

两家共性（对照 `codexCliAdapter` / `claudeCodeAdapter`）：
- 只支持 text prompt（有附件即拒绝）
- 经 `assertWorkspaceCwd` / `assertReadOnlyExternalProfile` 守卫（workspace cwd 内 + read-only profile）
- 启动 cwd / 命令摘要 / log path 写入 `backgroundTaskLedger`
- 容错「empty response」：OpenAI 兼容后端偶发 exit 0 但空响应，归一成可识别失败，不落「completed without text output」兜底（mimo/kimi 对称处理）
- 凭据走白名单 env（透传 HOME/PATH/MIMO_HOME 等，剥离敏感 KEY/TOKEN），CLI 自己读凭据，适配器不自创注入路径

**MiMo 非 TTY 权限策略**（dogfood 抓到的真 bug，单测 mock 测不出）：MiMo 是 OpenCode fork，非 TTY 下某工具权限解析成 `ask` 会弹交互审批阻塞挂死。常量 `src/shared/constants/mimoCode.ts`：
- `MIMO_CODE_PERMISSION_ENV = 'MIMOCODE_PERMISSION'`（OpenCode `OPENCODE_PERMISSION` 的 MiMo 重命名，JSON，deep-merge 进权限配置）
- `MIMO_CODE_READ_ONLY_PERMISSION`：catch-all `'*': 'deny'` + read/glob/grep/list/lsp `allow` + 写/执行/越权/外联全 `deny`
- **关键不变量：任何工具都不得解析成 `ask`**（否则非 TTY 再次阻塞）；不用 `--dangerously-skip-permissions`（会 auto-approve 一切，违反 read-only）；适配器还剥离用户 shell 里同名 env 防绕过

**Kimi 凭据**：CLI **不从 env var 读 API key**（`KIMI_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` 都不读）。凭据走 `kimi login` 落盘或 `KIMI_CODE_HOME`（默认 `~/.kimi-code`）的 `config.toml`。per-user `KIMI_CODE_HOME` 隔离目录由后续凭据接口派生后经 `KimiCliRunRequest.kimiCodeHome` 注入（当前沿用 `env.KIMI_CODE_HOME` / CLI 默认）。

### 3.3 分发（按 `engine.kind` 路由）

两条 run 派发路径都加了 mimo/kimi 分支：
- `src/host/app/agentAppService.ts`（`sendMessage`）— line ~309/325
- `src/web/routes/agent.ts` — line ~387

模型解析差异：
- codex/claude 走 `resolveModelId(kind, model, { strict: true })`（签名 catalog，fail-closed）
- **mimo/kimi 直传 `launch.model`**——`resolveModelId` 对未注册签名 catalog 的 kind 返回 undefined 会丢掉用户所选模型，故直传

### 3.4 模型 catalog 登记

`src/shared/agentEngineModelCatalog.ts`（`BUILTIN_AGENT_ENGINE_MODEL_CATALOG`）已登记全部 4 个外部引擎条目，含 mimo/kimi：

| kind | defaultModel | 内置模型 |
|---|---|---|
| codex_cli | `gpt-5.5` | … |
| claude_code | `sonnet` | … |
| mimo_code | `mimo-coder` | MiMo Coder |
| kimi_code | `kimi-k2.5` | Kimi K2.5 |

> 注：计划文档 §2 说「mimo/kimi 无签名目录走直传」——as-built 是**有内置 catalog 条目**（供 UI 列出默认模型），但 run 派发仍**直传 launch.model 不走 strict resolveModelId**（catalog 仅展示用，CLI 自解析）。发布远程**签名** catalog 时须登记 mimo_code/kimi_code，否则 UI 模型列表空（运维项；默认 bundled 态无碍）。

`agentEngineModelCatalog.ts`（service）按签名 envelope 验证远程 catalog，失败回退内置；`EXTERNAL_AGENT_ENGINE_KINDS` 集合含全部 4 个外部 kind。

### 3.5 Durable 生命周期与恢复边界

四个外部 CLI 都以 `engine.kind = external_cli` 进入 Durable Run kernel，`runId` 在恢复 attempt 之间保持稳定，owner epoch 和 attempt 每次接管递增。启动命令、外部 session id、stdout/stderr cursor、cwd fingerprint 和脱敏 log reference 进入 versioned checkpoint，prompt、凭据和原始输出不进入 checkpoint。

| 引擎 | 恢复能力 | 崩溃后行为 |
|---|---|---|
| Codex CLI | `resumable` | 仅在持久化 stable thread/session id 后执行 `codex exec resume` |
| Claude Code | `resumable` | 仅在持久化 stable session id 后执行 `claude --resume` |
| MiMo-Code | `non_resumable` | `requires_review`，不重放 prompt 冒充续跑 |
| Kimi Code | `unknown` | `requires_review`，未验证前不自动重启 |

进程 exit code 只是 transport evidence。适配器只有在解析到最终正文/结果时才能返回 completed；exit 0 + 空输出统一为 failed，cancellation 优先于晚到结果。Web route 使用 `ExternalEngineDurableLifecycle.finish()` 返回的 terminal status 投影 session 状态，不维护第二套成功判定。

完整 checkpoint、resume builder、幂等 dispatch 和 terminal/trace 规则见 [External Agent Engine durable lifecycle](./external-engine-durable-lifecycle.md)。

---

## 4. Agent Engine IPC

`src/host/ipc/agentEngine.ipc.ts`，domain `IPC_DOMAINS.AGENT_ENGINE`：

| action | payload | 返回 | 说明 |
|---|---|---|---|
| `detect` | — | `AgentEngineDescriptor[]` | 「检测引擎」按钮：`registry.invalidate()` 后 `list()` 强制重探（绕 5s 缓存） |
| `list` | — | `AgentEngineDescriptor[]` | 走探测缓存 |
| `get` | `{ kind }` | `AgentEngineDescriptor` | 单引擎 |
| `listModels` | — | `AgentEngineModelCatalogResult` | 签名模型目录（codex/claude 用；mimo/kimi 有内置条目） |
| `select` | `{ sessionId, kind, permissionProfile?, model?, workingDirectory? }` | `engine`（session engine metadata） | 切引擎；external 经 `resolveModelId` 解析模型，写回 session（`allowEngineUpdate: true`） |
| `selectModel` | `{ sessionId, kind?, model }` | `engine` | 仅 external；模型须在签名 catalog 且未 `disabledReason`；native 报 `INVALID_ENGINE`（走普通 provider 设置） |
| `listHistory` / `previewHistory` | — | history import 结果 | 外部引擎会话导入 |

错误码：`INVALID_PAYLOAD` / `SESSION_NOT_FOUND` / `INVALID_ENGINE` / `MODEL_NOT_FOUND` / `MODEL_DISABLED` / `INVALID_ACTION` / `INTERNAL_ERROR`。`isExternalEngineKind` 收窄统一委托 `agentEngineGuards.isExternalAgentEngine`（单一真源）。

---

## 5. 设置页「执行引擎」section

SettingsModal 新 tab `agentEngine`（与「通用模型 provider」平级，**ModelSettings 主体未动**）。

- 注册：`SettingsModal.tsx` — tab group `{ id: 'agentEngine', label: t.engineCompat.engineSection.title }` + `{activeTab === 'agentEngine' && <AgentEngineSettings />}`
- `tabs/AgentEngineSettings.tsx` — 容器，装 `<AgentEngineListSection />` + `<AgentEngineModelCatalogSection />`
- `tabs/AgentEngineListSection.tsx` — 引擎列表区：5 引擎卡（label + 安装状态徽标 + 计费标签 `EngineBillingBadge` + 版本/binaryPath + 默认模型来源 + 登录指引 +（missing 时）安装指引）；[检测引擎] 按钮触发 `detect`（invalidate+list 强制重探）；加载失败退出 loading 态
- `tabs/agentEngineSectionHelpers.ts` — 纯展示逻辑（无 React/IO，便于单测）：`buildEngineSectionRow(descriptor, t)` → `EngineSectionRow`
  - 默认模型来源：native → `defaultModelNative`（随会话 provider）；mimo/kimi → `defaultModelCliResolved`（CLI 解析）；codex/claude → `defaultModelHint`（目录可配）
  - 计费经 `buildEngineBillingSummary`；安装徽标色板 `INSTALL_STATE_BADGE_CLASS`（builtin/installed=正向，missing=灰）
  - 外部引擎恒给 `loginHint`；仅 `missing` 给 `installHint`
- `tabs/AgentEngineModelCatalogSection.tsx` — 各外部引擎默认模型偏好（从 `listModels` 读签名目录）

数据底座统一从 `engineCompat` + 现有引擎 IPC 派生，**不在设置页重造矩阵**。

---

## 6. StatusBar 引擎切换器

`src/renderer/components/StatusBar/ModelSwitcher.tsx` + `modelSwitcherHelpers.tsx`：把「**Engine · 主任务模型 · Effort**」三层选择统一进一个 trigger。

- trigger 展示：引擎短名（`ENGINE_SHORT_LABEL`：Neo/Codex/Claude/MiMo/Kimi）+ 模型 label + effort + 引擎计费徽标（`EngineBillingBadge`，`selectedEngineBilling = buildEngineBillingSummary(engine.kind, t)`）
- 菜单第 1 层「Engine」：列 `engineDescriptors`，不可用引擎（如非 native 缺 workspace）经 `getEngineUnavailableReason` 禁用
- 外部引擎模型不在目录/被停用 → trigger 显示 `t.engineCompat.modelUnavailable`
- effort 选项：native 走 provider effort；外部引擎走 `getEngineEffortOptions(kind)`
- 修过真 bug：renderer 旧 `isExternalEngineKind` 只认 codex/claude → mimo/kimi 被当 native catalog 列不出，改判 `kind !== 'native'`

---

## 7. 文件索引

| 关注点 | 文件 |
|---|---|
| 类型契约 | `src/shared/contract/agentEngine.ts` |
| 兼容矩阵 + 计费 | `src/shared/constants/engineCompat.ts` |
| MiMo 权限常量 | `src/shared/constants/mimoCode.ts` |
| 内置模型 catalog | `src/shared/agentEngineModelCatalog.ts` |
| registry 探测 | `src/host/services/agentEngine/agentEngineRegistry.ts` |
| 适配器 | `src/host/services/agentEngine/{mimo,kimi,codex,claude}CliAdapter.ts` |
| 守卫 | `src/host/services/agentEngine/agentEngineGuards.ts` |
| catalog service | `src/host/services/agentEngine/agentEngineModelCatalog.ts` |
| IPC | `src/host/ipc/agentEngine.ipc.ts` |
| 分发 | `src/host/app/agentAppService.ts`、`src/web/routes/agent.ts` |
| 设置页 | `src/renderer/components/features/settings/tabs/AgentEngine*.tsx` + `agentEngineSectionHelpers.ts`、`SettingsModal.tsx` |
| StatusBar | `src/renderer/components/StatusBar/ModelSwitcher.tsx` + `modelSwitcherHelpers.tsx` |
| i18n | `src/renderer/i18n/{zh,en}.ts`（`engineCompat` 块） |

> **未做**（诚实清单）：① 兼容矩阵的「借壳端点」列（GLM/MiniMax/Qwen 经 Claude Code 自定义端点）未做；② 远程签名 catalog 登记 mimo_code/kimi_code 是发布期运维项；③ Kimi 完整 dogfood 需用户 `kimi login` + 会员订阅；④ MiMo 付费 token-plan 海外端点需 Clash 路由可达（已在 Singapore 端点验通）。
