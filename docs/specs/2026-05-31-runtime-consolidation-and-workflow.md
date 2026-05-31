# 2026-05-29~06-01 Runtime Consolidation and Dynamic Workflow Spec

> 状态: accepted
> 时间窗: 2026-05-29 00:00 +0800 到 2026-06-01 07:13 +0800
> 关联架构: [runtime-consolidation-2026-05-31.md](../architecture/runtime-consolidation-2026-05-31.md)、[dynamic-workflow.md](../architecture/dynamic-workflow.md)、[agent-architecture-debt-iteration-plan-2026-05-31.md](../architecture/agent-architecture-debt-iteration-plan-2026-05-31.md)

## 目标

这一批提交把 Agent Neo 的运行时能力收成六类产品合同：

1. 命令式 `workflow` 成为多 Agent 编排的一等入口，支持脚本控制流、跑前审批、进度树和显式恢复。
2. 模型 Provider 配置从“只选模型”扩展到运行时控制，包含 per-provider 并发上限和代理模式。
3. 真实 app-host 验收从零散脚本变成固定矩阵，覆盖 pause/resume、cancel、session persistence、manual compact、Agent Team 和 replay/eval。
4. 运行时边界从互相 import 的热路径拆成小端口和策略模块，`madge` / `debt:report` 成为架构门禁。
5. Prompt、subagent guidance、会话 owner scope 和 eval worktree isolation 进入回归门禁。
6. 旧入口和死代码被正式下线，后续文档和实现不得再把这些路径当 live contract。

## 非目标

- 不把命令式 `workflow` 合并进旧的声明式 `workflow_orchestrate`，两者继续并存。
- 不承诺 worker_threads 沙箱是强安全边界；当前威胁模型仍是“半信任模型代码”。
- 不把所有 smoke 变成默认 CI；付费模型、真实外部账号和 macOS 权限类验收仍按手动或 release 前执行。
- 不把旧 Delivery Review、scenario acceptance、MasterTask、legacy generation shell 或旧 TaskPanel 连接器卡片重新变成产品级数据面。

## 产品合同

### 0. 变更类型映射

| 类型 | 覆盖提交 | Spec / 架构落点 |
|---|---|---|
| Dynamic Workflow / app-host runtime | `b7b003aad`、`e155509bf` | 本文 §1/§4、[dynamic-workflow.md](../architecture/dynamic-workflow.md)、[runtime-consolidation-2026-05-31.md](../architecture/runtime-consolidation-2026-05-31.md) |
| 架构债拆分 | `ef1f903d3`、`7865d9d31`、`40844309f`、`045550674` | 本文 §6、[agent-architecture-debt-iteration-plan-2026-05-31.md](../architecture/agent-architecture-debt-iteration-plan-2026-05-31.md) |
| 死代码下线 | `a294c77e7`、`a26ff435e`、`bdc442e33`、`5f78c3c45` | 本文 §7、[runtime-consolidation-2026-05-31.md](../architecture/runtime-consolidation-2026-05-31.md) |
| Prompt / subagent / eval gates | `ca00ae696`、`1b27ea9eb`、`1616e037d`、`e14421236`、`e5d154df7`、`e0ac7df15` | 本文 §8、[agent-architecture-debt-iteration-plan-2026-05-31.md](../architecture/agent-architecture-debt-iteration-plan-2026-05-31.md) |
| Session owner scope / schema migration | `578b141b2`、`dcbfbbc21` | 本文 §9、[data-storage.md](../architecture/data-storage.md) |
| Product closure / artifact issue loop | `5600470f5`、`0c2c4d0a5`、`bb0cea2cb`、`06bed450f` | [2026-05-31-agent-neo-product-closure.md](./2026-05-31-agent-neo-product-closure.md)、[artifact-verification.md](../architecture/artifact-verification.md) |

### 1. Dynamic Workflow

