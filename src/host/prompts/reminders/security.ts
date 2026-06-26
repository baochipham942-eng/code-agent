// ============================================================================
// 安全相关提醒 - 敏感文件 / 危险操作
// ============================================================================

import type { ReminderDefinition } from './types';

/**
 * 安全相关提醒（Priority 1）
 */
export const SECURITY_REMINDERS: ReminderDefinition[] = [
  {
    id: 'SECURITY_SENSITIVE_FILE',
    priority: 1,
    content: `<system-reminder>
**敏感文件警告**：检测到可能涉及敏感文件的操作。
请勿修改或提交：.env、credentials.json、私钥文件等。
</system-reminder>`,
    tokens: 50,
    shouldInclude: (ctx) => {
      const sensitivePatterns = ['.env', 'secret', 'credential', 'key', 'token'];
      const lastResult = ctx.lastToolResult || '';
      return sensitivePatterns.some((p) => lastResult.toLowerCase().includes(p)) ? 1 : 0;
    },
    category: 'safety',
  },
  {
    id: 'DESTRUCTIVE_OPERATION_WARNING',
    priority: 1,
    content: `<system-reminder>
**危险操作警告**：以下操作需要用户明确确认：
- git reset --hard / push --force
- rm -rf
- 删除数据库数据
</system-reminder>`,
    tokens: 50,
    shouldInclude: (ctx) => {
      const lastResult = ctx.lastToolResult || '';
      const dangerousPatterns = ['--force', '--hard', 'rm -rf', 'DELETE FROM'];
      return dangerousPatterns.some((p) => lastResult.includes(p)) ? 1 : 0;
    },
    category: 'safety',
  },
];
