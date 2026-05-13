# Task 取消级联（Cancellation Cascading）— 实施计划

> **状态**：草案 v1（2026-05-13，林晨）
> **范围**：补齐 ESC → 主 agent → subagent → tool 的完整 cancel 传播；区分 `user-cancel` vs `child-error`；接通已存在但零调用的 `initiateShutdown` 四阶段优雅关闭；接通 `AgentTask.saveToDisk` partial 持久化。
> **风险灯**：🟡 黄（多处现成零件，但 wiring 不完整，且需要触动 spawnAgent / coordinator / shutdownProtocol 三处核心路径）。
> **优先级**：P0 — Code Agent 的核心差异化能力，决定用户 ESC 后的 trust 边界。99% multi-agent 系统（含 LangChain deepagents / Claude Code 主线）这条没做对，做对了就是 differentiator。

---

## 1. 目标 & 非目标

### 目标

1. **ESC 1 秒内全停**：用户 ESC 后，主 agent 当轮 LLM streaming 立刻断、所有派出的 subagent 在 1 秒内停止 LLM 调用 + 进入 grace（已有 `shutdownProtocol.initiateShutdown` 但零调用，本期接通）。
2. **区分两种 cancel 语义**：新增 `CancellationReason` 联合 `'user-cancel' | 'child-error' | 'timeout' | 'parent-cancel' | 'session-switch'`。`user-cancel` 全停；`child-error` 只停那一个 + 兄弟继续；`timeout` 走 grace；`parent-cancel` 是 cascading 副产物。
3. **partial 产物落盘**：cancel 触发时，每个 subagent 走 `AgentTask.saveToDisk` 落 transcript + metadata，配合 main agent 已有的 `persistMessage(lastStreamedContent + '[cancelled]')`。
4. **N 分钟无 progress 自动 cancel**（场景 D）：在 `subagentExecutor` 已有 timeoutController 上加 idle-progress watchdog（默认 120s 无 stream 视为无 progress），idle 触发 `initiateShutdown('idle-timeout')` 上报主 agent。
5. **单 agent 取消接通**：renderer 没 caller 的 `swarm:cancel-agent` 补 UI（subagent card 上的 Stop 按钮）。
6. **闭合四个真实场景**（§5）。

### 非目标

- ❌ **不做 resume**：场景 B 文案中"改完 resume 第 4 个"是产品目标，本期只保证"前 3 个保存"，resume 留 M3。
- ❌ **不动 streaming 中途 LLM partial chunk 持久化**：主 agent 的 `lastStreamedContent` 路径已 work（line 1100-1119），subagent 不做 chunk 持久化（subagent 输出本来就在 transcript jsonl，cancel 时 flush 即可）。
- ❌ **不重写 spawnGuard / parallelCoordinator**：保留已有 `cancelAll / abortAllRunning` 语义，只接通信号传播。
- ❌ **不动 model layer**：`modelRouter.inference` 已接 signal，链路完整。
- ❌ **不引入新 IPC**：复用 `agent:cancel`、`swarm:cancel-run`、`swarm:cancel-agent`。

---

## 2. 验收标准（≥4 条 e2e）

1. **AC-A（场景 A — ESC 全停）**：主 agent 跑中，并行 spawn 3 个 subagent，10s 后 IPC `agent:cancel`。e2e 断言：1 秒内 3 个 subagent 的 `effectiveSignal.aborted === true`、`SubagentStop` hook 各触发一次、3 个 AgentTask 走 `saveToDisk` 留下 transcript.jsonl、`spawnGuard.getRunningCount() === 0`。
2. **AC-B（场景 B — partial 保存）**：并行 spawn 10 个 subagent，第 3 个完成后 cancel。断言：前 3 个 transcript.jsonl 完整可读，第 4-10 个 metadata.json status === 'cancelled' 但 transcript 仍包含 cancel 前已 produce 的 turns。
3. **AC-C（场景 C — user-cancel vs child-error 区分）**：并行 3 subagent，其中 1 个抛 `API timeout` 错误。断言：`parallelErrorHandler` 走 `recoveryStrategy = 'fallback'` 不调 `abortAllRunning`，另外 2 个继续跑完 success；coordinator emit `task:error` 但**不** emit `task:cancelled`。反例：模拟 IPC `agent:cancel`，3 个都状态 'cancelled'。
4. **AC-D（场景 D — 无 progress watchdog）**：spawn subagent，stub modelRouter inference 让它 hang 200s 不返回任何 stream chunk。断言：120s 时 `initiateShutdown('idle-timeout')` 触发，subagent 走 grace（5s）后 fail，主 agent 收到 `child-error` reason，继续后续 turn。
5. **AC-E（旧 caller 兼容）**：没有 `parentContext`、没有 `runAbortController` 的旧 caller（CLI 直接调 `getSubagentExecutor().execute`）仍能跑，行为不变。
6. **AC-F（cascading 不反向）**：子 abort（child 走 fail）不能让 parent 也 abort。`createChildAbortController` 已保证此语义（line 173-191）；新增 unit test 验证。

