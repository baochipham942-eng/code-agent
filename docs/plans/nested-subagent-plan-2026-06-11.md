# 嵌套子 Agent（Subagent Spawning Subagent）实施方案

> 日期：2026-06-11
> 状态：待实施
> 对标：Claude Code v2.1.172（2026-06-10）发布的 subagent 嵌套能力，官方上限 5 层
> 实施人：艾克斯（Codex），提示词见附录 A

---

## 1. 背景与动机

Claude Code v2.1.172 正式支持子 agent 递归创建子 agent，最大嵌套深度 5 层。官方明确该能力的设计动机是**上下文卸载（context offload）而非并行加速**：每个子 agent 获得独立干净的 context window，深层任务在自身 context 溢出前把工作下放，结果逐层蒸馏返回。

官方提到的典型场景：
- **递归式代码库调查** — 子 agent 读文件快满时再派孙 agent 钻具体链路，逐层只返回结论
- **跨系统 bug 追踪** — 调查树顺着线索自然生长，不必每次回到根节点重新派人
- **大规模重构（10+ 子系统）** — 每层只持有自己粒度的上下文，总指挥只看完成/失败状态

来源：
- https://code.claude.com/docs/en/sub-agents.md
- https://code.claude.com/docs/en/changelog.md （v2.1.172）

## 2. 现状盘点（2026-06-11 探索结论）

当前架构**显式禁止递归**，但嵌套所需的防护地基已基本齐备：

| 组件 | 现状 | 关键位置 |
|------|------|----------|
| 深度限制 | `MAX_DEPTH = 1`（主→子一层） | `src/shared/constants/agent.ts:35` |
| 递归入口封锁 | `SUBAGENT_DISABLED_TOOLS` 黑名单禁用 `spawn_agent`/`Task` 等 | `src/main/agent/spawnGuard.ts:565-587` |
| 并发控制 | `MAX_AGENTS = 6`，按单层计算 | `src/shared/constants/agent.ts:29` |
| Token 预算级联 | 已有 `parentRemainingBudget` 链式约束 | `src/main/agent/subagentPipeline.ts:191-193` |
| 权限继承 | `strict-inherit` 模式，deny = parent ∪ child | `src/main/agent/childContext.ts` |
| 取消级联 | `CASCADE_REASONS` 向下穿透，非级联原因只影响单 agent | `src/main/agent/shutdownProtocol.ts` |
| 子 agent 运行时 | 独立 LLM loop + 独立 ModelRouter + AbortController | `src/main/agent/subagentExecutor.ts` |
| 超时 | 按角色 60-300s 固定值 + idle 超时 | `src/shared/constants/agent.ts:39-47` |
| 孤儿回收 | 单层探活 | `src/main/agent/orphanLiveness.ts` |
| 结果返回 | `SubagentResult`（output 文本 + tokensUsed + cost + 元数据） | `src/main/agent/subagentExecutorTypes.ts` |

## 3. Gap 分析与改造代价

| # | 改造项 | 代价 | 说明 |
|---|--------|------|------|
| G1 | 深度限制 1→N（默认 3，硬上限 5） | ⭐ 极低 | 常量改为可配置 + spawnGuard 深度检查 |
| G2 | 黑名单放行 spawn 入口 | ⭐ 极低 | 仅放行 `spawn_agent`/`Task`，其余（`ask_user_question`/`workflow`/`teammate` 等）继续禁用 |
| G3 | **并发配额重设计** | ⭐⭐⭐ 中 | 单层 `MAX_AGENTS=6` 在 5 层下最坏 6⁵≈7776 并发。必须改为**全树总配额**（树内共享槽位，超额排队） |
| G4 | 超时按深度动态分配 | ⭐⭐ 低 | 子层超时 ≤ 父层剩余时间，避免深层一启动就超时 |
| G5 | Token 预算链式传递到 N 层 | ⭐ 极低 | 框架已有，审计每层转发逻辑即可 |
| G6 | 孤儿回收升级为树遍历 | ⭐⭐⭐ 中 | 任一中间层断掉时 DFS 清理所有后代 |
| G7 | 树形可观测性（UI + telemetry 按深度聚合） | ⭐⭐⭐⭐ 高 | swarm monitor 列表→树形视图。**本期不做，单列后续迭代** |
| G8 | 深度任务 eval 用例 | ⭐⭐ 低 | 对比 1 层 vs 3 层成本/质量曲线，防 token 失控 |

工期粗估：核心机制（G1/G2/G5）2-3 天，并发+超时+孤儿（G3/G4/G6）2-3 天，eval（G8）1 天。G7 另排。

## 4. 关键设计决策

1. **默认深度 3，硬上限 5，深度 4-5 仅显式 opt-in**。官方都只敢给 5 层，层级越深逐层转述的信息失真越严重（telephone game）。
2. **全树总配额取代分层配额**：整棵 spawn 树共享一个槽位池（建议 8），深层 spawn 请求排队等空闲槽位，而不是每层独立 6 个。
3. **模式路由靠工具描述，不靠模型自悟**。`Task`/`spawn_agent` 的工具描述必须写入显式决策规则：

   | 任务信号 | 路由 |
   |---|---|
   | 任务是一棵树（调查/重构/逐层汇总） | 嵌套 spawn |
   | 平行多条线、互不依赖 | 并行 multi-agent（现有 L0/L1） |
   | 长时间运行且用户不等结果 | background task |
   | 需要 agent 间实时讨论 | agent team（L3，未实现） |

   并写明反例："单一事实查找/已知文件位置 → 不要派 agent"。
4. **结果逐层蒸馏**：子 agent 系统提示中明确"你的最终输出是给父 agent 的数据，不是给用户的消息"，只返回结论和关键路径，不转发原始文件内容。
5. **取消语义沿用现有三层级联**：用户取消 → 全树 flush；中间层超时/错误 → 只清理该子树，兄弟子树不受影响。