| 项 | 合同 |
|---|---|
| 用户入口 | `/workflow <goal>` 触发 workflow 工具；模型也可直接调用 `workflow` 工具。 |
| 工具入参 | `script` 必填；`goal` 透传为脚本内 `args`；`budgetTokens` 是 output token 硬上限；`resumeFromRunId` 显式开启源码重放。 |
| 脚本原语 | `agent(prompt, opts?)`、`parallel(thunks)`、`pipeline(items, ...stages)`、`phase(title)`、`log(message)`、`args`、`budget`。 |
| 子 agent 模式 | `agent({ schema })` 走单轮 forced structured output；无 schema 走完整 SubagentExecutor loop。 |
| 工具档位 | `readonly` 默认；`edit` 增加 Edit/Write；`full` 增加 Bash。同一 run 内写 agent 通过 `SerialWriteGate` 串行放行；跨普通工具调用由 `WriteIsolationManager` 判定 file/workspace 冲突。 |
| 跑前审批 | `workflowLaunchApproval` 根据 AST 生成 phases、扇出点、写提示、预算和四维风险提示；headless/E2E 可自动批准。 |
| 进度反馈 | `ScriptRunEvent` 经 `workflow.ipc.ts` 专用 bridge 推到 renderer，`workflowStore` 按 runId 折叠成进度树。 |
| 恢复 | 不序列化 VM；保存脚本 hash、确定性 call index、内容 hash 和成功 agent 结果。`resumeFromRunId` 命中缓存时 0 token、无 inference、进度树标 `cached`。 |
| 终态 | `completed / failed / cancelled` 进入 run snapshot；丢失 `run:start` 时活动事件会把 pending 提升为 running。 |

### 2. 脚本安全和确定性

| 约束 | 值 / 行为 |
|---|---|
| 脚本体积 | `MAX_SCRIPT_BYTES = 64KB` |
| schema 体积 | `MAX_SCHEMA_BYTES = 16KB` |
| schema 深度 | `MAX_SCHEMA_DEPTH = 8` |
| agent 调用数 | `MAX_AGENT_CALLS_PER_RUN = 1000` |
| worker 超时 | `WORKER_TIMEOUT_MS = 30 min` |
| worker 堆上限 | `WORKER_MAX_OLD_GEN_MB = 256MB` |
| 非确定性 blocklist | 拒绝 `Date.now()`、无参 `new Date()`、`Date()`、`Math.random()`、`performance.now()` |
| 当前缺口 | worker 内 `new AsyncFunction` 仍不是强隔离；真正安全边界需要独立 isolate 或进程级沙箱单独排期。 |

### 3. Provider 运行时控制

| 项 | 合同 |
|---|---|
| `maxConcurrent` | `settings.models.providers[*].maxConcurrent` 覆盖出厂默认并发上限，保存后热更新。留空或 0 表示使用内置默认；未声明默认的 provider 不限流。 |
| 自适应降级 | 命中 429/1302 后 provider limiter 逐步降低 maxConcurrent，5 分钟无限流后回升。 |
| `proxyMode` | `auto / direct / proxy`。`auto` 按 provider 身份判断国内外；`direct` 强制直连；`proxy` 强制走全局 `HTTPS_PROXY`。 |
| 脚本并发公平 | `scriptRuntime.ConcurrencyGate` 限制全局 agent 并发，并读取 provider 有效 cap 做纯计数，防止单一 provider 占满全局槽。 |
| 责任边界 | `ConcurrencyGate` 只管全局公平；`ConcurrencyLimiter` 才管真实 provider API acquire/release。 |

### 4. App-host 验收和 dev-only 控制面

| 场景 | 固定入口 |
|---|---|
| UI cancel 到 app-host | `npm run acceptance:agent-runtime-app-host` |
| 长工具 cancel | `npm run acceptance:tool-cancel` |
| pause / resume | `npm run acceptance:pause-resume` |
| session / runtime state restart | `npm run acceptance:session-persistence` |
| manual compact | `npm run acceptance:manual-compact` |
| Agent Team dependency / cancel | `npm run acceptance:agent-team` |
| replay / eval gate | `npm run acceptance:real-agent-replay-eval` |
| admin review queue | `npm run acceptance:admin-review-queue` |
| paid provider gate | `npm run acceptance:paid-real-model-replay-eval -- --dry-run --json` 默认只做门禁；真跑必须显式 `CODE_AGENT_PAID_SMOKE=1` 和 `--manual-paid`。 |

Dev-only API 必须显式被 `CODE_AGENT_ENABLE_DEV_API=true` 或 `CODE_AGENT_E2E=1` 打开。生产默认路径不能暴露测试注入口。

### 5. Fleet Observability

| 项 | 合同 |
|---|---|
| 崩溃与错误 | renderer + node 双侧 Sentry，上传前过 `scrubEvent` 递归脱敏。 |
| LLM trace | telemetry sessions / turns / feedback 上传到 Supabase；turn 写失败时 session 不标记 synced，避免 partial-write 丢数据。 |
| Admin console | Next.js 子 app 提供 overview、users、session detail、errors、feedback 页面；Vercel SSO、Next proxy、Supabase RLS 三层 gate。 |
| 产品分析 | PostHog renderer/node no-op 初始化；distinct_id 使用 hash 后 userId；dashboard 脚本维护 3 个 dashboard / 8 个 insight。 |
| 验收 | `acceptance:telemetry-feedback-cloud`、`acceptance:posthog-dashboards[:dry-run|:verify]`、`acceptance:posthog-live-event`。 |

