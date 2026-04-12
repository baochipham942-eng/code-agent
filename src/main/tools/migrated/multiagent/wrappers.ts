// ============================================================================
// multiagent/ batch — 9 工具的 wrapper 模式实现
//
// 关键验证：这些工具大量依赖 ctx.toolRegistry / ctx.modelConfig / ctx.hookManager
// (legacy 字段)。我们的 buildLegacyCtxFromProtocol 会从 ctx.legacyToolRegistry /
// ctx.modelConfig / ctx.hookManager (新 ctx 字段) 反向映射回去。本批是
// P0-5 ctx 扩展字段在生产工具上的真实压力测试。
// ============================================================================

import { sdkTaskTool } from '../../multiagent/task';
import { teammateTool } from '../../multiagent/teammate';
import { spawnAgentTool } from '../../multiagent/spawnAgent';
import { waitAgentTool } from '../../multiagent/waitAgent';
import { closeAgentTool } from '../../multiagent/closeAgent';
import { agentMessageTool } from '../../multiagent/agentMessage';
import { sendInputTool } from '../../multiagent/sendInput';
import { workflowOrchestrateTool } from '../../multiagent/workflowOrchestrate';
import { planReviewTool } from '../../multiagent/planReview';
import { wrapLegacyTool } from '../_helpers/legacyAdapter';

const MA_EXECUTE = { category: 'multiagent' as const, permissionLevel: 'execute' as const };
const MA_READ = {
  category: 'multiagent' as const,
  permissionLevel: 'read' as const,
  readOnly: true,
  allowInPlanMode: true,
};

// Task / spawn / workflow / teammate 都涉及子进程或副作用 → execute
export const taskModule = wrapLegacyTool(sdkTaskTool, MA_EXECUTE);
export const teammateModule = wrapLegacyTool(teammateTool, MA_EXECUTE);
export const spawnAgentModule = wrapLegacyTool(spawnAgentTool, MA_EXECUTE);
export const closeAgentModule = wrapLegacyTool(closeAgentTool, MA_EXECUTE);
export const sendInputModule = wrapLegacyTool(sendInputTool, MA_EXECUTE);
export const workflowOrchestrateModule = wrapLegacyTool(workflowOrchestrateTool, MA_EXECUTE);
export const agentMessageModule = wrapLegacyTool(agentMessageTool, MA_EXECUTE);

// wait / planReview 是 read-ish（只读子 agent 状态/结果）
export const waitAgentModule = wrapLegacyTool(waitAgentTool, MA_READ);
export const planReviewModule = wrapLegacyTool(planReviewTool, MA_READ);