---

## 3. 现状调研（grep + Read 验证）

### 3.1 已有但零调用的基础设施

**`initiateShutdown` 四阶段优雅关闭**：`src/main/agent/shutdownProtocol.ts:50-114`，Signal → Grace → Flush → Force 完整实现，但 `grep -rn initiateShutdown src --include="*.ts"` **零调用方**。`createTimedAbortController` 和 `createChildAbortController` 被调用，但核心 `initiateShutdown` 协议没人用。

**`AgentTask.saveToDisk`**：`src/main/agent/agentTask.ts:162-186`，可落 `transcript.jsonl` + `metadata.json`，但 cancel 路径（line 99-110）只调 `abortController.abort()`，**没调 saveToDisk**。partial 产物丢失。

**`swarm:cancel-agent` IPC**：`src/main/ipc/swarm.ipc.ts:254-270` 已注册（接 `spawnGuard.cancel` + `parallelCoordinator.abortTask`），但 `grep -rn "swarm:cancel-agent" src/renderer --include="*.ts" --include="*.tsx"` **零 caller**——renderer 没 UI 接通。

### 3.2 信号链路（已 work + 不完整的环节）

**已 work**：
- ESC → `ChatView.tsx:139` → 双击 ESC 弹 RewindPanel（注意：单击 ESC **不**触发 cancel；当前真正的 cancel 入口是 InputBox 的 Stop 按钮 / 命令面板）
- `ipcService.invoke('agent:cancel', ...)`（`useAgentIPC.ts:544`）→ `agent.ipc.ts:114 case 'cancel'` → `appService.cancel` → `orchestrator.cancel` → `agentLoop.cancel` → `conversationRuntime.cancel`（`conversationRuntime.ts:1096-1123`）→ `abortController.abort() + runAbortController.abort()` + `persistMessage(partial + [cancelled])`。
- 并行 spawn 路径（`parallel_agents` 工具）通过 `context.abortSignal.addEventListener('abort', () => coordinator.abortAllRunning('run_cancelled'))`（`spawnAgent.ts:727-732`）正确传播。

**不完整**：
- **单 spawn 路径**：`spawnAgent.ts:284` 新建独立 `AbortController()` 给 executorContext，**没桥接 `context.abortSignal`**。后果：主 agent ESC 后，正在 wait 的单 spawn subagent 不会停（除非 spawnGuard 兜底 cancelAll，而 spawnGuard.cancelAll 只在 `swarm:cancel-run` 触发，主 cancel 路径 `appService.cancel` → `orchestrator.cancel` 没调它）。
- **`appService.cancel` 没调 `spawnGuard.cancelAll`**：`agentAppService.ts:253-266` 只调 `tm.cancelTask` / `orchestrator.cancel`，没触发 subagent 级 cancelAll。
- **`subagentExecutor` 内部双层 controller**（`subagentExecutor.ts:440-462`）：用了 `createChildAbortController` 包装，但用法绕（手动构 `parentController` 中转）。功能正确，可读性差，回归风险点。

### 3.3 失败语义混淆

`parallelErrorHandler.ts:204` 默认策略 `'abort'`，单个 agent fail 时 `stats.failedAgents.add` + `shouldContinue: false`；`shouldContinueExecution` line 297-306 还有 "≥50% 失败就停" 规则。**但没有 abort 信号下发**：即便 `shouldContinue: false`，`parallelAgentCoordinator` 也不会调 `abortAllRunning`——这一层是建议层，不是执行层。

**反例正解**：LangChain deepagents Issue #694（plan §why 提到的反例）的根本错误是把 child-fail 路径接到 abort 信号上，code-agent 现在没接，反而是对的——但要明确写在文档/类型里，避免未来 PR 把这个语义"修"成 bug。

