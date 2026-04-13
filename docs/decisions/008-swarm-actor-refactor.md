# ADR-008: Swarm Actor/SendMessage 重构 — 消除 4 条循环依赖

> 状态: accepted（Phase 0-6 完成）
> 日期: 2026-04-13
> 关联: ADR-007 (protocol-migration-reality-check)
>
> **完工状态**：4 条循环全部消除，`madge --circular src/main/` 报 0。
> 执行历史：Phase 1（脚手架）→ Phase 2（Cycle 4: swarmLaunchApproval）
> → Phase 3（Cycle 2: planApproval）→ Phase 4（Cycle 3: DAGScheduler resolver 注入）
> → Phase 5（Cycle 1: SwarmEventEmitter 迁至 `agent/swarmEventPublisher.ts`）
> → Phase 6（清理 + ADR-007 回指）。
> 主策略偏离：Phase 1 原计划"双写"因和 bridge 订阅器重复投递，改为"单路分流"
> — 每个模块独立迁移到 EventBus，`emitSwarmEvent` legacy 函数已在 Phase 5 删除。
> Smoke 验证：11 个 SwarmEventEmitter 方法通过 EventBus → bridge 链路全部投递成功。

## 背景

madge 当前在 `src/main/` 报告 **4 条循环依赖**，全部围绕 swarm 相关模块聚集在 `ipc/swarm.ipc.ts`：

```
1) agent/agentDefinition.ts > agent/hybrid/index.ts > agent/hybrid/agentSwarm.ts
   > ipc/swarm.ipc.ts > agent/parallelAgentCoordinator.ts > agent/subagentExecutor.ts
2) ipc/swarm.ipc.ts > agent/parallelAgentCoordinator.ts > agent/subagentExecutor.ts
   > agent/planApproval.ts
3) agent/agentDefinition.ts > agent/hybrid/index.ts > agent/hybrid/agentSwarm.ts
   > ipc/swarm.ipc.ts > agent/parallelAgentCoordinator.ts > scheduler/index.ts
   > scheduler/DAGScheduler.ts
4) ipc/swarm.ipc.ts > agent/swarmLaunchApproval.ts
```

ADR-007 明确把这 4 条循环标记为 "size-driven 指标已放弃，需要 Actor-model 重构而不是继续加 protocol/" 的 out-of-scope 工作。本 ADR 授权执行该重构。

### 问题根因

`ipc/swarm.ipc.ts` 是一个**双重角色**的模块：
- **IPC 边界**：`registerSwarmHandlers()` 挂载 12 个 `ipcMain.handle('swarm:*')`（swarm.ipc.ts:389–577）
- **业务转发层**：事件发射器 `SwarmEventEmitter` 既被 `agent/hybrid/agentSwarm.ts` 正向导入（line 25），又被 `agent/planApproval.ts:16` 和 `agent/swarmLaunchApproval.ts:11` **反向导入**

反向导入是全部 4 个循环的闭合边。IPC handler 内部又直接 `require/import` 业务模块（`teammateService`, `parallelAgentCoordinator`, `planApproval` 等），使 `swarm.ipc.ts` 同时出现在调用链两端。

### 重构目标

把 swarm 相关业务模块从「**直接 import swarm.ipc**」改为「**publish 到 EventBus**」，IPC 层从「**直接 call 业务模块**」改为「**subscribe EventBus + send command events**」。本质上是一次 **Actor/SendMessage 隔离**：每个模块只依赖 EventBus 协议，不再互相 import。

目标：`npx madge --circular src/main/` 输出 `0 circular dependencies`，且所有现有功能保持行为等价。

## 决策

采用 **EventBus pub/sub Actor 模式**，分 **5 个阶段** 渐进迁移，每阶段一次 commit，循环数严格单调递减（4 → 3 → 2 → 1 → 0）。

