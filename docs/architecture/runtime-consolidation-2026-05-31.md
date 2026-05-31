# Runtime Consolidation Architecture Snapshot

> 日期: 2026-06-01
> 覆盖提交: 2026-05-29 00:00 +0800 到 2026-06-01 07:13 +0800
> 关联 spec: [2026-05-31-runtime-consolidation-and-workflow.md](../specs/2026-05-31-runtime-consolidation-and-workflow.md)、[2026-05-31-agent-neo-product-closure.md](../specs/2026-05-31-agent-neo-product-closure.md)

这份快照记录两天提交后的 as-built 架构边界。它不替代各子系统长文档，只把新增运行时、模型控制、验收面和删除后的新归属放在一张图里。

## 总览

```
用户 / 模型
  │
  ├─ /workflow <goal> / workflow tool
  │     │
  │     ▼
  │  workflowLaunchApproval ── scriptPreview ── workflow:launch:event
  │     │ approve/reject
  │     ▼
  │  workflow tool ── startRun(spec, deps)
  │     │
  │     ▼
  │  scriptRuntime/runService
  │     ├─ sandbox(worker_threads): agent / parallel / pipeline / phase / log / budget
  │     ├─ primitives RPC
  │     ├─ agentBridge: forced schema call or full SubagentExecutor loop
  │     ├─ ConcurrencyGate: global fairness + provider cap
  │     ├─ SerialWriteGate: per-run edit/full agent serialization
  │     └─ WorkflowJournalRepository: source replay + result cache
  │
  ├─ Chat / AgentLoop / Agent Team / CLI / Web API
  │     ├─ app-host lifecycle routes: pause / resume / cancel / background / foreground
  │     ├─ runtime smoke hooks under CODE_AGENT_E2E or CODE_AGENT_ENABLE_DEV_API
  │     └─ telemetry / replay / eval evidence
  │
  └─ Settings Model tab
        ├─ maxConcurrent -> ConfigService -> ConcurrencyLimiter -> ConcurrencyGate read
        └─ proxyMode -> ConfigService -> getHttpsAgent provider override

Renderer
  ├─ WorkflowLaunchCard
  ├─ WorkflowInlineMonitor / WorkflowPanel
  └─ workflowStore: ScriptRunEvent -> ScriptRunSnapshot

Admin / Observability
  ├─ Sentry: scrubEvent before upload
  ├─ Supabase telemetry sessions / turns / feedback
  ├─ PostHog dashboards and live event smoke
  ├─ ArtifactIssueRepository: artifact issues + eval replay quality reports
  └─ admin review queue: allow_release / request_changes decisions
```

## 模块归属

| 模块 | Owner | 职责 |
|---|---|---|
| `src/main/tools/modules/multiagent/workflow.ts` | 命令层入口 | 把 ToolContext 转成 `ScriptRunHostDeps`，校验入参，启动或恢复 run。 |
| `src/main/agent/scriptRuntime/runService.ts` | workflow runtime | 多 run 隔离、预算、journal 网关、cancel/get state。 |
| `src/main/agent/scriptRuntime/sandbox.ts` | workflow runtime | worker_threads 沙箱和脚本原语 stub。 |
| `src/main/agent/scriptRuntime/primitives.ts` | workflow runtime | worker RPC dispatcher，转发 agent/phase/log。 |
| `src/main/agent/scriptRuntime/agentBridge.ts` | workflow runtime | forced schema 单轮判断和完整 SubagentExecutor 两条路径。 |
| `src/main/agent/scriptRuntime/concurrencyGate.ts` | workflow runtime | run 内全局并发公平，读取 provider 有效 cap。 |
| `src/main/agent/scriptRuntime/writeGate.ts` | workflow runtime | 同一 run 内 edit/full agent 串行放行，并支持 queued abort。 |
| `src/main/agent/runtime/runtimePorts.ts` | agent runtime | 用端口替代 runtime peer 之间的直接反向依赖。 |
| `src/main/agent/runtime/runtimeControl.ts` | agent runtime | ToolExecutionEngine 与 runtime cancel/control 的窄接口。 |
| `src/main/agent/subagentExecutorPort.ts` | multiagent runtime | ParallelAgentCoordinator / DAGScheduler 依赖的 subagent 执行端口。 |
| `src/main/agent/workflowLaunchApproval.ts` | approval gate | 跑前审批请求、自动批准策略和 pending resolver。 |
| `src/main/ipc/workflow.ipc.ts` | IPC | workflow run 和 launch 的专用 renderer bridge。 |
| `src/shared/contract/scriptRun.ts` | shared contract | 可序列化 run event、launch event、snapshot reducer。 |
| `src/renderer/stores/workflowStore.ts` | renderer state | 按 runId/sessionId 管理进度树。 |
| `WorkflowJournalRepository` | data | `workflow_runs` 与 `workflow_run_calls` 的持久化和缓存查询。 |
| `ConfigService.applyProviderConcurrencyOverrides` | settings runtime | 将 UI 保存的 provider 并发覆盖热更新到 limiter。 |
| `ConfigService.applyProviderProxyOverrides` | settings runtime | 将 UI 保存的 provider 代理模式热更新到 provider shared layer。 |
| `src/main/model/modelRouterPolicy.ts` | model runtime | provider fallback、artifact fallback 和 retry 判断的纯策略层。 |
| `src/main/model/providers/providerHttp.ts` / `providerJson.ts` / `providerResponseParsers.ts` | model runtime | provider HTTP、JSON 和响应解析 helper。 |
| `src/web/routes/agentRunController.ts` | web app-host | SSE 写入、terminal 去重、disconnect cancel、session status 更新。 |
| `src/web/routes/agentRunEventCollector.ts` | web app-host | active run event 收集和 replay/eval 证据聚合。 |
| `src/web/routes/background.ts` | web app-host | move-to-background / move-to-foreground 控制面。 |
| `src/web/routes/adminReviewQueue.ts` | web app-host | artifact issue 的 admin review queue API。 |
| `src/main/services/core/repositories/ArtifactIssueRepository.ts` | data / release gate | artifact issue、evidence refs、quality report、admin review 决策。 |