### 3.4 tool 层 abort 覆盖率

- bash 工具：`bash.ts:232-242` 接 `abortSignal.addEventListener('abort', abortHandler)` → SIGTERM kill child process。✅
- httpRequest / image*/screenshotPage / mcpInvoke / lsp 等：`grep -rn "ctx.abortSignal\|context.abortSignal" src/main/tools/modules` 共 180 处引用，已普遍覆盖。✅
- 文件 read/edit：默认同步操作毫秒级返回，不需 abort。✅
- `modelRouter.inference`：line 436 接 `signal` 参数，subagentExecutor 已传（line 874），主 agent 通过 `runAbortController.signal` 传（toolExecutionEngine.ts:2396）。✅

**结论**：tool 层完整，问题在 agent 层 wiring。

---

## 4. 设计方案

### 4.1 取消原因类型（contract）

新建 `src/shared/contract/cancellation.ts`：

```ts
export type CancellationReason =
  | 'user-cancel'        // 用户主动 ESC / Stop 按钮
  | 'session-switch'     // 切换 session 触发的副作用 cancel
  | 'parent-cancel'      // 父 agent 被 cancel，向下 cascading
  | 'child-error'        // 单个 child 抛错（兄弟不受影响）
  | 'timeout'            // 执行时长超过 maxExecutionTimeMs
  | 'idle-timeout'       // N 分钟无 progress（新增 D 场景）
  | 'budget-exceeded';   // 超 budget 兜底（沿用现有）

export const CASCADE_REASONS: CancellationReason[] = [
  'user-cancel', 'session-switch', 'parent-cancel',
];
export const NON_CASCADE_REASONS: CancellationReason[] = [
  'child-error', 'timeout', 'idle-timeout', 'budget-exceeded',
];
```

`abortController.abort(reason)` 传 `CancellationReason` 字符串作为 reason，下游通过 `effectiveSignal.reason as CancellationReason` 判断。

### 4.2 ESC 信号传播链路（端到端）

```
[renderer]
  Stop button / Esc-Esc / cmd palette
        ↓ ipcService.invoke('agent:cancel', { sessionId })
[main IPC]
  agent.ipc.ts:114 case 'cancel'
        ↓ appService.cancel(sessionId, 'user')
[appService]  ← 改 1：cancel 时同步触发 spawnGuard.cancelAll
  appService.cancel():
    1. tm.cancelTask (existing)
    2. orchestrator.cancel('user-cancel')   ← reason 改成新 contract
    3. swarmServices.spawnGuard.cancelAll('user-cancel')   ← 新增
    4. swarmServices.parallelCoordinator.abortAllRunning('user-cancel')   ← 新增
[orchestrator]
  agentLoop.cancel('user-cancel')
        ↓
[conversationRuntime]
  abortController.abort('user-cancel')
  runAbortController.abort('user-cancel')
  persistMessage(lastStreamedContent + '[cancelled]')   ← 已有
[toolExecutionEngine]
  ctx.runAbortController.signal → 传入 spawn_agent tool 的 ctx.abortSignal
[spawnAgent tool]   ← 改 2：bridge context.abortSignal → executor 内部 controller
  abortController.abort('parent-cancel') on context.abortSignal abort
[subagentExecutor]
  effectiveSignal aborted (reason='parent-cancel')
        ↓ initiateShutdown(controller, runningPromise, { gracePeriodMs, onFlush })   ← 改 3：接通
[shutdownProtocol]
  Phase 1: Signal → modelRouter.inference 收到 signal abort
  Phase 2: Grace (5s) → 当前 tool 调用 SIGTERM/HTTP-AbortController
  Phase 3: Flush → agentTask.saveToDisk(sessionDir)   ← 改 4：接通 partial 持久化
  Phase 4: Force return SubagentResult{ success: false, error: 'cancelled (parent-cancel)' }
```

### 4.3 关键代码改动（伪代码）

**改 1 — `agentAppService.cancel`**

