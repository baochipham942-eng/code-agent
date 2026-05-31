# Dynamic Workflow — 命令式脚本编排运行时

> 核心代码：`src/main/agent/scriptRuntime/`（运行时）+ `src/main/tools/modules/multiagent/workflow.ts`（命令层入口）
>
> 上线：2026-05-29 ~ 05-30，P1→P4 四阶段，已合入 `origin/main`（feature 线 44 commit）。
> 关联：[多 Agent 编排](./multiagent-system.md)、[IPC 通道](./ipc-channels.md)、[数据存储](./data-storage.md)。

## 1. 定位：声明式 DAG → 命令式脚本运行时

Code Agent 此前已有三层多 Agent 基建（详见 [multiagent-system.md](./multiagent-system.md)）。其中最高层的 `workflow_orchestrate` 工具是**声明式 stage-DAG**：模型选 built-in 模板或 `custom` 给 `stages[]{name,role,prompt,dependsOn}` + `parallel` flag，运行时按依赖图执行。

`dynamic-workflow` 是新增的**第 4 条多 Agent 路径**，复刻 Claude Code 的 Workflow 模型——模型**当场写一段 JS 编排脚本**，脚本自己持有 `loop / branch / 中间结果`，在受限 worker 沙箱里后台确定性执行，扇出几十上百个子 agent 做对抗验证 / 流水线 / 调研。**两条路径并存**：声明式适合固定模板，命令式适合需要代码级控制流的复杂编排。

| 维度 | 声明式 `workflow_orchestrate` | 命令式 `workflow`（本文档） |
|------|------------------------------|----------------------------|
| 模型契约 | 选模板 / 填 `stages[]` | 当场写 JS 脚本字符串 |
| 控制流 | 运行时按 DAG 跑 | 脚本自持 loop/branch/中间变量 |
| 中间结果 | 注入下游 prompt | 留在脚本变量，**不进主 context** |
| 隔离 | swarm 单 active run | runService 多 run 隔离 |
| 恢复 | checkpoint | 源码重放 + agent 结果缓存（resumable）|

> **谁持有计划**：脚本（workflow）vs 模型逐轮（subagent / spawn_agent）vs 指令（skill）。三者是不同的编排责任归属，不互相替代。

## 2. 原语 API

模型在脚本里能直接用的 5+1 原语（worker 沙箱内已注入作用域，`await` 异步、`return` 最终结果）：

| 原语 | 语义 | 备注 |
|------|------|------|
| `agent(prompt, opts?)` | 扇出一个子 agent | `opts`: `schema` / `model` / `tools` / `phase` / `label`。**带 `schema`=单轮 forced tool_choice**（只取结构化判断值，不跑 agent loop）；**无 `schema`=完整 SubagentExecutor execute loop**（真工具 dispatch） |
| `parallel(thunks)` | **栅栏**：等全部完成 | 用于需要聚合全部结果的场景 |
| `pipeline(items, ...stages)` | **无栅栏**（默认）：每 item 独立流过所有 stage | A 在 stage3 时 B 还能在 stage1，吞吐更高 |
| `phase(title)` | 标记阶段，进度树分组 | 运行时收集，**不引入 `export const meta`** |
| `log(msg)` | 进度日志 | 落 run:log 事件 |
| `args` | `goal` 字符串 | 命令层传入 |
| `budget` | token 预算 | `budget.total`(number\|null) / `spent()` / `remaining()`；`budgetTokens` 入参设硬上限，耗尽后 `agent()` 抛错 |

`agent({tools})` 三档工具 profile（`toolProfiles.ts`），默认最小权限：

| Profile | 工具集 | 场景 |
|---------|--------|------|
| `readonly`（默认） | WebSearch / WebFetch / Read / Glob / Grep | 调研、审计 |
| `edit` | readonly + Edit / Write | 改文件 |
| `full` | edit + Bash | 迁移、跑命令 |

> 写能力档（edit/full）会进入 `SerialWriteGate`：同一 workflow run 内写 agent 串行放行，排队期间响应 abort。跨 run / 跨普通工具调用的写冲突由 `ToolExecutor` 的 workspace/file write isolation 兜底。