### 6. 架构债拆分合同

| 热路径 | 新边界 | 合同 |
|---|---|---|
| Agent runtime peer imports | `runtimePorts.ts`、`runtimeControl.ts`、`subagentExecutorPort.ts` | 高层调度只依赖端口，不反向 import 具体 runtime peer。 |
| Dynamic Workflow writes | `scriptRuntime/writeGate.ts` | workflow 内 edit/full agent 串行；abort 期间能从等待队列移除。 |
| Model fallback policy | `modelRouterPolicy.ts`、`modelRouterTimeouts.ts`、`modelCapabilities.ts` | provider fallback、artifact fallback、timeout 和 capability 判断是纯策略函数，`modelRouter` 只编排。 |
| Provider helpers | `providerHttp.ts`、`providerJson.ts`、`providerResponseParsers.ts` | HTTP / JSON / response parsing 从 provider shared 大文件拆出。 |
| App-host agent route | `agentRunController.ts`、`agentRunEventCollector.ts` | SSE 写入、terminal event 去重、disconnect cancel、session status 更新从 route 文件拆出。 |
| Dev seed routes | `devSeedHelpers.ts` | `dev.ts` 与 telemetry seed route 不再互相 import。 |
| Message telemetry | `messageProcessorTelemetry.ts` | message processor 的 telemetry 记录单独隔离，主处理器只负责流程。 |

这些边界的验收门槛是 `madge` 无环、`debt:report` 无未豁免超阈值文件，以及对应策略/端口单测通过。

### 7. 已下线入口

| 旧入口 / 模块 | 当前状态 | 后续替代口径 |
|---|---|---|
| legacy generation shell scripts | 已删除 | CLI / eval / acceptance 走当前命令树和固定 smoke。 |
| legacy file/shell tool wrappers under `src/main/tools/file` / `src/main/tools/shell` | 已删除 | native ToolModule `schema / registry / handler` 是唯一 live 工具实现路径。 |
| MasterTask remnants | 已删除 | session tasks、TaskManager-owned run、Run Status Rail。 |
| dead worker subsystem / `teamManager` | 已删除 | SubagentExecutor、ParallelAgentCoordinator、Agent Engine adapter。 |
| `AcceptanceRunner` / `scenarioAcceptance` | 保留为 legacy / checker-level 合同，不再是产品级质量数据面 | 生成物质量进入 `ArtifactIssue`、`EvalReplayQualityReport` 和 admin review queue；kind-specific verifier 可作为 issue 证据来源。 |
| `TaskPanel/ConnectorsCard` | 已删除 | InlineWorkbenchBar、TaskMonitor 能力信息区、Settings Capability Center。 |
| 装饰器式工具声明实验 | 已删除 | native module `schema / registry / handler` 是唯一 live 工具定义范式。 |
| 旧 cloudStorageService / sync 测试残留 | 已删除 | 当前 cloud 边界以 config、update、feature flag、telemetry upload 和 Supabase sync 为准。 |
| 旧 research aggregator / search fallback | 已删除 | 当前研究能力走 live tool + prompt policy，后续若重建要按新 contract 重新设计。 |
| 旧 renderer 诊断面板和 utils | 已删除 | Chat 主链路、TaskPanel、Workspace Preview、Settings Capability Center 保留当前产品入口。 |

### 8. Prompt / subagent / eval 门禁合同

| 项 | 合同 |
|---|---|
| Prompt wording | 提示词不得继续引用旧工具名、旧 edit 参数、旧 plan/task API 或裸 `<think>` 标签；`scripts/prompt-stale-scan.ts` 是静态门禁。 |
| Real prompt smoke | `.claude/test-cases/20-prompt-real-smoke-tests.yaml` 覆盖 Read / Write / Edit / Grep / ToolSearch / Task / Git status 七类低成本真实模型路径。 |
| Subagent guidance | `spawn_agent` 和 core agent prompt 要明确 Task / ToolSearch / file tool 的当前调用方式；subagent 不能拿旧工具名当 live contract。 |
| Legacy workflow roles | 旧 `workflow_orchestrate` role 归一后仍能跑 compatibility path，但不得抢 `/workflow` 的默认复杂任务口径。 |
| Eval worktree isolation | eval 写文件路径要被工作树隔离测试守住，避免 prompt smoke 或 fixture 污染真实仓库。 |

### 9. Session owner scope / schema migration 合同