## 5. 风险清单

| 风险 | 缓解 |
|------|------|
| 并发爆炸（6⁵） | G3 全树配额，硬性槽位池 |
| Token 消耗失控 | G5 预算链 + G8 eval 先行，上线前跑成本曲线 |
| 深层超时级联 | G4 子超时 ≤ 父剩余时间 |
| 孤儿泄漏 | G6 树形 DFS 回收 + 心跳探活 |
| 信息逐层失真 | 默认深度 3 + 蒸馏式返回约定 |

## 6. 验收标准

- [ ] 深度 3 嵌套任务端到端可跑通（主→子→孙），孙 agent 结果逐层返回
- [ ] 深度超限（>configured max）的 spawn 请求被 spawnGuard 拒绝并返回明确错误
- [ ] 全树并发任意时刻 ≤ 配额，超额请求排队不丢失
- [ ] 用户取消 → 全树所有后代在 shutdown 协议时限内终止，无孤儿进程
- [ ] 中间层 agent 崩溃 → 其后代被回收，兄弟子树不受影响
- [ ] 每层 token/cost 正确累加上报到根
- [ ] 既有单层 multi-agent 测试全部通过（无回归）
- [ ] 新增深度场景单测 + 集成测试

---

## 附录 A：给艾克斯（Codex）的实施提示词

见同目录 `nested-subagent-codex-prompt-2026-06-11.md`，或直接复制下方内容。

（提示词正文以独立文件交付，便于直接喂给 Codex CLI。）

---

## 实施记录（2026-06-11）

Phase commits:

- Phase 1 深度配置与守卫：`8c00205de` `feat(multiagent): phase 1 - depth guard`
- Phase 2 全树并发配额：`4399e1572` `feat(multiagent): phase 2 - tree quota`
- Phase 3 超时预算链与统计回灌：`af068107a` `feat(multiagent): phase 3 - timeout budget accounting`
- Phase 4 取消级联与孤儿回收：`a1c87b405` `feat(multiagent): phase 4 - cancellation orphan tree`
- Phase 5 工具描述与蒸馏约定：`099444ec5` `feat(multiagent): phase 5 - routing prompts`

Final verification:

- `npx vitest run tests/unit/agent/spawnGuard.test.ts tests/unit/agent/parallelAgentCoordinator.test.ts tests/unit/agent/spawnAgent.depthGuard.test.ts tests/unit/agent/subagentIdleTimeout.test.ts tests/unit/agent/subagentPipeline.test.ts tests/unit/agent/subagentUsageAccounting.test.ts tests/unit/agent/subagentExecutorHelpers.test.ts tests/unit/agent/subagentExecutor.orphanReclamation.test.ts tests/unit/agent/orphanLiveness.test.ts tests/unit/agent/cancelCorrectness.test.ts tests/unit/agent/sendInput.test.ts tests/unit/tools/modules/multiagent/task.test.ts tests/unit/tools/modules/multiagent/spawnAgent.test.ts tests/unit/tools/modules/multiagent/waitAgent.test.ts tests/unit/tools/modules/multiagent/closeAgent.test.ts tests/unit/tools/modules/multiagent/sendInput.test.ts tests/unit/tools/modules/multiagent/agentMessage.test.ts tests/unit/tools/multiagentProtocolSchema.test.ts tests/unit/tools/toolExecutor.subagentPolicy.test.ts`
- Result: 19 test files passed, 231 tests passed.

Post-implementation validation addendum:

- Runtime closure fix: core subagents now expose `Task`/`spawn_agent`; subagent policy and permission classifier allow internal delegation tools while ordinary command/file/network checks remain on the child agent; `writeIsolation` no longer holds a workspace lock for pure delegation tools.
- Regression: `npx vitest run tests/unit/agent/spawnGuard.test.ts tests/unit/agent/parallelAgentCoordinator.test.ts tests/unit/agent/spawnAgent.depthGuard.test.ts tests/unit/agent/subagentIdleTimeout.test.ts tests/unit/agent/subagentPipeline.test.ts tests/unit/agent/subagentUsageAccounting.test.ts tests/unit/agent/subagentExecutorHelpers.test.ts tests/unit/agent/subagentExecutor.orphanReclamation.test.ts tests/unit/agent/orphanLiveness.test.ts tests/unit/agent/cancelCorrectness.test.ts tests/unit/agent/sendInput.test.ts tests/unit/tools/modules/multiagent/task.test.ts tests/unit/tools/modules/multiagent/spawnAgent.test.ts tests/unit/tools/modules/multiagent/waitAgent.test.ts tests/unit/tools/modules/multiagent/closeAgent.test.ts tests/unit/tools/modules/multiagent/sendInput.test.ts tests/unit/tools/modules/multiagent/agentMessage.test.ts tests/unit/tools/multiagentProtocolSchema.test.ts tests/unit/tools/toolExecutor.subagentPolicy.test.ts tests/unit/tools/toolExecutor.writeIsolation.test.ts tests/unit/permissions/guardFabric.test.ts tests/unit/agent/agentDefinition.test.ts tests/unit/tools/permissionClassifier.test.ts` -> 23 files passed, 306 tests passed.
- Build: `npm run build:web` passed.
- In-app browser live verification: model selector showed `Neo·MiMo v2.5 Pro·Think·High`; session `session_1781189739872_7bd6ae12`; visible final answer was `MIMO_NESTED_VERIFY_OK 看到了 NESTED_OK_DEPTH_2`. Audit confirmed root `Task` -> first-level coder `Task` -> second-level coder output `NESTED_OK_DEPTH_2`.