## 3. 架构分层

```
模型在 /workflow 触发时写 JS 脚本
        │  script 参数
        ▼
┌──────────────────────────────────────────────────────────────┐
│ 命令层  src/main/tools/modules/multiagent/workflow.ts          │
│   把 protocol ToolContext 桥接成 ScriptRunHostDeps             │
│   入参：script(必填) / goal / budgetTokens / resumeFromRunId  │
└──────────────────────────────────────────────────────────────┘
        ▼  startRun(spec, deps)
┌──────────────────────────────────────────────────────────────┐
│ runService.ts —— 多 run 隔离（破 swarm 单 active run 假设）    │
│   activeRuns / startRun / cancelRun / getRunState             │
│   journal 网关（resumable）+ BudgetTracker（per-run）         │
└──────────────────────────────────────────────────────────────┘
        ▼
┌──────────────────────┐   RPC   ┌──────────────────────────────┐
│ sandbox.ts           │◀───────▶│ primitives.ts（主线程 RPC     │
│ worker_threads 沙箱  │         │ dispatcher：agent/phase/log） │
│ new Worker(code,     │         └──────────────────────────────┘
│   {eval:true})       │                    ▼
│ 5 原语 stub +        │         ┌──────────────────────────────┐
│ parallel 栅栏 /      │         │ agentBridge.ts               │
│ pipeline 链式 +      │         │  runAgentCall 两路：          │
│ 危险全局 shadow +    │         │   schema → 单轮 forced        │
│ 超时/内存 terminate  │         │   无 schema → SubagentExecutor│
└──────────────────────┘         │  **直连 executor**，绕开      │
                                 │  spawn_agent/workflowOrchestr-│
                                 │  ate/parallelCoord/cowork     │
                                 │  四条会灌历史的高层入口        │
                                 └──────────────────────────────┘
                                            ▼
                                 ┌──────────────────────────────┐
                                 │ concurrencyGate.ts            │
                                 │  provider-aware 全局并发闸     │
                                 │  确认 provider capacity 后     │
                                 │  再占全局槽，防 zhipu/3 饿死   │
                                 └──────────────────────────────┘
                                            ▼
                                 ┌──────────────────────────────┐
                                 │ writeGate.ts                  │
                                 │  edit/full agent 串行写闸       │
                                 │  abort 时移除等待队列           │
                                 └──────────────────────────────┘
```

facade：`src/main/agent/scriptRuntime/index.ts` 导出 `startRun / cancelRun / getRunState / ScriptRunHostDeps / ScriptRunJournal / ConcurrencyGate`。

## 4. 四阶段实现

### P1 地基（运行时核心）

- **forced tool_choice 结构化输出**：`InferenceOptions.toolChoice` 透传到 aiSdkAdapter（`{type:'tool',toolName}`），`agent({schema})` 走单轮 forced 取 `ToolCall.arguments`——命令式控制流的 `if/while` 靠**稳定结构化值**，不依赖模型自然语言。
- **worker_threads 沙箱**：`new Worker(WORKER_SOURCE, {eval:true})` 跑字符串常量（无独立 bundle 文件，规避打包路径陷阱）；`require/process/fs/net` 不在作用域；超时 + 内存上限 terminate。
- **直连 subagentExecutor**：`agent()` 绕开 4 条会把上下文灌回 prompt 的高层入口，保证「中间结果不进主 context」。
- **多 run 隔离**：runService 自持 activeRuns，不复用 swarm 单 active-run EventEmitter（ADR-009/010 明写 swarm 同时刻只允许一个 active run）。

### P2 能用性

- **输入加固**（`scriptValidator.ts`）：体积上限 64KB（`new AsyncFunction(...)` 编译式校验，与 worker 环境逐字一致）+ acorn AST 拒动态 `import` + forced schema 校验（对象型/`$ref` 拒绝/JSON 16KB 上限/深度≤8/循环检测）。
- **token budget**（`budget.ts` `BudgetTracker`）：按 outputTokens 计；reserve/commit 并发预留模型（`reserveOrThrow` 原子 check+reserve 消 TOCTOU）；worker 暴露只读 `budget`。
- **三档工具 profile**（`toolProfiles.ts`，见 §2）+ `SerialWriteGate` 串行写护栏。