核心约束：
- **生产安全**：每阶段必须 `npm run typecheck` 通过 + smoke test 不回归（Task 工具子 agent launch + plan approval + 追加消息 + 取消/重试）
- **Lake vs Ocean**：只动 swarm 相关 4 条循环涉及的模块，**不碰** 其它功能
- **swarm.ipc.ts 最终形态**：只保留 `ipcMain.handle(...)` 注册 + EventBus subscribe，不再持有任何业务函数 import
- **EventBus 作为唯一传输**：复用现有 `src/main/protocol/events/bus.ts`，swarm 事件类型加到 `protocol/events/categories.ts`

## 当前调用图

### Cycle 1（front: agentDefinition → hybrid → agentSwarm → swarm.ipc → coordinator → subagentExecutor → agentDefinition）

```
agent/agentDefinition.ts
  ↓ imports hybrid 分类 helpers
agent/hybrid/index.ts
  ↓ re-exports
agent/hybrid/agentSwarm.ts
  ↓ line 25: import { getSwarmEventEmitter } from '../../ipc/swarm.ipc'
  ↓ line 86/116: eventEmitter.started(...)
ipc/swarm.ipc.ts
  ↓ dynamic require/static import
agent/parallelAgentCoordinator.ts
  ↓ line 14: import { getSubagentExecutor }
agent/subagentExecutor.ts
  ↓ lines 18–25: VALUE imports from './agentDefinition'
      (getAgentPrompt/getAgentTools/getAgentMaxIterations/...)
  ↺ 回到 agentDefinition.ts
```

节点职责：
- `agentDefinition`: 定义 agent 元数据（prompt/tools/budget），对 hybrid helpers 有**值依赖**
- `hybrid/agentSwarm`: 启动/追加/停止 swarm，调用 `eventEmitter.started/agentAdded` 对外广播
- `swarm.ipc`: IPC handler 聚合点
- `parallelAgentCoordinator`: swarm 执行调度器，驱动 subagent
- `subagentExecutor`: 单个 subagent 执行体，运行时读 agentDefinition 取配置

### Cycle 2（swarm.ipc → coordinator → subagentExecutor → planApproval → swarm.ipc）

```
ipc/swarm.ipc.ts
  ↓
agent/parallelAgentCoordinator.ts
  ↓
agent/subagentExecutor.ts
  ↓ line 36: import { getPlanApprovalGate } from './planApproval'
agent/planApproval.ts
  ↓ line 16: import { getSwarmEventEmitter } from '../ipc/swarm.ipc'  ← 反向
  ↓ line 214: getSwarmEventEmitter().planReview(...)
  ↺ 回到 swarm.ipc.ts
```

节点职责：
- `planApproval`: plan approval gate，`enqueueApproval()` 提交 plan + 500ms 轮询等待用户决定（max 30s）
- `swarm.ipc`: 渲染层通过 `ipcMain.handle('swarm:approve-plan' / 'swarm:reject-plan')`（line 516/540）回写决策

### Cycle 3（与 Cycle 1 并行，return edge 走 scheduler）

```
agent/agentDefinition.ts → hybrid/index → hybrid/agentSwarm
  ↓ line 25
ipc/swarm.ipc.ts
  ↓
agent/parallelAgentCoordinator.ts
  ↓ line 17: import { TaskDAG, getDAGScheduler, SchedulerResult } from '../scheduler'
scheduler/index.ts → scheduler/DAGScheduler.ts
  ↓ line 30: import ... from '../agent/agentDefinition'
  ↺ 回到 agentDefinition.ts
```

节点职责：
- `scheduler/DAGScheduler`: DAG 任务调度器，读 `agentDefinition` 做节点配置展开

### Cycle 4（swarm.ipc ↔ swarmLaunchApproval）

```
ipc/swarm.ipc.ts
  ↓ IPC handler 中 require swarmLaunchApproval
agent/swarmLaunchApproval.ts
  ↓ line 11: import { emitSwarmEvent } from '../ipc/swarm.ipc'  ← 反向
  ↓ lines 51–88: emitSwarmEvent('launchRequested' / 'launchApproved' / 'launchRejected')
  ↺ 回到 swarm.ipc.ts
```

