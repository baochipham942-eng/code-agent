// ============================================================================
// 模式相关提醒 - Plan / Audit / Review
// ============================================================================

import type { ReminderDefinition } from './types';

/**
 * 模式相关提醒（Priority 1）
 */
export const MODE_REMINDERS: ReminderDefinition[] = [
  {
    id: 'PLAN_MODE_ACTIVE',
    priority: 1,
    content: `<system-reminder>
**Plan Mode 已激活**：你现在处于只读规划模式。

流程：
1. 使用 explore 子代理探索代码库
2. 派发 plan 子代理设计方案
3. 整合结果，使用 ask_user_question 澄清
4. 生成最终计划
5. 调用 exit_plan_mode

**禁止**：在 Plan Mode 中进行任何文件写入操作。
</system-reminder>`,
    tokens: 120,
    shouldInclude: (ctx) => ctx.currentMode === 'plan' ? 1 : 0,
    exclusiveGroup: 'mode',
    category: 'mode',
  },
  {
    id: 'AUDIT_MODE',
    priority: 1,
    content: `<system-reminder>
**审计模式**：检测到安全/代码审计任务。

推荐流程：
1. 并行派发多个 code-review 子代理
2. 收集所有子代理的审计结果
3. 整合生成完整审计报告

维度：认证授权、输入验证、数据安全、依赖安全、配置安全
</system-reminder>`,
    tokens: 100,
    shouldInclude: (ctx) => ctx.taskFeatures.isAuditTask ? 1 : 0,
    exclusiveGroup: 'mode',
    category: 'mode',
  },
  {
    id: 'REVIEW_MODE',
    priority: 1,
    content: `<system-reminder>
**审查模式**：检测到代码审查任务。

推荐流程：
1. 获取变更文件列表（git diff --name-only）
2. 并行派发 code-review 子代理分析
3. 整合生成审查报告
</system-reminder>`,
    tokens: 80,
    shouldInclude: (ctx) =>
      ctx.taskFeatures.isReviewTask && !ctx.taskFeatures.isAuditTask ? 1 : 0,
    exclusiveGroup: 'mode',
    category: 'mode',
  },
];
