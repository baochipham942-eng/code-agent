# ADR-047：组队配方采用主理人编排，确定性 coordinator 作为降级路径

- 状态：accepted
- 日期：2026-07-22（随 #559–#569 合入）

## 背景

原有组队启动把配方直接编译为扁平的 members，再由 `parallelAgentCoordinator` 所在的确定性路径启动。它能稳定执行成员任务，但无法让一个有角色资产的主理人在正常会话中接收成员回报、讨论并定稿。配方现在显式区分 `lead` 与 `members`，且成员既可有同角色多实例，也可用 `dependsOn` 构成 DAG。

曾有一个错误前提：lead 带成员就不会有短超时。实际两条路径都经 `subagentExecutor` 执行子 agent，idle 看门狗会安装到每个子 agent；单次模型调用超过 120 秒而尚未返回时，仍可能被切断。因此主理人编排解决的是角色化协作和会话体验，不是超时修复。

## 决策

1. 有 `lead` 的配方由 `teamRecipeLaunchService` 通过当前会话的 `orchestrator.sendMessage()` 发起一个正常主会话轮；以 `agentOverrideId` 和 `turnSystemContext` 注入 lead 的角色块。lead 按简报调用 `spawn_agent(parallel=true)` 拉起成员、汇总成员产出并定稿。
2. `parallelAgentCoordinator` 的确定性启动路径保留为降级路径：无 lead、拿不到 orchestrator 或角色块、lead 轮抛错，或铁律校验确认没有成员运行时，均转到该路径。
3. lead 首轮的工具合同由纯函数 `buildLeadBrief()` 固定：一次并行 `spawn_agent`，不允许 lead 自行代写成员专业产出。该函数以单测锁住简报与调用形状。
4. lead 轮完成后，以 `SpawnGuard` 与持久化 `swarm_runs` 的并集核验本轮是否有成员运行。两边都未发现成员时丢弃 lead 自写稿并降级；查询本身出错时按成员已跑处理，不重跑。
5. 组队仍使用 `SwarmLaunchApprovalGate`：有 renderer 时，存在写权限成员需显式批准，120 秒未决自动拒绝（无 renderer 的 headless 启动按 gate 的自动批准规则处理）。Durable 启动保持每 session 一个活跃根 run，根 run 与 `agent_team` child 可共存；冷启时先有界等待 `RunRegistry.waitForDurableKernel()`。

## 理由

主理人运行在正常会话轮，角色 L0/L1、对话讨论流、审批、durable 生命周期和既有成本护栏都不需要另造一条产品路径。成员执行仍复用同一子 agent 执行器，超时行为也因此保持一致。

弱模型的编排风险由三层共同压住：确定性 `buildLeadBrief()` 脚手架与单测、禁止 lead 代写的运行后铁律校验、以及可解释的三类降级。每个降级原因写入 `console.warn`，不能静默切换。

成本安全只允许在“成员根本没跑”时降级重跑。成员已经运行但没有可归档定稿，或成员运行查询出错，都只告警、不重跑，避免为取稿失败或观测失败再付一次完整团队成本。

## 影响面

- 配方合同与目录：`src/shared/contract/teamRecipe.ts`、`src/shared/constants/teamRecipeCatalog.ts`。
- 启动、验真、归档与 durable 等待：`src/host/services/team/teamRecipeLaunchService.ts`、`src/host/runtime/runRegistry.ts`。
- 审批与子 agent 执行：`src/host/agent/swarmLaunchApproval.ts`、`src/host/agent/subagentExecutor.ts`。
- deferred tool 模式下，字面命中 `spawn_agent` 的用户文本会由 `contextAssembly/deferredToolPreload.ts` 预载工具，避免 lead 首轮额外 ToolSearch 往返。

## 替代方案

- **持续只用确定性 coordinator**：执行稳定，但无法让角色化 lead 在主会话中编排、讨论和定稿。
- **lead 直接代写所有成员产出**：看似减少调用，但破坏成员分工，也会把表面成功误作团队完成。
- **成员跑过后仍因无定稿或查询失败重跑**：会重复消耗整队预算，且可能重复产生会话讨论与产物。