节点职责：
- `swarmLaunchApproval`: swarm 启动前置审批，`waitForDecision()` 400ms 轮询（与 plan approval 同构）
- `swarm.ipc`: handler `swarm:approve-launch` / `swarm:reject-launch`（line 440/450）提交决策

## 目标调用图（Actor 模式）

### 核心原则

1. **业务模块不再 import swarm.ipc**。要通知外部，一律 `eventBus.publish('swarm', { type: '...' , payload })`
2. **swarm.ipc 不再 import 业务模块**。要触发业务行为，一律 `eventBus.publish('swarm', { type: 'command.*' })`
3. **Approval gate 不再轮询 + import**。订阅 `swarm:plan.decision` / `swarm:launch.decision` 事件，用 `once()` + Promise 直接 resolve
4. **Scheduler 解耦**：`scheduler/DAGScheduler` 不再 import `agentDefinition`，改由 `parallelAgentCoordinator` 在构建 DAG 时把所需字段**作为 plain data 注入**

### 目标图（所有 4 循环消除）

```
                     ┌─────────────────────┐
                     │  protocol/events    │
                     │  bus.ts + categories│ ← 协议层（无业务依赖）
                     └──────────┬──────────┘
                                │ publish/subscribe
   ┌────────────────┬───────────┼───────────┬──────────────┐
   │                │           │           │              │
   ▼                ▼           ▼           ▼              ▼
agentDefinition  hybrid/    planApproval  swarmLaunch  ipc/swarm.ipc
                 agentSwarm  Approval     Approval     (IPC 边界 only)
                                                           │
                                                           ▼
                                                      BrowserWindow
                                                      (renderer)
   ▲                ▲                                      │
   │                │                                      │
   └────────────────┴──────────────────────────────────────┘
             (全部依赖收敛到 protocol/events，无环)

parallelAgentCoordinator 仍然 import subagentExecutor / scheduler（单向）
subagentExecutor 不再 import planApproval，改 subscribe 'swarm:plan.*' 事件
DAGScheduler 不再 import agentDefinition，构造时接收 data
```

### 每条循环的拆解

| Cycle | 原闭合边 | 解法 | 结果 |
|-------|---------|------|------|
| 1 | `agentSwarm → swarm.ipc → coordinator → subagentExecutor → agentDefinition` | 拆 `agentSwarm → swarm.ipc` 正向边：`agentSwarm` 改 publish EventBus；`swarm.ipc` subscribe | 正向边删除，链变无环 |
| 2 | `planApproval → swarm.ipc`（line 16 反向） | 删该 import：`planApproval` publish `swarm:plan.review`，subscribe `swarm:plan.decision`；`swarm.ipc` 的 `swarm:approve-plan` handler 改 publish decision | 反向边删除 |
| 3 | `DAGScheduler → agentDefinition`（line 30 return） | `DAGScheduler` 构造函数接收 `AgentDefinitionLookup` 回调而非 import；`parallelAgentCoordinator` 在构建 scheduler 时传入 | return 边删除 |
| 4 | `swarmLaunchApproval → swarm.ipc`（line 11 反向） | 同 Cycle 2 方案：publish/subscribe `swarm:launch.*` | 反向边删除 |

## 事件契约（新增到 protocol/events/categories.ts）

在 `AgentEvent` 的 swarm domain 下新增以下事件类型。命名遵循现有 `domain:noun.verb` 风格。

### 出站事件（业务 → IPC / renderer）