## Workflow 执行流

1. 触发: 用户输入 `/workflow <goal>`，或模型直接调用 `workflow` 工具。
2. 预览: `scriptPreview.ts` 用 AST 计算 phase、agent 调用点、fanout 位置和写能力提示。
3. 审批: `workflowLaunchApproval` 发 `WorkflowLaunchEvent`，renderer 展示 `WorkflowLaunchCard`。headless/E2E 可跳过人工确认。
4. 启动: `workflow.ts` 调 `startRun(spec, deps)`，runService 创建 runId、预算器、journal 和 worker。
5. 执行: worker 内脚本调用原语，主线程 RPC 到 `agentBridge`。有 schema 时走 forced structured output；无 schema 时直连 SubagentExecutor。
6. 并发: `ConcurrencyGate` 先按 global max 和 provider cap 放行，真实 provider API 调用仍由模型层 `ConcurrencyLimiter` acquire/release。
7. 写隔离: edit/full agent 先过 `SerialWriteGate`；普通工具层写/执行再过 `WriteIsolationManager` 的 file/workspace 冲突判断。
8. 展示: run event 经 `workflow.ipc.ts` 推到 renderer，`applyScriptRunEvent` 折叠成 snapshot。
9. 结束: runService 写终态、tokens、result/error；成功的 agent 调用写入 `workflow_run_calls`。

## Resumable 架构

恢复策略是“源码重放 + 调用结果缓存”：

- run 级别保存 `script_hash`、goal、sessionId、终态和 token 花费。
- call 级别保存 `call_index`、`content_hash`、label、结果和 token。
- `resumeFromRunId` 只读取旧 run 的成功调用缓存。新脚本从头执行；同 index 且同内容 hash 的 `agent()` 直接返回缓存结果。
- journal 不依赖 session FK，方便跨会话审计和显式恢复。

这个设计避免序列化 worker/VM 状态，但要求脚本控制流确定。`scriptValidator` 因此阻断常见时间和随机源。

## Provider 控制流

```
ModelSettings UI
  │ save settings
  ▼
ConfigService.update()
  ├─ applyProviderConcurrencyOverrides()
  │    └─ setProviderConcurrencyOverrides()
  │         ├─ existing limiter hot update
  │         └─ getEffectiveProviderConcurrency()
  │              └─ scriptRuntime ConcurrencyGate 读取 cap
  │
  └─ applyProviderProxyOverrides()
       └─ setProviderProxyOverrides()
            └─ getHttpsAgent(targetUrl, provider)
                 ├─ direct: no proxy
                 ├─ proxy: force HTTPS_PROXY
                 └─ auto: providerNeedsProxy + direct-connect host exceptions
```

两层并发控制的边界很重要：

- `ConcurrencyGate` 属于 workflow runtime，只做 run 内全局公平，防止 provider 饥饿。
- `ConcurrencyLimiter` 属于模型层，保护真实 provider API；命中限流后自适应降级，恢复期再回升。

## App-host 验收面

`src/web/routes/dev.ts` 在这轮被拆出若干 dev-only route，agent runtime 相关 smoke 统一走 app-host：