| 项 | 合同 |
|---|---|
| session owner scope | 会话列表、读取、更新、删除、消息读取和 cache 命中都按当前 auth user 过滤；未登录只读 `user_id IS NULL` 的本机会话。 |
| web response hygiene | session 返回给 web client 前移除 provider apiKey；DB 持久化只保留 provider/model 等非密钥配置。 |
| experiment schema | `experiments` 表先创建，再幂等迁移 `git_commit`，避免空库初始化时迁移顺序失败。 |
| telemetry prompt backfill | 缺失 user prompt 时可从 telemetry_turns 回填到 messages，但仍按 session owner 读取。 |

## 数据和 IPC 合同

| 合同 | 位置 | 说明 |
|---|---|---|
| `workflow_runs` | `src/main/services/core/database/schema.ts` | run 元数据、脚本 hash、goal、sessionId、终态、tokens、result/error。 |
| `workflow_run_calls` | `src/main/services/core/database/schema.ts` | 成功 agent 调用缓存，复合键 `(run_id, call_index)`，另存 `content_hash`。 |
| `ScriptRunEvent` | `src/shared/contract/scriptRun.ts` | main 和 renderer 共享的 run event 可序列化契约。 |
| `WorkflowLaunchEvent` | `src/shared/contract/scriptRun.ts` | 跑前审批卡事件。 |
| `workflow:event` | `src/main/ipc/workflow.ipc.ts` | run 进度推送通道。 |
| `workflow:launch:event` | `src/main/ipc/workflow.ipc.ts` | 审批事件推送通道。 |
| `workflow:approve-launch` / `workflow:reject-launch` | `src/main/ipc/workflow.ipc.ts` | renderer 回写审批结果。 |
| `ModelProviderSettings.maxConcurrent` | `src/shared/contract/settings.ts` | per-provider 并发上限。 |
| `ModelProviderSettings.proxyMode` | `src/shared/contract/settings.ts` | per-provider 代理模式。 |
| `artifact_issues` / `artifact_issue_evidence` | `src/main/services/core/database/schema.ts` | 生成物质量问题、证据引用、admin review 状态。 |
| `eval_replay_quality_reports` | `src/main/services/core/database/schema.ts` | replay/eval 的产品级质量报告。 |

## 验收矩阵

| 改动类型 | 必跑 |
|---|---|
| Dynamic Workflow runtime / IPC / UI | `npm run typecheck`；`npx vitest run tests/unit/agent/scriptRuntime/*.test.ts tests/unit/agent/workflowLaunchApproval.test.ts tests/renderer/stores/workflowStore.test.ts tests/unit/contract/scriptRun.test.ts tests/unit/tools/modules/multiagent/workflow.test.ts`；必要时补 `workflow-progress-tree-e2e.cjs`、`workflow-launch-card-e2e.cjs`、`workflow-trigger-e2e.cjs`。 |
| Provider 并发 / 代理 | `npx vitest run tests/unit/model/concurrencyLimiter.test.ts tests/unit/model/aiSdkAdapterSupport.test.ts tests/unit/model/aiSdkAdapterProviderOptions.test.ts`；手动核对应 provider 连通性。 |
| App-host runtime | `npm run acceptance:agent-runtime-app-host`、`npm run acceptance:pause-resume`、`npm run acceptance:tool-cancel`、`npm run acceptance:session-persistence`，按触发条件补矩阵其它项。 |
| Observability / admin | `npm run acceptance:telemetry-feedback-cloud -- --json`；`npm run acceptance:posthog-dashboards:dry-run`；有线上 key 时跑 verify/live-event。 |
| 旧入口删除 | `npm run typecheck`；`npm run debt:report -- --skip-eslint --limit 15`；`npm run release:security-scan`；按删除面补定向 import/test 扫描。 |
| Prompt / subagent / eval gates | `npm run eval:prompt-gate`；`npx vitest run tests/unit/prompts/promptRegression.test.ts tests/unit/agent/multiagentTools/workflowOrchestrate.legacy.test.ts tests/unit/tools/modules/file/append.test.ts tests/unit/tools/modules/file/multiEdit.test.ts tests/unit/tools/modules/file/write.test.ts`。 |
| Product closure / admin review | `npm run acceptance:product-closure`；`npm run acceptance:pause-resume`；`npm run acceptance:admin-review-queue`。 |

## 开放风险

- `workflow` 的真实安全边界还没到 isolate 级别，不能承载对抗式不可信脚本。
- 写能力 agent 共享工作树，当前只提示风险；需要真并发写时，应设计 per-agent worktree 或文件锁。
- paid model smoke 不能进默认自动化，release 前需要人确认 key、模型和成本参数。
- 旧生成物质检能力已删，未来要做时从 artifact issue / evidence graph 重新建，不沿用 scenario acceptance。