```ts
async cancel(sessionId?: string, reason: CancellationReason = 'user-cancel'): Promise<void> {
  const resolvedSessionId = this.resolveSessionId(sessionId);
  if (!resolvedSessionId) throw new Error('No active session');

  // 主链路（已有）
  const state = tm.getSessionState(resolvedSessionId);
  if (isTaskManagerOwnedRunState(state.status)) {
    await tm.cancelTask(resolvedSessionId);
  } else {
    const orchestrator = this.getOrchestratorOrThrow(resolvedSessionId);
    await orchestrator.cancel(reason);
  }

  // 新增：subagent 级 cancel —— 避免单 spawn 路径独立 controller 收不到信号
  const services = getSwarmServices();
  services.spawnGuard.cancelAll(reason);
  services.parallelCoordinator.abortAllRunning(reason);
}
```

**改 2 — `multiagentTools/spawnAgent.ts` 单 spawn 路径桥接父信号**

```ts
const abortController = new AbortController();
// NEW: bridge parent abort → child controller (cascading reason 透传)
if (context.abortSignal) {
  if (context.abortSignal.aborted) {
    abortController.abort(context.abortSignal.reason ?? 'parent-cancel');
  } else {
    context.abortSignal.addEventListener('abort', () => {
      abortController.abort(context.abortSignal!.reason ?? 'parent-cancel');
    }, { once: true });
  }
}
```

**改 3 — `subagentExecutor.execute` 接通 `initiateShutdown`**

在现有 `cleanupTimer + agentTask.fail` 路径外，加一个"主动 shutdown"分支：当外部 signal abort 且 reason ∈ CASCADE_REASONS 时，不直接 return error，而是先走 `initiateShutdown` 让 grace + flush 跑完：

```ts
// 替换 line 762-781 的 abort 检测块
if (effectiveSignal.aborted) {
  const reason = (effectiveSignal.reason ?? 'cancelled') as CancellationReason;
  logger.info(`[${config.name}] aborted reason=${reason}`);
  cleanupTimer();

  // NEW: 走优雅 shutdown
  const sessionDir = getSessionPersistence().getSessionDir(sessionId);
  await initiateShutdown(effectiveController, Promise.resolve(), {
    gracePeriodMs: 5000,
    label: `${config.name}:${agentId}`,
    onFlush: async () => { await agentTask.saveToDisk(sessionDir); },
  });

  pipeline.completeContext(pipelineContext.agentId, false, reason);
  agentTask.fail(`cancelled (${reason})`);
  context.hookManager?.triggerSubagentStop(...).catch(silence(...));
  return {
    success: false,
    output: finalOutput,
    error: `任务已取消 (${reason})`,
    toolsUsed: [...new Set(toolsUsed)],
    iterations,
    agentId: agentTask.id,
    contextSnapshot: latestContextSnapshot,
  };
}
```

**改 4 — idle-progress watchdog（场景 D）**

```ts
// 在 subagentExecutor.execute 内，stream chunk / iteration 边界处更新 lastProgressAt
let lastProgressAt = Date.now();
const idleWatchdog = setInterval(() => {
  const idle = Date.now() - lastProgressAt;
  if (idle > IDLE_TIMEOUT_MS && !effectiveSignal.aborted) {
    logger.warn(`[${config.name}] idle ${idle}ms, triggering idle-timeout`);
    effectiveController.abort('idle-timeout');
  }
}, IDLE_CHECK_INTERVAL_MS);

// 在 inference / tool 结束处 lastProgressAt = Date.now()
// finally 块清 watchdog: clearInterval(idleWatchdog);
```

常量加到 `src/shared/constants.ts`：`IDLE_TIMEOUT_MS = 120_000`、`IDLE_CHECK_INTERVAL_MS = 5_000`、`GRACEFUL_SHUTDOWN_GRACE_MS = 5_000`。**禁止硬编码**（CLAUDE.md 规则）。

### 4.4 cancel 语义区分（user-cancel vs child-error）

**user-cancel / parent-cancel（cascading）**：`appService.cancel` 显式调 `spawnGuard.cancelAll(reason)` + `parallelCoordinator.abortAllRunning(reason)`，所有 subagent 收到 signal。

**child-error（NON-cascade）**：`parallelAgentCoordinator.executeTask` 的 try/catch（line 465-491）抓单个 task 异常，**只清理自己的 abortController**（line 470 已正确），不调 `abortAllRunning`。当前代码就是这个语义，本期不动 — 但 §6 测试计划必须加反例测试防止未来回归。