| 能力 | 入口 | 守门 |
|---|---|---|
| renderer cancel 到 active loop | `acceptance:agent-runtime-app-host` | `CODE_AGENT_ENABLE_DEV_API=true` |
| pause / resume | `POST /api/pause`、`POST /api/resume` | active loop 存在且实现对应方法 |
| 长工具 cancel | `acceptance:tool-cancel` | app-host API +真实 Bash/http_request |
| restart persistence | `acceptance:session-persistence` | 固定 `CODE_AGENT_DATA_DIR` |
| manual compact | `acceptance:manual-compact` | `/api/context/compact-current` |
| Agent Team | `acceptance:agent-team` | app-host dev harness |
| replay / eval | `acceptance:real-agent-replay-eval` | telemetry + structured replay |
| pause / resume / background | `acceptance:pause-resume` | active loop + background task manager |
| admin review queue | `acceptance:admin-review-queue` | artifact issue repository + admin review routes |

生产默认启动不打开这些测试注入口。

## Observability 面

Fleet observability 现在分三条链：

| 链 | 数据 | UI / 验收 |
|---|---|---|
| Crash / error | Sentry event，上传前递归脱敏 | `admin-console/app/errors/page.tsx` |
| LLM trace / feedback | Supabase telemetry sessions / turns / feedback | `admin-console/app/sessions/[id]`、`admin-console/app/feedback/page.tsx` |
| Product analytics | PostHog event 和 dashboard | `posthog-dashboards.py`、`posthog-live-event-smoke.py` |
| Artifact quality gate | `artifact_issues`、`artifact_issue_evidence`、`eval_replay_quality_reports` | `/api/admin/review-queue`、`acceptance:admin-review-queue` |

Admin 访问边界保持三层：Vercel SSO、Next proxy、Supabase RLS。app-host 的 admin review queue 是本地验收和 release gate 控制面，不替代云端 admin-console。

## 已删除边界和新归属

| 删除项 | 删除原因 | 新归属 |
|---|---|---|
| legacy generation shell | 入口和当前 CLI / eval / acceptance 命令重叠 | 当前 CLI 命令树、eval CI、acceptance scripts。 |
| MasterTask | 状态模型与当前 session/task/runtime ownership 重叠 | TaskManager-owned chat run、session tasks、Run Status Rail。 |
| dead worker subsystem / `teamManager` | 未接入 live runtime | SubagentExecutor、ParallelAgentCoordinator、Agent Engine。 |
| `AcceptanceRunner` / `scenarioAcceptance` | checker-level 代码仍存在，但产品级 DB/UI 质量数据面已迁走 | `ArtifactIssue` / `EvalReplayQualityReport` / admin review queue。 |
| `TaskPanel/ConnectorsCard` | 展示全局能力清单，和当前任务语义错位 | InlineWorkbenchBar、TaskMonitor 能力区、Capability Center。 |
| decorator tool framework | 未进入 registry，形成第二套定义范式 | native ToolModule `schema / registry / handler`。 |
| `cloudStorageService` | 旧同步残留，无 live 引用 | Supabase sync、telemetry upload、cloud config/update。 |
| legacy file/shell wrappers | 与 native ToolModule 重叠，容易让 prompt 和实现分叉 | `src/main/tools/modules/*` native handlers。 |
| old research aggregation helpers | 未接入 live runtime | 当前研究能力由 prompt policy + current tools 组合承载。 |
| stale renderer diagnostic panels | 未进入当前 Workbench/TaskPanel 信息架构 | Chat 主链路、TaskPanel、Workspace Preview、Settings。 |

## 风险和后续

- workflow 写能力并发仍共享工作树；需要真实并行写时，要补 worktree 隔离或文件锁。
- 当前写隔离是进程内串行和冲突判断，不能替代 per-agent git worktree。
- worker_threads 沙箱不能当作对抗式安全边界；`isolated-vm` 或进程级沙箱应单独设计。
- provider `proxyMode=proxy` 会强制走全局代理，排障时要同时检查 provider 身份、baseUrl 和 env。
- 删除旧质检 runner 后，生成物自动质检要从 artifact issue / evidence graph 重新设计，不沿用旧 scenario contract。

## 相关文档

- [Dynamic Workflow](./dynamic-workflow.md)
- [Agent Runtime Smoke Matrix](../acceptance/agent-runtime-smoke-matrix.md)
- [Fleet Observability](./observability.md)
- [Data Storage](./data-storage.md)
- [IPC Channels](./ipc-channels.md)
- [Redundancy Audit](../audits/2026-05-30-redundancy-audit.md)