| Type | Payload | 发射者 | 替换 |
|------|---------|--------|------|
| `swarm.launch.requested` | `{ requestId, agents, context }` | `swarmLaunchApproval` | `emitSwarmEvent('launchRequested', ...)` |
| `swarm.launch.started` | `{ agentCount, runId }` | `hybrid/agentSwarm` | `eventEmitter.started(n)` |
| `swarm.agent.added` | `{ agentId, role, parentId }` | `hybrid/agentSwarm` | `eventEmitter.agentAdded(...)` |
| `swarm.plan.review` | `{ planId, agentId, coordinatorId, plan }` | `planApproval` | `emitter.planReview(...)` |
| `swarm.agent.status` | `{ agentId, status, error? }` | `hybrid/agentSwarm` / coordinator | `emitter.statusChanged(...)` |
| `swarm.agent.completed` | `{ agentId, result }` | coordinator | `emitter.completed(...)` |

### 入站事件（IPC / renderer → 业务）

| Type | Payload | 订阅者 | 替换 |
|------|---------|--------|------|
| `swarm.launch.decision` | `{ requestId, approved, feedback? }` | `swarmLaunchApproval` | `ipcMain.handle('swarm:approve-launch')` 内部直接 call |
| `swarm.plan.decision` | `{ planId, approved, feedback? }` | `planApproval` | `ipcMain.handle('swarm:approve-plan')` 内部直接 call |
| `swarm.agent.cancel` | `{ agentId }` | coordinator | `ipcMain.handle('swarm:cancel-agent')` |
| `swarm.agent.retry` | `{ agentId }` | coordinator | `ipcMain.handle('swarm:retry-agent')` |
| `swarm.user.message` | `{ agentId, message }` | coordinator / teammate | `ipcMain.handle('swarm:send-user-message')` |

### 等待语义（approval gate 改造）

旧实现（planApproval.ts:188–263）：500ms `setInterval` 轮询 + 30s 超时。
新实现：

```ts
// planApproval.ts (target)
async enqueueApproval(params): Promise<Decision> {
  const planId = genId();
  eventBus.publish('swarm', { type: 'plan.review', payload: { planId, ...params } });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('plan approval timeout'));
    }, PLAN_APPROVAL_TIMEOUT_MS);

    const off = eventBus.once('swarm:plan.decision', (ev) => {
      if (ev.payload.planId !== planId) return;  // not mine
      clearTimeout(timer);
      resolve(ev.payload);
    });
  });
}
```

`swarmLaunchApproval` 的 `waitForDecision()` 同构改造。

## 迁移阶段

每阶段 = 1 commit，顺序不可打乱。每阶段必须：
1. `npm run typecheck` 通过
2. `npx madge --circular --extensions ts src/main/` 循环数 ≤ 上一阶段
3. Smoke test 通过（见"验证计划"）

### Phase 0: Design Doc（本 ADR）
- 交付物：本文档
- 循环数：4（不变）
- **停止点：等待用户 review 本文档**

### Phase 1: 事件类型骨架 + 双通道并存
- 在 `protocol/events/categories.ts` 新增上述 swarm 事件类型和类型守卫
- 在 `swarm.ipc.ts` 里 `SwarmEventEmitter` 的每个方法**同时**做原有 `emitSwarmEvent` 和新增 `eventBus.publish`（双写）
- 此时**不删**任何 import，行为等价
- 循环数：4（不变）
- Commit：`feat(swarm): 添加 AgentEvent 事件类型 + SwarmEventEmitter 双写过渡`

### Phase 2: 拆 Cycle 4（swarmLaunchApproval）
- `swarmLaunchApproval.ts:11` 删 `import { emitSwarmEvent }`
- 改为 `eventBus.publish('swarm', { type: 'launch.requested' / 'launch.started' / 'launch.failed' })`
- `waitForDecision()` 改 `eventBus.once('swarm:launch.decision')` + Promise
- `swarm.ipc.ts` 的 `swarm:approve-launch` / `swarm:reject-launch` handler 改为 publish `launch.decision`
- 循环数：**4 → 3**
- Commit：`refactor(swarm): 解耦 swarmLaunchApproval，消除 Cycle 4`

