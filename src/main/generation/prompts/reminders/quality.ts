// ============================================================================
// 质量相关提醒 - 验证 / 类型检查 / 错误恢复
// ============================================================================

import type { ReminderDefinition } from './types';

/**
 * 质量相关提醒（Priority 1-3）
 */
export const QUALITY_REMINDERS: ReminderDefinition[] = [
  {
    id: 'VERIFY_BEFORE_COMMIT',
    priority: 2,
    content: `<system-reminder>
**验证优先**：修改代码后，先验证功能正常再通知用户。
流程：修改 → 验证 → 确认通过 → 通知
</system-reminder>`,
    tokens: 40,
    shouldInclude: (ctx) =>
      ctx.toolsUsedInTurn.includes('Edit') ? 0.5 : 0,
    category: 'quality',
  },
  {
    id: 'TYPECHECK_REMINDER',
    priority: 3,
    content: `<system-reminder>
**类型检查**：TypeScript 项目修改后，运行 npm run typecheck 确保类型正确。
</system-reminder>`,
    tokens: 30,
    shouldInclude: (ctx) =>
      ctx.toolsUsedInTurn.includes('Edit') && ctx.iterationCount > 5 ? 0.4 : 0,
    category: 'quality',
  },
  {
    id: 'ERROR_RECOVERY',
    priority: 1,
    content: `<system-reminder>
**错误恢复**：上一步操作出现错误。
请分析错误原因，考虑：
1. 是否需要更换工具或方法
2. 是否需要先解决依赖问题
3. 是否需要回退到之前的状态
</system-reminder>`,
    tokens: 60,
    shouldInclude: (ctx) => ctx.hasError ? 1 : 0,
    category: 'quality',
  },
  {
    id: 'SELF_DIAGNOSIS',
    priority: 2,
    content: `<system-reminder>
**自诊断建议**：检测到多次错误。使用 query_metrics 工具查看 error_patterns 和 tool_performance，
了解哪些工具频繁失败、错误模式是什么，有助于调整策略。
</system-reminder>`,
    tokens: 50,
    shouldInclude: (ctx) =>
      ctx.hasError && ctx.iterationCount > 3 ? 0.6 : 0,
    category: 'quality',
  },
];
