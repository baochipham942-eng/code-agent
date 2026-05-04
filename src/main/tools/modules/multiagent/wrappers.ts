// ============================================================================
// multiagent/ batch — 9 工具的 wrapper 模式实现
//
// 关键验证：这些工具大量依赖 ctx.toolRegistry / ctx.modelConfig / ctx.hookManager
// (legacy 字段)。我们的 buildLegacyCtxFromProtocol 会从 ctx.legacyToolRegistry /
// ctx.modelConfig / ctx.hookManager (新 ctx 字段) 反向映射回去。本批是
// P0-5 ctx 扩展字段在生产工具上的真实压力测试。
// ============================================================================

import { workflowOrchestrateTool } from '../../../agent/multiagentTools/workflowOrchestrate';
import { wrapLegacyTool } from '../_helpers/legacyAdapter';

const MA_EXECUTE = { category: 'multiagent' as const, permissionLevel: 'execute' as const };

// workflow 涉及子进程或副作用 → execute
// task / teammate / spawn_agent / AgentSpawn: 已迁移到 Level 2 native，
// 见 ./{task,teammate,spawnAgent}.ts
// agentSpawn / spawn_agent: 已迁移到 Level 2 native，见 ./spawnAgent.ts
// closeAgent / sendInput: 已迁移到 Level 2 native，见 ./{closeAgent,sendInput}.ts
export const workflowOrchestrateModule = wrapLegacyTool(workflowOrchestrateTool, MA_EXECUTE);
// agentMessage: 已迁移到 Level 2 native，见 ./agentMessage.ts

// wait/planReview: 已迁移到 Level 2 native，见 ./waitAgent.ts / ./planReview.ts
