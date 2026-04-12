// ============================================================================
// planning/ batch — 16 工具的 wrapper 模式实现
//
// 部分工具依赖 ctx.planningService（plan_read/plan_update/findings_write/
// plan_recover_recent_work）。我们的 buildLegacyCtxFromProtocol 把
// ctx.planningService(opaque) 透传到 legacy ctx.planningService —— 验证
// opaque service handle 模式在生产工具上能跑通。
// ============================================================================

import { planRecoverRecentWorkTool } from '../../planning/planRecoverRecentWork';
import { planReadTool } from '../../planning/planRead';
import { PlanTool } from '../../planning/PlanTool';
import { confirmActionTool } from '../../planning/confirmAction';
import { taskListTool } from '../../planning/taskList';
import { taskCreateTool } from '../../planning/taskCreate';
import { planUpdateTool } from '../../planning/planUpdate';
import { taskGetTool } from '../../planning/taskGet';
import { askUserQuestionTool } from '../../planning/askUserQuestion';
import { taskUpdateTool } from '../../planning/taskUpdate';
import { TaskManagerTool } from '../../planning/TaskManagerTool';
import { enterPlanModeTool } from '../../planning/enterPlanMode';
import { exitPlanModeTool } from '../../planning/exitPlanMode';
import { PlanModeTool } from '../../planning/PlanModeTool';
import { findingsWriteTool } from '../../planning/findingsWrite';
import { taskTool } from '../../planning/task';
import { wrapLegacyTool } from '../_helpers/legacyAdapter';

const PLAN_READ = {
  category: 'planning' as const,
  permissionLevel: 'read' as const,
  readOnly: true,
  allowInPlanMode: true,
};
const PLAN_WRITE = {
  category: 'planning' as const,
  permissionLevel: 'write' as const,
  readOnly: false,
  allowInPlanMode: true, // planning 类工具大都允许 plan mode 下使用
};
const PLAN_EXECUTE = {
  category: 'planning' as const,
  permissionLevel: 'execute' as const,
  readOnly: false,
  allowInPlanMode: false,
};

// ── 计划读 ──
export const planReadModule = wrapLegacyTool(planReadTool, PLAN_READ);
export const planRecoverRecentWorkModule = wrapLegacyTool(planRecoverRecentWorkTool, PLAN_READ);

// ── 计划写 ──
export const planUpdateModule = wrapLegacyTool(planUpdateTool, PLAN_WRITE);
export const findingsWriteModule = wrapLegacyTool(findingsWriteTool, PLAN_WRITE);

// ── 计划 facade & mode ──
export const planModule = wrapLegacyTool(PlanTool, PLAN_WRITE);
export const planModeModule = wrapLegacyTool(PlanModeTool, PLAN_WRITE);
export const enterPlanModeModule = wrapLegacyTool(enterPlanModeTool, PLAN_WRITE);
export const exitPlanModeModule = wrapLegacyTool(exitPlanModeTool, PLAN_WRITE);

// ── 任务管理 ──
export const taskListModule = wrapLegacyTool(taskListTool, PLAN_READ);
export const taskGetModule = wrapLegacyTool(taskGetTool, PLAN_READ);
export const taskCreateModule = wrapLegacyTool(taskCreateTool, PLAN_WRITE);
export const taskUpdateModule = wrapLegacyTool(taskUpdateTool, PLAN_WRITE);
export const taskManagerModule = wrapLegacyTool(TaskManagerTool, PLAN_WRITE);

// ── 用户交互 / 探索 / 确认 ──
export const askUserQuestionModule = wrapLegacyTool(askUserQuestionTool, PLAN_EXECUTE);
export const confirmActionModule = wrapLegacyTool(confirmActionTool, PLAN_EXECUTE);
export const exploreModule = wrapLegacyTool(taskTool, PLAN_EXECUTE); // 'Explore'