**`parallelErrorHandler` 角色澄清**：是建议层，不是执行层。`recoveryStrategy: 'abort'` 仅作为返回给主 agent 的"建议停止"信号，是否真停由 main agent 下一轮 LLM 决策。文档/JSDoc 补这一行说明。

### 4.5 partial 产物保存路径

| 产物 | cancel 时持久化位置 | 现状 |
|------|---------------------|------|
| 主 agent partial assistant message | `conversationRuntime.cancel` → `persistMessage` | ✅ 已有 |
| Subagent transcript（iteration-level） | `agentTask.saveToDisk` → `<sessionDir>/agents/<agentId>/transcript.jsonl` | ⚠️ 函数存在但 cancel 路径未调，本期接通 |
| Subagent metadata（status=cancelled, error） | 同上 `metadata.json` | ⚠️ 同上 |
| Context snapshot（已 work） | `subagentContextStore.upsert` 每轮 emit | ✅ 已有 |
| Telemetry turn | `telemetryCollector.recordModelCall` 每轮 | ✅ 已有，但 cancel 当轮的 partial turn 未上报，本期不动（次要） |

---

## 5. 四个场景修复对照

### 场景 A — 用户后悔但 agent 还在烧钱

| 阶段 | 现状 | 修复后 |
|------|------|--------|
| ESC 触发 | Stop 按钮 → `agent:cancel` IPC | 同 |
| 主 agent | abortController.abort()（已 work） | 同 |
| 单 spawn subagent | 独立 controller 收不到信号，跑完才停 | `appService.cancel` 调 `spawnGuard.cancelAll('user-cancel')`，spawnGuard 内部循环 abort 每个；同时 `spawnAgent.ts` bridge `context.abortSignal` 兜底 |
| 并行 subagent | `parallel_agents` 路径已 bridge，✅ | 加 `appService.cancel` 调 `parallelCoordinator.abortAllRunning` 兜底（双保险）|
| 1s 内的反应 | ❌ subagent 当轮 LLM 跑完才停（最多几十秒） | ✅ `modelRouter.inference` 收到 signal 立刻 reject |
| partial 产物 | 丢失 | `initiateShutdown` Phase 3 `onFlush: agentTask.saveToDisk` |

### 场景 B — Long task 没法中途调头

| 阶段 | 现状 | 修复后 |
|------|------|--------|
| 前 3 个 subagent 已完成 | `parallelAgentCoordinator.completedTasks` 内存中有，但 cancel 时没主动落盘到 transcript.jsonl | `coordinator.abortAllRunning` 触发各 task 走 `subagentExecutor` 的 cancel 分支 → `initiateShutdown.onFlush` 落盘前 3 个的最终 transcript |
| 第 4-10 个 running | 主进程被 kill 后内存丢失 | 各自走 grace + flush，metadata.status='cancelled'，transcript 保留 cancel 前的 turns |
| 第 4-10 个 pending（未 start） | 没 start 不存在 | `parallelCoordinator.createSkippedResult('cancelled')` 已有 line 235-245，本期不动 |
| Resume | 不支持 | 本期 **OUT OF SCOPE**（M3 通过 `loadFromDisk` 实现）|

### 场景 C — Subagent fail 不能拖垮全员

| 阶段 | 现状 | 修复后 |
|------|------|--------|
| 1 个 subagent API 超时 | `subagentExecutor` 抛错 → `coordinator.executeTask` catch（line 465）→ 标记自己 failed | 同（不改）|
| 是否 cascade | ❌ 当前不 cascade，✅ 正确（语义对）但**没有明确文档** | 在 `parallelErrorHandler` JSDoc + `CancellationReason` contract 注释里写死 `child-error !== cascade-trigger`，加 unit test 反例 |
| `parallelErrorHandler.shouldContinue` | 返回 false 时主 agent 只是收到建议 | 同（建议层不强执行）|
| 其他 2 个 subagent | 继续跑（✅ 已 work） | 同 |

**反例测试（必做）**：模拟 `subagentExecutor` 抛 `new Error('API timeout')`，断言 `coordinator.abortAllRunning` **没被调用**，其他 2 个 task 跑完 success。

### 场景 D — 网络抖动卡死无救