### P3 UI（进度树 / 审批卡 / 触发入口）

- **进度树**：`workflowStore.ts` 按 runId 分桶 + `WorkflowInlineMonitor.tsx`（挂 ChatView）/ `WorkflowPanel.tsx`（独立面板，≈ Claude Code `/workflows`）。view-model `ScriptRunSnapshot / ScriptRunAgentSnapshot` + `applyScriptRunEvent` 纯函数 reducer（5 态状态机 `queued/running/done/error/skipped`）。
- **跑前审批卡**（`workflowLaunchApproval.ts` + `WorkflowLaunchCard.tsx`）：`scriptPreview.ts` AST 静态抽取 `phase()` / 扇出量 / 写提示 → `WorkflowLaunchRequest` + 4 维度成本提示（费用/网络/上下文泄露/后台占用）。headless 自动批准。
- **触发入口**：gen8 prompt carve-out——`/workflow <goal>` 路由到 workflow **工具**（不走 Skill），SlashCommandPopover 加入口预填。**MVP 不做 ultracode 全托管**。
- **专用 IPC bridge**（`workflow.ipc.ts`）：镜像 swarm 的专用 bridge（webServer 不起通用 EventBridge），按 `BusEvent.type` 前缀路由 `launch:*` / run 事件到两个通道。

### P4 Resumable（源码重放 + 结果缓存）

- **不序列化 VM 状态**：存脚本 hash + 确定性 call-id + agent 结果缓存 + phase 日志，从头重放，已完成 `agent()` 命中缓存 0 token（= Claude Code 做法）。
- **确定性加固**：`validateScript` 拦 `Date.now()` / 无参 `new Date()` / `Math.random()` / `performance.now()`（放行 `new Date(arg)`/`Math.floor`）——非确定性源破坏重放。
- **缓存键 hybrid**：位置序 `callIndex` + prompt/语义 opts 内容 hash（排除 label/phase 显示字段）。
- **存储**：专用 SQLite 表 `workflow_runs` / `workflow_run_calls`（`WorkflowJournalRepository`，见 [data-storage.md](./data-storage.md)）；`resumeFromRunId` 显式入参（非自动检测）；进度树 `cached` 徽章。

## 5. 安全边界

| 项 | 现状 |
|----|------|
| 威胁模型 | **半信任模型代码**（非对抗者）：模型可能写 bug，但不假设它蓄意越狱 |
| 沙箱 | worker_threads（`eval:true`）+ `require/process/fs` shadow + 超时/内存上限 |
| 写隔离 | workflow run 内用 `SerialWriteGate` 串行 edit/full agent；跨工具调用由 `WriteIsolationManager` 统一判断 file/workspace 冲突 |
| ⚠️ 已知缺口（延后） | worker 用 `new AsyncFunction` 跑脚本 → 字符串求值（`eval`/`Function`/`.constructor` walk）能拿回 worker globalThis/process，readonly 档也挡不住本地访问 |
| ❌ 已证伪的修法 | `vm.createContext` no-codegen **挡不住** `host函数.constructor` walk（node 官方明言 vm 不是安全边界，已删分支） |
| 唯一真边界 | `isolated-vm`（独立 v8 isolate，host 对象跨不过去）——代价是原生编译 + 打包链变重，**单独排期** |
| 重放安全 | 禁 Date/Math 覆盖主要非确定性源；裸 `Promise.race` 等时序反应仍非重放安全（CC 同限制） |

## 6. 常量（`src/shared/constants/scriptRuntime.ts`）

