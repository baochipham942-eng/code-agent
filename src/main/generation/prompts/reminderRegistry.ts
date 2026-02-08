// ============================================================================
// Reminder Registry - 提醒定义与优先级管理
// ============================================================================
// 借鉴 Claude Code 的 40 个动态系统提醒设计
// 按优先级分层，支持上下文感知的动态选择
// ============================================================================

import type { TaskFeatures } from './systemReminders';

/**
 * 提醒优先级
 * 1 = 关键（必须包含）
 * 2 = 重要（空间允许时包含）
 * 3 = 辅助（可选，用于增强）
 */
export type ReminderPriority = 1 | 2 | 3;

/**
 * 提醒上下文
 */
export interface ReminderContext {
  taskFeatures: TaskFeatures;
  toolsUsedInTurn: string[];
  iterationCount: number;
  tokenBudget: number;
  currentMode: string;
  hasError: boolean;
  lastToolResult?: string;
}

/**
 * 提醒定义
 */
export interface ReminderDefinition {
  id: string;
  priority: ReminderPriority;
  content: string;
  tokens: number;
  shouldInclude: (context: ReminderContext) => number; // 返回 0-1 的匹配分数
  exclusiveGroup?: string; // 用于去重，同组只选一个
  category: 'mode' | 'tool' | 'safety' | 'efficiency' | 'quality';
}

/**
 * 估算文本的 token 数量
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ----------------------------------------------------------------------------
// 核心提醒定义
// ----------------------------------------------------------------------------

export const REMINDER_DEFINITIONS: ReminderDefinition[] = [
  // ----------------------------------------------------------------------------
  // 模式相关提醒（Priority 1）
  // ----------------------------------------------------------------------------
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

  // ----------------------------------------------------------------------------
  // 效率相关提醒（Priority 1-2）
  // ----------------------------------------------------------------------------
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

  // ----------------------------------------------------------------------------
  // 工具使用提醒（Priority 2）
  // ----------------------------------------------------------------------------
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

  // ----------------------------------------------------------------------------
  // 安全相关提醒（Priority 1）
  // ----------------------------------------------------------------------------
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

  // ----------------------------------------------------------------------------
  // 质量相关提醒（Priority 2-3）
  // ----------------------------------------------------------------------------
  {
    id: 'VERIFY_BEFORE_COMMIT',
    priority: 2,
    content: `<system-reminder>
**验证优先**：修改代码后，先验证功能正常再通知用户。
流程：修改 → 验证 → 确认通过 → 通知
</system-reminder>`,
    tokens: 40,
    shouldInclude: (ctx) =>
      ctx.toolsUsedInTurn.includes('edit_file') ? 0.5 : 0,
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
      ctx.toolsUsedInTurn.includes('edit_file') && ctx.iterationCount > 5 ? 0.4 : 0,
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

  // ----------------------------------------------------------------------------
  // 上下文感知提醒（Priority 2-3）
  // ----------------------------------------------------------------------------
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

  // ----------------------------------------------------------------------------
  // 任务类型选择提醒（Priority 1）
  // ----------------------------------------------------------------------------
  {
    id: 'PPT_FORMAT_SELECTION',
    priority: 1,
    content: `<system-reminder>
**PPT 生成必须遵循的流程**：

**第一步：收集信息（必须）**
- 如果是介绍本地项目/产品 → 先用 read_file 读取 package.json、README.md、CLAUDE.md
- 如果是通用主题 → 先用 web_search 搜索最新数据

**第二步：内容规范**
- 每页 4-5 个要点，每个要点 20-40 字
- 内容要具体：包含真实数据、功能名称、技术细节
- 禁止编造虚假数据

**第三步：图表控制**
- 包含数字/百分比的数据内容会自动生成原生可编辑图表（chart_mode: auto）
- 复杂流程图可用 mermaid_export 生成透明 PNG，传入 images 参数
- 10 页 PPT 最多 1-2 张流程图，大部分页面用文字列表即可
</system-reminder>`,
    tokens: 250,
    shouldInclude: (ctx) => ctx.taskFeatures.isPPTTask ? 1.0 : 0,
    exclusiveGroup: 'task-type-selection',
    category: 'tool',
  },
];

/**
 * 按优先级获取提醒
 */
export function getRemindersByPriority(priority: ReminderPriority): ReminderDefinition[] {
  return REMINDER_DEFINITIONS.filter((r) => r.priority === priority);
}

/**
 * 按类别获取提醒
 */
export function getRemindersByCategory(
  category: ReminderDefinition['category']
): ReminderDefinition[] {
  return REMINDER_DEFINITIONS.filter((r) => r.category === category);
}

/**
 * 根据 ID 获取提醒
 */
export function getReminderById(id: string): ReminderDefinition | undefined {
  return REMINDER_DEFINITIONS.find((r) => r.id === id);
}

/**
 * 获取所有提醒的总 token 数
 */
export function getTotalReminderTokens(): number {
  return REMINDER_DEFINITIONS.reduce((sum, r) => sum + r.tokens, 0);
}