| 阶段 | 现状 | 修复后 |
|------|------|--------|
| stream 卡 200s | ❌ 无 idle 检测，subagentExecutor 一直 awaiting inference | idle watchdog 在 120s 时 `effectiveController.abort('idle-timeout')` |
| modelRouter.inference 被 abort | ✅ 已 work | 同 |
| 上报主 agent | 当前 throw error 给 spawn_agent 工具，返回 success=false | 同（reason 透传 'idle-timeout' 给主 agent，让它决定 retry 还是放弃）|
| watchdog 资源泄漏 | N/A | finally 块 clearInterval |

---

## 6. 文件改动清单

**新增**（4 个）：
- `/Users/linchen/Downloads/ai/code-agent/src/shared/contract/cancellation.ts` — `CancellationReason` 类型 + CASCADE/NON_CASCADE 常量。
- `/Users/linchen/Downloads/ai/code-agent/tests/agent/cancellation-cascade.e2e.test.ts` — 场景 A/B 端到端测试（fake LLM + fake clock）。
- `/Users/linchen/Downloads/ai/code-agent/tests/agent/cancellation-isolation.test.ts` — 场景 C 反例测试（child-error ≠ cascade）。
- `/Users/linchen/Downloads/ai/code-agent/tests/agent/cancellation-idle-watchdog.test.ts` — 场景 D idle timeout 测试。

**修改**（7 个）：
- `/Users/linchen/Downloads/ai/code-agent/src/shared/constants.ts` — 新增 `IDLE_TIMEOUT_MS`、`IDLE_CHECK_INTERVAL_MS`、`GRACEFUL_SHUTDOWN_GRACE_MS`。
- `/Users/linchen/Downloads/ai/code-agent/src/main/app/agentAppService.ts` — `cancel` 方法新增 spawnGuard.cancelAll + parallelCoordinator.abortAllRunning，签名加 `CancellationReason`。
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/agentOrchestrator.ts` — `cancel` 接收 `CancellationReason`，向下透传。
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/multiagentTools/spawnAgent.ts` — 单 spawn 路径（line 284）bridge `context.abortSignal` → 新建的 abortController。
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/subagentExecutor.ts` — abort 检测块（line 761-781）替换为 `initiateShutdown(...)` 调用，flush 走 `agentTask.saveToDisk`；execute 内加 idle watchdog。
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/parallelErrorHandler.ts` — JSDoc 补 `child-error !== cascade-trigger` 语义说明。
- `/Users/linchen/Downloads/ai/code-agent/src/renderer/components/swarm/SwarmAgentCard.tsx`（或等价文件，按现有 swarm UI 结构）— Stop 按钮接 `swarm:cancel-agent` IPC。

---

## 7. 实施步骤（4 phase）

**Phase 1 — Contract & 常量（0.5 天）**
1. 写 `src/shared/contract/cancellation.ts`，加 `CancellationReason` 类型 + CASCADE/NON_CASCADE 常量数组。
2. 在 `src/shared/constants.ts` 加三个 timeout/grace 常量。
3. `npm run typecheck` 必须 pass。
4. 单独 commit：`feat(cancellation): add CancellationReason contract and timeout constants`。

**Phase 2 — appService.cancel 兜底 + spawnAgent bridge（1 天）**
1. 改 `agentAppService.cancel` 加 spawnGuard / parallelCoordinator 双兜底。
2. 改 `multiagentTools/spawnAgent.ts` line 284 加 `context.abortSignal` bridge。
3. 跑 `npm run typecheck`。
4. 写一个最小 e2e：spawn → main agent cancel → subagent 1s 内 effectiveSignal.aborted。
5. commit：`fix(cancellation): wire user-cancel to spawnGuard and bridge parent abortSignal to single spawn path`。

**Phase 3 — initiateShutdown 接通 + partial 持久化（1.5 天）**
1. 改 `subagentExecutor.execute` 的 abort 检测块：调 `initiateShutdown`，`onFlush: agentTask.saveToDisk`。
2. 改 `agentOrchestrator.cancel` 接受 `CancellationReason`，链路全程透传。
3. 写 AC-B 测试：10 并行 task，cancel 后断言 transcript.jsonl 完整。
4. commit：`feat(cancellation): wire initiateShutdown four-phase and partial flush to AgentTask.saveToDisk`。

