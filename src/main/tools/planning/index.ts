// ============================================================================
// Planning Tools - 规划工具
// ============================================================================

export { taskTool } from './task';
// todoWriteTool removed — agentLoop auto-parses task lists
export { askUserQuestionTool } from './askUserQuestion';
export { confirmActionTool } from './confirmAction';
export { planReadTool } from './planRead';
export { planUpdateTool } from './planUpdate';
export { planRecoverRecentWorkTool } from './planRecoverRecentWork';
// enter_plan_mode / exit_plan_mode 已迁移到 src/main/tools/modules/planning/
export { findingsWriteTool } from './findingsWrite';

// Task API (Claude Code 2.x compatible)
export { taskCreateTool } from './taskCreate';
export { taskGetTool } from './taskGet';
export { taskListTool } from './taskList';
export { taskUpdateTool } from './taskUpdate';

// Task Store utilities
export { listTasks, getIncompleteTasks, clearTasks } from '../../services/planning/taskStore';

// Unified tools (Phase 2)
export { TaskManagerTool } from './TaskManagerTool';
export { PlanTool } from './PlanTool';
// PlanModeTool 已迁移到 src/main/tools/modules/planning/planModeFacade.ts
