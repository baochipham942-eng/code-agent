// ============================================================================
// 工具使用提醒 - edit vs write / task 委派 / git 提交
// ============================================================================

import type { ReminderDefinition } from './types';

/**
 * 工具使用相关提醒（Priority 2）
 */
export const TOOL_USAGE_REMINDERS: ReminderDefinition[] = [
  {
    id: 'EDIT_NOT_WRITE',
    priority: 2,
    content: `<system-reminder>
**优先使用 edit_file**：修改现有文件时，使用 edit_file 而非 write_file。
edit_file 更安全，只修改指定部分，减少意外覆盖。
</system-reminder>`,
    tokens: 50,
    shouldInclude: (ctx) =>
      ctx.toolsUsedInTurn.includes('write_file') ? 0.9 : 0,
    category: 'tool',
  },
  {
    id: 'TASK_NOT_DIRECT',
    priority: 2,
    content: `<system-reminder>
**使用 task 工具**：对于需要多步骤探索的任务，使用 task 工具委派给专门的子代理。
子代理有专门的工具和上下文窗口，比直接执行更高效。
</system-reminder>`,
    tokens: 60,
    shouldInclude: (ctx) => {
      const directTools = ['glob', 'grep', 'read_file'];
      const usedDirectTools = directTools.filter((t) =>
        ctx.toolsUsedInTurn.includes(t)
      );
      return usedDirectTools.length >= 2 ? 0.8 : 0;
    },
    category: 'tool',
  },
  {
    id: 'GIT_COMMIT_REMINDER',
    priority: 2,
    content: `<system-reminder>
**Git 提交**：完成功能修改后，记得提交变更：
1. git add <具体文件>（不要用 -A）
2. 写有意义的 commit message
3. 除非用户明确要求，否则不要 push
</system-reminder>`,
    tokens: 60,
    shouldInclude: (ctx) =>
      ctx.toolsUsedInTurn.includes('edit_file') ||
      ctx.toolsUsedInTurn.includes('write_file')
        ? 0.3
        : 0,
    category: 'tool',
  },
];