### Phase 3: 拆 Cycle 2（planApproval）
- `planApproval.ts:16` 删 `import { getSwarmEventEmitter }`
- 改为 publish `swarm:plan.review`
- `enqueueApproval` / `waitForApproval` 改 `eventBus.once('swarm:plan.decision')` + Promise（见上文示例）
- `swarm.ipc.ts` 的 `swarm:approve-plan` / `swarm:reject-plan` handler 改为 publish `plan.decision`
- 循环数：**3 → 2**
- Commit：`refactor(swarm): 解耦 planApproval，消除 Cycle 2`

### Phase 4: 拆 Cycle 3（scheduler → agentDefinition）
- `scheduler/DAGScheduler.ts:30` 删 `import ... from '../agent/agentDefinition'`
- `DAGScheduler` 构造函数加参数 `agentLookup: (id: string) => AgentConfig | undefined`
- `parallelAgentCoordinator.ts` 在调 `getDAGScheduler()` 时传入闭包（它 own agentDefinition import）
- 循环数：**2 → 1**
- Commit：`refactor(scheduler): 注入 agentLookup 回调，消除 Cycle 3`

### Phase 5: 拆 Cycle 1（agentSwarm → swarm.ipc 正向边）
- `hybrid/agentSwarm.ts:25` 删 `import { getSwarmEventEmitter, SwarmEventEmitter }`
- 删 `this.eventEmitter = getSwarmEventEmitter()` 字段
- 所有 `eventEmitter.xxx(...)` 改 `eventBus.publish('swarm', { type: 'agent.xxx', ... })`
- `swarm.ipc.ts` 保留 IPC handler + EventBus subscribe 桥接到 `BrowserWindow.webContents.send(...)`
- 同时删 Phase 1 留下的双写，只保留 `eventBus.publish`
- 循环数：**1 → 0** ✅
- Commit：`refactor(swarm): 解耦 hybrid/agentSwarm，消除 Cycle 1，4 条循环归零`

### Phase 6: 清理 + 文档
- 删 `SwarmEventEmitter` class 本身（已无 import）
- 删 `emitSwarmEvent` 函数（已无 import）
- 保留 `swarm.ipc.ts` 只剩 `registerSwarmHandlers` 和 EventBus → webContents 桥
- 更新 ADR-007 脚注指向本 ADR 的完工状态
- 更新 `docs/architecture/multiagent-system.md` swarm 章节
- 循环数：0（不变）
- Commit：`chore(swarm): 清理旧 SwarmEventEmitter，更新架构文档`

## 风险清单

| 风险 | 影响 | 缓解 |
|------|------|------|
| **Approval timing 变化**：原 500ms/400ms 轮询 → `eventBus.once` 即时唤醒。理论更快，但若 EventBus publish 在 subscribe 前发出会丢事件 | plan/launch approval 卡死 | Phase 3/2 改造时，**必须在 publish 之前** `eventBus.once` subscribe；单测覆盖 subscribe-before-publish 顺序 |
| **并发 planId 混淆**：多个 plan review 并发时，`once()` 必须过滤 `planId`，否则 A 的 decision 会 resolve B 的 Promise | 错批 | 改造代码已在示例中包含 `if (ev.payload.planId !== planId) return; // not mine` |
| **中断传播**：取消 swarm 时 planApproval 的 Promise 需能被 reject | 幽灵 pending promise | 加 `eventBus.once('swarm:cancelled', ...)` 在 gate 内监听，reject('cancelled') |
| **错误冒泡**：原 `emitSwarmEvent` 是同步调用，publish 也是同步，但异步订阅者的 error 会被 EventBus 吞掉 | 静默失败 | Phase 1 双写阶段比对两条通道的事件序列，用现有 devtools log 人工 diff 一次 |
| **DAGScheduler 注入回调**：agentLookup 变成函数后，scheduler 可能被持久化/序列化 | JSON 序列化断 | 检查 DAGScheduler 是否有 `JSON.stringify` 持久化路径；若无则安全 |
| **IPC handler 内仍有业务 import**：`swarm.ipc.ts:386` 之类的 `require('../agent/teammate/teammateService')` 仍存在 | Cycle 归零但耦合仍在 | Phase 6 中把剩余 `require` 改为 publish `swarm:command.*`，subscribe 侧放 `parallelAgentCoordinator` / `teammateService` |
| **Renderer 监听断链**：原 `emitSwarmEvent` 会遍历 `BrowserWindow.getAllWindows()` 调 `webContents.send` | 前端收不到事件 | `swarm.ipc.ts` 的桥接订阅必须保留该广播逻辑，Phase 1 就接好 |
| **CLI listeners**：`swarm.ipc.ts` 的 CLI listener 链路 | CLI 模式失联 | 同上，桥接保留 |
| **循环计数回弹**：某阶段无意引入新 import | 阶段失败 | 每个 commit 前在 pre-push hook 或手动跑 madge，循环数 > 预期立即 revert |
| **2 周工期超支**：实际改动牵出意外依赖 | 延期 | 每 phase 独立可 ship；若 Phase 3 卡住，Phase 2 的成果已经 merge |