| 常量 | 值 | 说明 |
|------|-----|------|
| `GLOBAL_MAX_CONCURRENCY` | 16 | 一次 run 同时在途 agent() 总数（provider-aware 分配见 ConcurrencyGate）|
| `WORKER_TIMEOUT_MS` | 30 min | worker 整体执行超时 |
| `WORKER_MAX_OLD_GEN_MB` | 256 | worker old-gen 堆上限 |
| `MAX_AGENT_CALLS_PER_RUN` | 1000 | 失控脚本兜底（对齐 CC）|
| `MAX_SCRIPT_BYTES` | 64 KB | 脚本源码体积上限 |
| `MAX_SCHEMA_BYTES` | 16 KB | forced schema JSON 上限 |
| `MAX_SCHEMA_DEPTH` | 8 | forced schema 嵌套深度上限 |

## 7. 文件清单

| 文件 | 职责 |
|------|------|
| `src/main/agent/scriptRuntime/index.ts` | 对外 facade |
| `…/runService.ts` | 多 run 隔离 + journal 网关 + budget |
| `…/sandbox.ts` | worker_threads 沙箱 + 5 原语 stub + parallel/pipeline 组合 |
| `…/primitives.ts` | 主线程 RPC dispatcher |
| `…/agentBridge.ts` | `runAgentCall` 两路 + 结果缓存 + 缓存键 hash |
| `…/concurrencyGate.ts` | provider-aware 全局并发闸 |
| `…/writeGate.ts` | edit/full agent 串行写护栏 |
| `…/budget.ts` | `BudgetTracker`（reserve/commit）|
| `…/scriptValidator.ts` | 输入加固 + forced schema 校验 + 确定性 AST 走查 |
| `…/scriptPreview.ts` | 审批卡用 AST 静态预览（phases/扇出/写提示）|
| `…/toolProfiles.ts` | readonly/edit/full 三档 |
| `…/types.ts` | 运行时类型 |
| `src/main/tools/modules/multiagent/workflow.ts(.schema.ts)` | 命令层工具入口（工具名 `workflow`）|
| `src/main/agent/workflowLaunchApproval.ts` | 跑前审批闸 |
| `src/main/ipc/workflow.ipc.ts` | 专用 IPC bridge（run + launch 双通道）|
| `src/main/services/core/repositories/WorkflowJournalRepository.ts` | resumable journal |
| `src/shared/contract/scriptRun.ts` | 事件 / 快照 / 审批契约（renderer+main 共用）|
| `src/shared/constants/scriptRuntime.ts` | 运行时常量 |
| `src/renderer/components/features/workflow/*` | InlineMonitor / LaunchCard / Panel |
| `src/renderer/stores/workflowStore.ts` | 进度树 store |

## 8. 验证方法（webServer headless E2E）

```bash
npm run build:renderer && npm run build:web
set -a; . ~/.code-agent/.env; set +a
CODE_AGENT_E2E=1 WEB_PORT=8190 node dist/web/webServer.cjs &   # E2E hook 必须开 CODE_AGENT_E2E
node scripts/acceptance/workflow-{progress-tree,launch-card,trigger}-e2e.cjs
lsof -ti:8190 | xargs kill                                     # 按 PID 杀，禁 pkill -f webServer.cjs
```

- 真模型 E2E（mimo 直连，**别加 HTTPS_PROXY**）：`script-runtime-{deepresearch,budget,fullagent,resume}-e2e.ts`，esbuild bundle 后跑。
- 零 token 真 worker：`scripts/acceptance/script-runtime-sandbox-smoke.ts`。
- 全程 TDD + 每阶段 Codex 4 轮对抗审计收敛（报告见 `docs/audits/2026-05-29-*-workflow-*.md`）。

## 9. 对比借鉴：pi-dynamic-workflows

与 `github.com/Michaelliv/pi-dynamic-workflows` 同源（都复刻 Anthropic CC Workflow，原语 `agent/parallel/pipeline/phase/log/budget` + 确定性 blocklist 一致）。差在工程深度：pi 是 6 文件第三方原型（不做 resumable/manager），Neo 是内置一流公民建在三层 multi-agent 栈上。Neo 已超出 pi 的点：worker_threads 沙箱（vs pi 的 node:vm）/ 真 per-call model 路由 / provider-aware 并发闸 / 多 run 隔离 / 直连 executor 绕 context 注入。从 pi 借鉴并并入 P2 的：token budget tracker / 子 agent 全套 coding tools / acorn AST 解析。