**Phase 4 — idle watchdog + 反例测试 + Stop 按钮 UI（1 天）**
1. 在 `subagentExecutor.execute` 加 `lastProgressAt` 跟踪 + `idleWatchdog` setInterval。
2. 写 AC-C 反例：注入 fail 模拟，断言 abortAllRunning **没被调**。
3. 写 AC-D：fake clock + stub modelRouter.inference 200s hang。
4. renderer 加 Stop 按钮接 `swarm:cancel-agent`。
5. commit：`feat(cancellation): add idle-progress watchdog and per-agent stop UI`。

**总工期估算**：4 天（含测试 + 调试）。Phase 间无强依赖，但建议顺序执行减少 conflict。

---

## 8. 风险 & 缓解

### R1 — 旧 caller 没有 `parentContext` / 没有 IPC 入口（CLI 直接调）
- **风险**：外部 CLI（`src/cli/`）调 `getSubagentExecutor().execute()` 不走 IPC，`spawnGuard.cancelAll` 兜底拉不到。
- **缓解**：保留 `subagentExecutor` 内部 abort 检测，`context.abortSignal` 是 optional；CLI 用户自己负责传 signal。AC-E 测试覆盖。

### R2 — cancel 时 DB lock / file write race
- **风险**：5 个 subagent 同时走 `agentTask.saveToDisk` 写同一 `sessionDir/agents/<agentId>/`，子目录不冲突；但若 sessionManager 此时也在写主 transcript，可能 fs lock。
- **缓解**：`saveToDisk` 每个 agent 独立目录（line 163 `join(sessionDir, 'agents', this.id)`）已天然隔离。主 transcript 走 `persistMessage`，与 sub agent 目录正交。**flush phase 超时 2s**（`shutdownProtocol.ts:96`）保证就算 lock 也不卡住整体 shutdown。

### R3 — 并发 cancel race（用户连按两下 ESC / Stop）
- **风险**：第二次 cancel 进入时第一次还没 flush 完，可能 double-abort 或 cleanup 重复触发 hook。
- **缓解**：`AbortController.abort(reason)` idempotent（aborted 后再 abort 是 no-op）。`agentTask.cancel` 已有状态机守卫（line 100-102）。新增 `appService.cancel` 加 in-flight flag（`this.cancelInFlight: Map<sessionId, Promise>`），第二次进入返回同一 promise。

### R4 — streaming abort 的 partial state 不一致（partial chunk + DB）
- **风险**：subagentExecutor 在 `inference()` mid-stream 被 abort，`response.content` 是 partial 字符串，写入 transcript 后续读取看到半句。
- **缓解**：transcript 是 jsonl + append-only，partial entry 标 `meta.cancelled = true` 让 reader 知道这条是 partial。`AgentTask.appendTranscript` 加可选 `partial` flag。本期 minimal：cancel 路径在 `appendTranscript` 时打 marker `[CANCELLED MID-STREAM]`。

### R5 — initiateShutdown 的 agentPromise 参数死锁
- **风险**：`initiateShutdown(controller, agentPromise, ...)` 第二个参数是 agent 的 running promise。subagentExecutor 内部就是这个 promise，self-reference 在 race 内会死锁吗？
- **缓解**：传 `Promise.resolve()` 就行——abort 已经触发，Phase 2 grace 等的是"自己结束"，但在 executor 内部我们就是 executor 自己，传一个立即 resolve 的 promise 让 grace 立刻进 Phase 3 flush。这是合理用法（不是绕过 grace，因为 abort 信号已下发到 inference + tool，它们各自有 cleanup）。

### R6 — `parallelErrorHandler` 未来被"修"成 cascade
- **风险**：后续 PR 看到 `recoveryStrategy: 'abort'` 但没下发 abort 信号，可能误判为 bug 主动接 `abortAllRunning`，引入 LangChain Issue #694 同款 regression。
- **缓解**：在 JSDoc + cancellation.ts contract 注释中明确写死语义 + AC-C 反例 unit test 作为锁。

---

## 9. 测试计划

### Unit tests
1. **shutdownProtocol**：`createChildAbortController` 父→子传播 + 子→父隔离（已存在则补加 reason 透传断言）。
2. **CancellationReason**：CASCADE_REASONS / NON_CASCADE_REASONS 互斥且全覆盖。
3. **agentTask.saveToDisk + loadFromDisk**：cancel 后 transcript.jsonl + metadata.json 可读、status='cancelled'、partial entry 有 marker。

### E2E tests（vitest + fake LLM + fake fs）

