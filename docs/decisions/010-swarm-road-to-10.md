# ADR-010: Swarm 系统到 10/10 的收敛路线

> 状态: accepted
> 日期: 2026-04-14

## 背景

2026-04-13 到 2026-04-14 这两轮 session，对 Codex code review 的 3 条反馈做了闭环：

1. **Legacy re-export cleanup** — `swarm.ipc.ts` 去掉对 `getSwarmEventEmitter` 的
   兼容转发（commit `2c6681de`）
2. **SwarmServices 解耦** — IPC 层不再硬 import 6 个业务单例，改走 registry
   （commits `c3328fd9` / `0188c347` / `8a37bfdf`）
3. **E2E chain 验证** — 15 个集成测试 + 15 个 renderer store 单测 + 2 个
   Playwright e2e 贯穿"后端事件 → SSE → EventSource → swarmStore → DOM"
   全链路（commits `e1b07d13` / `adb62cf7` / `a6f76856`）

此外顺带修了一个 web 模式下的生产 bug：`BrowserWindow.getAllWindows()` 硬编码
返回 `[]` 导致 swarm event 根本到不了 renderer（commit `e42723bf`）。

这一轮收尾后做了一次架构评估。结论是当前 swarm 系统距离"10/10 生产级"
还有 6 条可度量的差距。本 ADR 固化路线，**明确 in-scope 和 out-of-scope**，
防止后续会话把已经砍掉的方向又捡回来。

## In-scope（要做）

### 1. CI 稳定证据

**现状**：e2e 文件存在，单机跑通，但没进 CI 长期门禁。

**目标**：
- E2E 分层：冒烟（<30s）走 PR 每次；完整（含 Playwright webServer 构建，~60s）
  走 merge gate
- Flake 重试上限 1 次，失败强制截图 + trace 附件
- 记录连续通过次数作为健康指标

**不做**：在 CI 里跑所有交互式 swarm 场景（太贵）。

### 2. 审批持久化（80 分版）

**现状**：`planApproval.pendingResolvers` / `swarmLaunchApproval.pendingResolvers`
都是进程内 Map。主进程重启后 pending approval 全丢。

**目标**：
- SQLite 存 pending approval 记录（plan/launch request + 元数据）
- 启动时读表复活 pendingResolvers，向 renderer 重新发 request 事件
- **明确恢复语义**：重启后用户看到的是"重新请求批准"，不是"从上次继续"

**不做（95 分版）**：跨进程 token 迁移、跨窗口 session 复活。理由：桌面单进程
应用，崩溃后干净重请求更符合用户直觉，也更便宜。

### 3. ParallelAgentCoordinator checkpoint

**现状**：`autoAgentCoordinator.ts:111` 已有 checkpoint 机制（sequential /
parallel / hybrid 策略）。`parallelAgentCoordinator.ts` 作为 LLM 显式调用入口
没有同等级的 DAG 断点恢复能力。

**目标**：对称补上。crash 后重启能从上次完成的节点继续跑剩余 DAG。

**理由**：ADR-009 已经明确两个协调器分家不合并，那它们就应该在"crash-safe"
这种基础能力上对称。

### 4. Chaos / Soak 测试（按优先级）

**现状**：单测 + 集成 + e2e 都测 happy path，没测异常序列。

**优先级**：
1. **SSE 重连**：断线 5s 后自动重连，重连期间的事件是否丢
2. **重复事件 / 乱序事件**：EventBus 重放时 handler 是否幂等
3. **取消正确性**：swarm 中途 cancel，`spawnGuard` / coordinator /
   `sharedContext` / 子 agent 进程 / 在途 LLM 流是否都干净关闭
4. 长跑资源泄漏（listeners / timers）
5. kill 主进程 → 恢复

前 3 条是真正经常发生的路径，值得优先；后 2 条是边缘情况。

### 5. Swarm Trace 持久化

**现状**：`swarmStore.eventLog` 上限 80 条，只给 UI 用，没有后端审计存储。

**目标**：
- 每个 swarm run 写一条 session + 时间线事件到 SQLite
- 记录 agent 维度的 token / cost / tool calls / 失败归因
- UI 可以回看历史 swarm run 的完整 timeline

**理由**：这条原本不在 Codex review 的扣分清单里，但它**比 #4 team blackboard
价值高得多**——给用户回溯 "上次那个 swarm 为什么失败" 的能力，是产品层面的
差异化，不是架构层面的炫技。

### 6. 取消正确性 + 幂等保证

**现状**：cancel 逻辑在 `swarmChain.test.ts` 覆盖了"谁响应 cancel"的路径选择，
但没覆盖"cancel 后系统整体状态的一致性"。

**目标**：
- 取消中途的 swarm 后：pendingResolvers 清空、spawnGuard 配额释放、
  shared context 不留 stale 状态、在途 LLM 流 abort
- 事件 handler 全部幂等（为 #4 chaos 做铺垫）

## Out-of-scope（刻意不做）

### ❌ Team Blackboard（命名空间 / 版本 / TTL / 回放 / 冲突语义）

**原设想**：把 `agentBus` + `taskClaimService` 升级为带命名空间、版本、TTL、
回放、崩溃恢复和冲突语义的"team blackboard"。

**为什么砍**：这是 architecture astronaut 倾向。当前应用是 **桌面单进程单窗口**
本地工具，现有的 in-memory + 乐观锁对当前 workload 完全够。加这一层会：

- 引入一个小型分布式 KV 的复杂度
- 给维护面加一个必须长期维护的抽象
- 收益不可度量（没人能说清"有了 blackboard 具体修了哪个 bug"）

**重新捡回的前提条件**（任一成立再讨论）：
1. 出现多窗口并发跑 swarm 的产品需求
2. 跨机分发 agent（分布式 swarm）
3. 给用户一个"回放 swarm 会话"的功能（而且 #5 trace 持久化方案不够）

如果以上都不成立，不许再把这条捡回来。

## 评分对照

| 条目 | 现状 | 目标 | 难度 |
|------|------|------|------|
| #1 CI 稳定 | 6/10 | 10/10 | 低 |
| #2 审批持久化 | 5/10 | 8/10 | 中 |
| #3 Parallel checkpoint | 4/10 | 9/10 | 中 |
| #4 Chaos/soak | 3/10 | 8/10 | 中高 |
| #5 Trace 持久化 | 2/10 | 9/10 | 中 |
| #6 Cancel + 幂等 | 5/10 | 9/10 | 中 |

6 条做完对应到 swarm 整体 ~9/10。剩下 1 分留给"真正的不确定性"——某些
场景现在还看不到。

## 执行顺序建议

1. **先做 #1 + #6** — 前者不做，后面任何优化都无法验证没退化；后者是 #4 的
   前置条件。
2. **然后 #3** — 纯机械化的对称补齐，风险低。
3. **再做 #5** — 产品价值最高。
4. **#2 和 #4 平行** — 互不依赖。

每一条独立开一个新会话做，本 ADR 作为上下文重建的锚点。

## 相关

- ADR-007: Swarm control-plane 重构主线
- ADR-008: SwarmEventEmitter 迁出 swarm.ipc
- ADR-009: AutoAgentCoordinator 与 ParallelAgentCoordinator 分家
