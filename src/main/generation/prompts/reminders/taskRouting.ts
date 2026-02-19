// ============================================================================
// 任务路由提醒 - 并行派发 / 委派 / 批量操作
// ============================================================================

import type { ReminderDefinition } from './types';

/**
 * 效率与任务路由相关提醒（Priority 1-2）
 */
export const TASK_ROUTING_REMINDERS: ReminderDefinition[] = [
  {
    id: 'PARALLEL_DISPATCH',
    priority: 1,
    content: `<system-reminder>
**并行派发**：检测到多维度任务。

在单个响应中同时派发多个 task：
\`\`\`
task(subagent_type="...", prompt="维度1: ...")
task(subagent_type="...", prompt="维度2: ...")
\`\`\`
</system-reminder>`,
    tokens: 70,
    shouldInclude: (ctx) => ctx.taskFeatures.isMultiDimension ? 1 : 0,
    category: 'efficiency',
  },
  {
    id: 'MUST_DELEGATE',
    priority: 1,
    content: `<system-reminder>
**委派提醒**：复杂任务请使用 task 工具委派给子代理。

不要直接使用 glob/grep/read_file，而应该：
- 安全审计 → task(subagent_type="code-review", ...)
- 代码探索 → task(subagent_type="explore", ...)
- 架构分析 → task(subagent_type="plan", ...)
</system-reminder>`,
    tokens: 90,
    shouldInclude: (ctx) =>
      ctx.taskFeatures.isComplexTask && !ctx.taskFeatures.isMultiDimension ? 1 : 0,
    category: 'efficiency',
  },
  {
    id: 'AVOID_REDUNDANT_READS',
    priority: 2,
    content: `<system-reminder>
**避免重复读取**：当前对话中已读取过的文件无需再次读取。
可以直接引用之前的内容进行分析或修改。
</system-reminder>`,
    tokens: 50,
    shouldInclude: (ctx) =>
      ctx.toolsUsedInTurn.includes('read_file') && ctx.iterationCount > 2 ? 0.8 : 0,
    category: 'efficiency',
  },
  {
    id: 'BATCH_OPERATIONS',
    priority: 2,
    content: `<system-reminder>
**批量操作**：多个独立的工具调用应在单个响应中并行发送。
例如：同时派发多个 task，或同时读取多个文件。
</system-reminder>`,
    tokens: 50,
    shouldInclude: (ctx) =>
      ctx.iterationCount > 3 && ctx.toolsUsedInTurn.length === 1 ? 0.7 : 0,
    category: 'efficiency',
  },
  {
    id: 'LONG_CONVERSATION',
    priority: 3,
    content: `<system-reminder>
**对话较长**：当前对话已进行多轮，考虑：
1. 总结已完成的工作
2. 明确剩余任务
3. 必要时使用 todo 管理任务
</system-reminder>`,
    tokens: 50,
    shouldInclude: (ctx) => ctx.iterationCount > 10 ? 0.6 : 0,
    category: 'efficiency',
  },
  {
    id: 'ITERATION_LIMIT_WARNING',
    priority: 2,
    content: `<system-reminder>
**迭代次数警告**：已进行较多次迭代，请确保任务正在推进。
如果卡住了，考虑换一种方法或请求用户帮助。
</system-reminder>`,
    tokens: 40,
    shouldInclude: (ctx) => ctx.iterationCount > 15 ? 0.8 : 0,
    category: 'efficiency',
  },
];