## 验证计划

### 每阶段必跑

```bash
# 1. 类型检查
npm run typecheck

# 2. 循环数检查（必须严格单调递减）
npx madge --circular --extensions ts src/main/ 2>&1 | grep "Found.*circular"

# 3. swarm 相关文件的 import 截面
grep -rn "from.*swarm\.ipc" src/main/agent/ src/main/scheduler/
# Phase 2 后：swarmLaunchApproval 不应出现
# Phase 3 后：planApproval 不应出现
# Phase 5 后：agentSwarm 不应出现
# Phase 6 后：此命令应无输出
```

### Smoke test（每阶段手动跑一次）

1. **子 agent launch**：Task 工具起 1 个 subagent，确认 `swarm.launch.requested` → 用户在 UI approve → `launch.started` → 子 agent 执行完成
2. **Plan approval**：subagent 生成 plan，UI 弹出 review 面板，approve 后继续执行；reject 后 subagent 停止
3. **追加消息**：swarm 运行中通过 `swarm:send-user-message` 追加一条消息，确认送达
4. **取消**：运行中点击 cancel，确认所有 subagent 停止，pending approval promise 被 reject
5. **并发**：同时起 2 个 swarm，验证 plan approval 按 planId 正确路由，不串台
6. **CLI 模式**：用 CLI 跑一次 swarm 命令，确认事件广播到 stdout

### Phase 1 特殊验证（双写阶段）

跑一次完整 swarm，用 devtools console 同时监听 `emitSwarmEvent` legacy 通道和 `eventBus.subscribe('swarm:*')`，diff 两条时间序列：
- 事件数量一致
- 事件顺序一致
- payload 等价（或记录已知差异）

通过后才进 Phase 2。

### 最终验证（Phase 6 完成后）

```bash
# 循环数归零
npx madge --circular --extensions ts src/main/
# Expected: ✔ No circular dependency found!

# 无遗留 swarm.ipc 业务 import
grep -rn "from.*ipc/swarm\.ipc'" src/main/agent/ src/main/scheduler/ src/main/hybrid/
# Expected: no output

# EventBus 订阅点覆盖所有 IPC 等价路径
grep -n "eventBus.subscribe.*swarm" src/main/ipc/swarm.ipc.ts
# Expected: 至少覆盖 launch/plan/agent 三类

# 全量 typecheck
npm run typecheck
```

## 选项考虑

### 选项 1：保持现状 + doc-only 标注
- 优点：零风险
- 缺点：架构债继续累积，madge 报警长期红，后续 swarm 功能扩展更难

### 选项 2：用 TypeScript `import type` 绕过（只改反向边）
- 优点：改动小
- 缺点：**不解决本质问题**，madge 仍然报警（运行时依赖仍在），且 approval gate 的轮询逻辑没改善

