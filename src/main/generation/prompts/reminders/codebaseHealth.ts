// ============================================================================
// 代码库健康提醒 - GC 扫描结果注入 Agent 上下文
// ============================================================================
// Harness Engineering P2b: 扫描结果缓存 → 动态提醒系统读取 → 注入 agent 上下文

import type { ReminderDefinition } from './types';

/**
 * 代码库健康提醒（Priority 2-3）
 */
export const CODEBASE_HEALTH_REMINDERS: ReminderDefinition[] = [
  {
    id: 'GC_TYPECHECK_ALERT',
    priority: 2,
    content: `<system-reminder>
**代码库健康警告**：TypeScript 类型检查发现错误。
运行 \`npm run typecheck\` 修复类型错误后再继续。
</system-reminder>`,
    tokens: 40,
    shouldInclude: (ctx) => {
      try {
        const { getCodebaseHealthScanner } = require('../../agent/gc/codebaseHealthScanner');
        const scanner = getCodebaseHealthScanner();
        const result = scanner.getLastScanResult();
        if (!result) return 0;
        const typecheck = result.checks.find((c: { name: string }) => c.name === 'typecheck_freshness');
        return typecheck && !typecheck.passed ? 0.8 : 0;
      } catch {
        return 0;
      }
    },
    category: 'quality',
  },
  {
    id: 'GC_HARDCODED_ALERT',
    priority: 2,
    content: `<system-reminder>
**代码库健康警告**：检测到硬编码值违规。
检查 \`shared/constants.ts\`，确保所有常量值从配置文件导入。
</system-reminder>`,
    tokens: 45,
    shouldInclude: (ctx) => {
      try {
        const { getCodebaseHealthScanner } = require('../../agent/gc/codebaseHealthScanner');
        const scanner = getCodebaseHealthScanner();
        const result = scanner.getLastScanResult();
        if (!result) return 0;
        const hardcoded = result.checks.find((c: { name: string }) => c.name === 'hardcoded_values');
        return hardcoded && !hardcoded.passed ? 0.7 : 0;
      } catch {
        return 0;
      }
    },
    category: 'quality',
  },
  {
    id: 'GC_HEALTH_SUMMARY',
    priority: 3,
    content: `<system-reminder>
**代码库健康检查**：使用 \`query_metrics\` 工具的 \`session_summary\` 和 \`capability_gaps\` 动作，
了解当前会话状态和潜在问题。
</system-reminder>`,
    tokens: 45,
    shouldInclude: (ctx) => {
      try {
        const { getCodebaseHealthScanner } = require('../../agent/gc/codebaseHealthScanner');
        const scanner = getCodebaseHealthScanner();
        const result = scanner.getLastScanResult();
        if (!result) return 0;
        return result.overallScore < 0.7 ? 0.5 : 0;
      } catch {
        return 0;
      }
    },
    category: 'quality',
  },
];
