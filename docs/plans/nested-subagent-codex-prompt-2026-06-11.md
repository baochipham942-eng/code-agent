# 任务：实现嵌套子 Agent（subagent 递归 spawn，硬上限 5 层）

你是本任务的实施工程师。完整方案见 `docs/plans/nested-subagent-plan-2026-06-11.md`，先通读一遍再动手。本提示词是你的唯一任务来源，不要扩展范围。

## 背景（一句话）

当前架构通过 `MAX_DEPTH = 1` 和 `SUBAGENT_DISABLED_TOOLS` 黑名单显式禁止子 agent 再 spawn 子 agent。本任务解锁递归 spawn：默认深度 3、硬上限 5、全树共享并发配额、超时与 token 预算逐层收紧、取消与孤儿回收覆盖整棵树。

## 现有代码地图（先读这些文件，再写代码）

| 文件 | 作用 |
|------|------|
| `src/shared/constants/agent.ts:27-58` | SPAWN_GUARD 常量（MAX_DEPTH/MAX_AGENTS/超时/迭代上限） |
| `src/main/agent/spawnGuard.ts` | 并发守卫：canSpawn/checkDepth（118-142）、工具黑名单（565-587） |
| `src/main/agent/subagentExecutor.ts` | 子 agent 运行时（独立 LLM loop、超时 174-192、预算 231） |
| `src/main/agent/subagentPipeline.ts:191-193` | parentRemainingBudget 预算链 |
| `src/main/tools/modules/multiagent/task.ts` | Task 工具（spawn 入口之一） |
| `src/main/agent/multiagentTools/spawnAgent.ts` | spawn_agent 工具（spawn 入口之二） |
| `src/main/agent/childContext.ts` | strict-inherit 权限继承 |
| `src/main/agent/shutdownProtocol.ts` | 四阶段 shutdown + CASCADE_REASONS 级联取消 |
| `src/main/agent/orphanLiveness.ts` | 孤儿探活（当前单层） |
| `src/main/agent/subagentExecutorTypes.ts` | SubagentResult 类型 |
| `docs/architecture/multiagent-system.md` | 多 agent 架构全景 |

## 实施任务（按序执行，每个 Phase 独立 commit）

### Phase 1 — 深度配置与守卫

1. `constants/agent.ts`：`MAX_DEPTH` 改为 `DEFAULT_SPAWN_DEPTH = 3` + `HARD_MAX_SPAWN_DEPTH = 5`，深度可经会话配置覆盖但 clamp 到硬上限。
2. spawn 请求携带 `depth`（父深度 + 1），`spawnGuard.checkDepth` 超限时拒绝，错误信息须包含当前深度与上限（模型可读，便于它改用其他策略）。
3. `SUBAGENT_DISABLED_TOOLS`：**仅放行** `spawn_agent`/`AgentSpawn`/`Task`。`ask_user_question`、`workflow`、`teammate`、`plan_review`、`agent_message`、`wait_agent`、`close_agent`、`send_input` 维持禁用，并加注释说明为何保留。

### Phase 2 — 全树并发配额

4. `MAX_AGENTS = 6` 的单层语义改为**全树总配额**（新常量 `MAX_TREE_AGENTS = 8`）：以根 agent 为单位维护一个槽位池，整棵 spawn 树共享；任意时刻树内运行中的 agent 总数 ≤ 配额。
5. 超额 spawn 请求**排队**（FIFO，带等待超时），不报错丢弃；等待超时后返回明确错误。
6. 槽位在 agent 结束（完成/失败/取消）时释放，注意取消路径也必须释放（用 finally 保证）。

### Phase 3 — 超时与预算链

7. 子 agent 执行超时 = min(角色默认超时, 父 agent 剩余时间 × 0.8)，避免深层 agent 继承已耗尽的时间窗。剩余时间从父 agent 启动时刻计算。
8. 审计 `parentRemainingBudget` 在多层传递下的正确性：每层 spawn 时把自身剩余预算作为子层上限传入；子层消耗实时回灌父层计数。补充 3 层链路的预算单测。
9. `SubagentResult.tokensUsed`/`cost` 逐层向上累加：父 agent 的统计 = 自身消耗 + 所有后代消耗，根 agent 能看到全树总账。

### Phase 4 — 取消级联与孤儿回收

10. 验证并补强 `CASCADE_REASONS` 在 N 层下的穿透：用户取消/会话切换 → 全树后代终止；中间层超时/错误 → 仅该子树被清理，兄弟子树继续。
11. `orphanLiveness` 升级为树遍历：维护 parent→children 映射，任一节点失活时 DFS 回收其全部后代；新增"父已死、子仍在跑"的检测路径。

### Phase 5 — 工具描述与蒸馏约定

12. 更新 `Task`/`spawn_agent` 的工具描述（description 字段），写入显式路由规则：任务呈树状（调查/重构/逐层汇总）→ 嵌套 spawn；平行互不依赖 → 并行 multi-agent；单一事实查找/已知文件位置 → 不派 agent。明确"嵌套用于 context 卸载，不是并行加速；优先 2-3 层"。
13. 子 agent 系统提示追加蒸馏约定："你的最终输出是返回给父 agent 的数据，只返回结论、关键文件路径和必要证据，不要转发原始文件内容。"

## 硬护栏（违反任何一条即停下说明情况，不要继续）

- **TDD**：每个 Phase 先写失败测试再实现。深度拒绝、配额排队、取消级联、预算链是必测项。
- **Scope 锁死**：只改上方代码地图列出的文件及其直接依赖、对应测试文件。不碰 UI/渲染层（swarm monitor 树形视图明确不在本期范围）、不碰 roadmap、不重构无关代码。
- **Per-Phase commit**：每个 Phase 一个 commit，message 格式 `feat(multiagent): phase N - <内容>`。不要 push。
- **禁改文档**：除在 `docs/plans/nested-subagent-plan-2026-06-11.md` 末尾追加实施记录外，不修改任何其他 docs。
- **回归 gate**：每个 Phase 完成后跑既有 multiagent 相关测试套件，全绿才能进入下一 Phase；变红先修复，修不了就停下报告。
- **不可逆操作禁止**：不删文件、不改 git 历史、不动 CI 配置。

## 验收清单（全部勾掉才算完成）

- [ ] 深度 3 端到端：主→子→孙 spawn 成功，孙结果逐层返回到根
- [ ] 深度 6 的 spawn 被拒绝，错误信息含深度与上限
- [ ] 并发压测：树内同时请求 20 个 agent，任意时刻运行数 ≤ 8，排队请求最终全部执行或超时报错
- [ ] 用户取消 → 全树终止，无孤儿（用 3 层树验证）
- [ ] 中间层 agent 被杀 → 其后代被回收，兄弟子树不受影响
- [ ] 3 层链路 token/cost 累加正确（根看到全树总账）
- [ ] 既有单层 multi-agent 测试零回归
- [ ] 每个 Phase 有独立 commit + 对应测试

## 完成后输出

按以下结构汇报：每个 Phase 的 commit hash、新增/修改文件清单、测试结果（新增 X 个，全套 Y 通过/Z 失败）、遗留问题与建议（如有）。