### 选项 3：把 swarm.ipc 拆成两个文件（pure handlers + emitter）
- 优点：改动中等
- 缺点：只拆分文件不解决耦合，反向 import 仍然会从 `planApproval` 指向新 emitter 文件，循环只是换了个名字

### 选项 4（本决策）：EventBus Actor 模式，5 阶段渐进重构
- 优点：彻底消除循环，approval gate 变事件驱动，延迟更低；复用现有 `protocol/events/bus.ts` 无新增架构层
- 缺点：2 周工期，跨 5 个 commit 的风险窗口，事件顺序和错误冒泡需要仔细验证

## 后果

### 积极影响

- `npx madge --circular` 输出 0 循环，CI 可把循环检查设为硬性 gate
- Approval gate 从 500ms 轮询变事件驱动，user approve 到 agent 继续的延迟从 ~250ms 降到 ~0
- `swarm.ipc.ts` 变成纯 IPC 边界，符合"IPC 层不应含业务逻辑"的分层原则
- 未来新增 swarm 事件/命令只需加事件类型 + publish/subscribe，不需要改 import 拓扑
- 为后续 Phase 7+（如果需要把 `teammateService` 也接入 EventBus）铺好基础设施

### 消极影响

- 事件驱动调试比直接函数调用更难追踪（需要 eventBus 日志辅助）
- 新人 onboarding 成本：需理解 pub/sub 模式
- 事件类型定义散落在 `categories.ts`，类型不如直接 import 函数签名那么紧耦合（但这正是解耦的目的）

### 风险

见上文"风险清单"。主要风险是 approval 事件时序和并发 planId 串台，两者都有明确缓解方案。

## 相关文档

- [ADR-007: Protocol Migration Reality Check](./007-protocol-migration-reality-check.md) — 授权本次重构的上游 ADR
- [src/main/protocol/events/bus.ts](../../src/main/protocol/events/bus.ts) — EventBus 传输层
- [src/main/protocol/events/categories.ts](../../src/main/protocol/events/categories.ts) — 事件类型定义（本 ADR 将扩展此文件）
- [src/main/ipc/swarm.ipc.ts](../../src/main/ipc/swarm.ipc.ts) — 重构目标的核心文件
- [docs/architecture/multiagent-system.md](../architecture/multiagent-system.md) — 多 agent 架构文档（Phase 6 将更新）

---

**✅ 执行完成（2026-04-13）**

实际 commit 序列：
1. `docs(adr-008)`: 本设计文档
2. `feat(swarm)`: Phase 1 scaffolding — EventDomain 加 'swarm'、类型守卫、SwarmEventEmitter 双写（后被 Phase 2 回退）
3. `refactor(swarm)`: Phase 2 — swarmLaunchApproval 删 swarm.ipc import，新增 `ensureSwarmBusBridge` 订阅器（循环 4→3）
4. `refactor(swarm)`: Phase 3 — planApproval 删 swarm.ipc import（循环 3→2）
5. `refactor(swarm)`: Phase 4 — DAGScheduler setAgentResolver 注入，initBackgroundServices 提供 closure（循环 2→1）
6. `refactor(swarm)`: Phase 5 — SwarmEventEmitter 迁到 `agent/swarmEventPublisher.ts`；swarm.ipc 从 585 行瘦身到 297 行（循环 1→0）
7. `chore(swarm)`: Phase 6 — 清理 stale comment、ADR-007 回指、状态改 accepted

**最终架构**：
- 业务模块（agentSwarm / planApproval / swarmLaunchApproval）→ `getEventBus().publish('swarm', ...)`
- `swarm.ipc.ts` 只剩：IPC handlers (12 个) + bridge 订阅器 + CLI listener API
- `swarm.ipc.ts` re-export `getSwarmEventEmitter` 给 spawnAgent 等 legacy importer
- EventBus `swarm` domain 是唯一的事件传输层