**AC-A: scenarios/cancellation-cascade.e2e.test.ts**
```
1. mock modelRouter.inference 返回 streaming chunks
2. 主 agent run, prompt = "并行做 3 件事"
3. 等 spawnGuard.getRunningCount() === 3
4. invoke agent:cancel
5. assert within 1s:
   - effectiveSignal.aborted on all 3
   - SubagentStop hook 触发 3 次
   - 3 个 agents/<id>/transcript.jsonl 存在
   - spawnGuard.getRunningCount() === 0
```

**AC-B: scenarios/cancellation-partial-save.e2e.test.ts**
```
1. spawn 10 并行 agent
2. 让 3 个先 complete（mock inference 不同延时）
3. cancel
4. assert:
   - agents/{1,2,3}/transcript.jsonl 完整最终输出
   - agents/{4..10}/transcript.jsonl 包含 cancel 前 iteration entries
   - agents/{4..10}/metadata.json status='cancelled'
```

**AC-C: scenarios/cancellation-isolation.test.ts（反例）**
```
1. spawn 3 并行 agent
2. agent[1] 第二轮 inference 抛 Error('API timeout')
3. assert:
   - parallelCoordinator.abortAllRunning 没被调用（spy）
   - agent[0], agent[2] 跑完 success=true
   - swarm event emit 'task:error' 但 NOT 'task:cancelled'
```

**AC-D: scenarios/cancellation-idle-watchdog.test.ts**
```
1. fakeTimers (vi.useFakeTimers)
2. mock modelRouter.inference 返回 promise.never
3. start subagent.execute
4. vi.advanceTimersByTime(120_001)
5. assert: effectiveController.signal.aborted, reason='idle-timeout'
6. assert: SubagentResult.success === false, error contains 'idle-timeout'
```

### 回归测试
- 跑 `npm run test -- agent` 全套，确认 permission-inheritance 测试无 regression。
- 跑 eval suite（`npm run eval`）的 cancellation 场景子集（如有），分数不下降。

---

## 10. 工作量估算

| Phase | 内容 | 工期 |
|-------|------|------|
| 1 | Contract + 常量 | 0.5 天 |
| 2 | appService 兜底 + spawnAgent bridge | 1 天 |
| 3 | initiateShutdown + 持久化 | 1.5 天 |
| 4 | idle watchdog + 测试 + UI | 1 天 |
| **合计** | | **4 天** |

代码改动量预估：新增 ~250 行（contract + tests），修改 ~80 行（核心逻辑）。

---

## 附录 A — 关键 file:line 索引

| 主题 | 路径 | 行号 |
|------|------|------|
| 优雅关闭协议（零调用） | `src/main/agent/shutdownProtocol.ts` | 50-114 |
| AbortController 层级化 | `src/main/agent/shutdownProtocol.ts` | 173-191 |
| `subagentExecutor` abort 检测 | `src/main/agent/subagentExecutor.ts` | 761-781 |
| `subagentExecutor` 内部 controller 桥接 | `src/main/agent/subagentExecutor.ts` | 440-462 |
| 单 spawn 独立 controller（缺 bridge） | `src/main/agent/multiagentTools/spawnAgent.ts` | 284 |
| 并行 spawn signal bridge（已正确） | `src/main/agent/multiagentTools/spawnAgent.ts` | 727-732 |
| `appService.cancel`（缺 spawnGuard 兜底） | `src/main/app/agentAppService.ts` | 253-266 |
| `conversationRuntime.cancel` partial save | `src/main/agent/runtime/conversationRuntime.ts` | 1096-1123 |
| `AgentTask.saveToDisk`（cancel 路径未调） | `src/main/agent/agentTask.ts` | 162-186 |
| `parallelCoordinator.abortAllRunning` | `src/main/agent/parallelAgentCoordinator.ts` | 768-775 |
| `parallelCoordinator.abortTask` | `src/main/agent/parallelAgentCoordinator.ts` | 724-731 |
| `spawnGuard.cancelAll` | `src/main/agent/spawnGuard.ts` | 247-266 |
| `swarm:cancel-agent` IPC（renderer 零 caller） | `src/main/ipc/swarm.ipc.ts` | 254-270 |
| `parallelErrorHandler` 是建议层 | `src/main/agent/parallelErrorHandler.ts` | 204, 275-285, 297-306 |

---

> v1 完。下一步：林晨 review → 开 Phase 1 commit。
