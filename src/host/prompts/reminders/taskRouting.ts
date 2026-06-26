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

使用 AgentSpawn 的 parallel 模式，或用 workflow 编排多代理 fan-out/fan-in：
\`\`\`
{
  "parallel": true,
  "agents": [
    { "role": "reviewer", "task": "维度1: ..." },
    { "role": "explore", "task": "维度2: ..." }
  ]
}
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
**委派提醒**：需要广泛探索的复杂任务可以使用 Task 工具委派给单个同步子代理；需要并行、后台或自定义控制时用 AgentSpawn。

如果目标文件、函数、编辑区域已经明确，直接使用 Read/Grep/Edit 完成。
需要委派时使用真实工具名：
- 安全审计 → Task，参数 {"subagent_type": "reviewer", "prompt": "..."}
- 代码探索 → Task，参数 {"subagent_type": "explore", "prompt": "..."}
- 架构分析 → Task，参数 {"subagent_type": "plan", "prompt": "..."}
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
      ctx.toolsUsedInTurn.includes('Read') && ctx.iterationCount > 2 ? 0.8 : 0,
    category: 'efficiency',
  },
  {
    id: 'BATCH_OPERATIONS',
    priority: 2,
    content: `<system-reminder>
**批量操作**：多个独立的工具调用应在单个响应中并行发送。
例如：同时读取多个文件；多路子代理并行用 AgentSpawn。
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
