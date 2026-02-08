// ============================================================================
// System Reminders - 动态系统提醒（借鉴 Claude Code）
// ============================================================================
// Claude Code 有 40 个动态系统提醒，按需注入
// 这避免了所有规则同时竞争模型注意力
// ============================================================================

/**
 * 系统提醒类型
 */
export type ReminderType =
  | 'PARALLEL_DISPATCH'
  | 'MUST_DELEGATE'
  | 'PLAN_MODE_ACTIVE'
  | 'AUDIT_MODE'
  | 'REVIEW_MODE'
  | 'PPT_FORMAT_SELECTION';

/**
 * 系统提醒内容
 */
export const REMINDERS: Record<ReminderType, string> = {
  /**
   * 多维度任务 - 并行派发提醒
   */
  PARALLEL_DISPATCH: `
<system-reminder>
**并行派发提醒**：检测到多维度任务。

你应该在**单个响应中同时派发多个 task**，而不是逐个执行：

\`\`\`
task(subagent_type="code-review", prompt="维度1: ...")
task(subagent_type="explore", prompt="维度2: ...")
task(subagent_type="code-review", prompt="维度3: ...")
\`\`\`

各维度之间无依赖关系时，并行派发能显著提高效率。
</system-reminder>
`,

  /**
   * 复杂任务 - 必须委派提醒
   */
  MUST_DELEGATE: `
<system-reminder>
**委派提醒**：这是一个需要广泛探索的复杂任务。

请使用 task 工具委派给子代理，子代理有专门的工具和上下文窗口，比直接执行更高效。

不要直接使用 glob/grep/read_file，而应该：
- 安全审计 → task(subagent_type="code-review", prompt="...")
- 代码探索 → task(subagent_type="explore", prompt="...")
- 架构分析 → task(subagent_type="plan", prompt="...")
</system-reminder>
`,

  /**
   * 规划模式激活提醒
   */
  PLAN_MODE_ACTIVE: `
<system-reminder>
**Plan Mode 已激活**：你现在处于只读规划模式。

5-Phase 流程：
1. Phase 1: 并行派发 explore 子代理探索代码库
2. Phase 2: 派发 plan 子代理设计方案
3. Phase 3: 整合结果，使用 ask_user_question 澄清
4. Phase 4: 生成最终计划
5. Phase 5: 调用 exit_plan_mode（必须用工具调用）

**禁止**：在 Plan Mode 中进行任何文件写入操作。
</system-reminder>
`,

  /**
   * 审计模式提醒
   */
  AUDIT_MODE: `
<system-reminder>
**审计模式**：检测到安全/代码审计任务。

推荐流程：
1. 并行派发多个 code-review 子代理，每个负责一个维度
2. 收集所有子代理的审计结果
3. 整合生成完整审计报告

审计维度示例：认证授权、输入验证、数据安全、依赖安全、配置安全
</system-reminder>
`,

  /**
   * 代码审查模式提醒
   */
  REVIEW_MODE: `
<system-reminder>
**审查模式**：检测到代码审查任务。

推荐流程：
1. 先用 bash 获取变更文件列表（git diff --name-only）
2. 并行派发 code-review 子代理分析不同方面
3. 整合生成审查报告

审查维度示例：代码质量、潜在问题、性能考量、安全性、可维护性
</system-reminder>
`,

  /**
   * PPT 生成工作流（简化版，不强制询问）
   */
  PPT_FORMAT_SELECTION: `
<system-reminder>
**PPT 生成任务**：检测到演示文稿生成需求。

**输出格式**：PPTX 文件（可用 PowerPoint/WPS/Keynote 打开编辑）

**工作流程**：
1. 如有本地文档素材 → 使用 read_pdf/read_file 读取
2. 如需图表 → 使用 mermaid_export 生成 PNG 图片
3. 如需配图 → 使用 image_generate 生成
4. 最后调用 ppt_generate 生成 PPTX，通过 images 参数嵌入图片

**ppt_generate 调用示例**：
\`\`\`
ppt_generate({
  topic: "标题",
  content: "# 封面\\n## 副标题\\n# 第一章\\n- 要点1\\n- 要点2",
  theme: "dracula",  // 或 tech/professional/corporate
  images: [{ slide_index: 1, image_path: "/path/chart.png", position: "center" }]
})
\`\`\`

**主题选择**：
- 技术分享 → dracula（暗色科技风）
- 产品介绍 → professional（商务蓝白）
- 企业汇报 → corporate（企业正式）
- 其他 → tech（深蓝科技风）

**禁止**：
- ❌ 不要用 write_file 生成 slides.md（用户要的是 PPTX）
- ❌ 不要把 Mermaid 代码直接放到 content 里（必须先用 mermaid_export 转 PNG）
</system-reminder>
`,
};

/**
 * 任务特征检测结果
 */
export interface TaskFeatures {
  isMultiDimension: boolean;
  isComplexTask: boolean;
  isAuditTask: boolean;
  isReviewTask: boolean;
  isPlanningTask: boolean;
  isPPTTask: boolean;
  dimensions: string[];
}

/**
 * 检测任务特征
 */
export function detectTaskFeatures(prompt: string): TaskFeatures {
  const normalizedPrompt = prompt.toLowerCase();

  // 维度关键词
  const dimensionKeywords = [
    '安全', '性能', '质量', '审计', '分析',
    '认证', '授权', '输入验证', '数据安全', '依赖',
    '前端', '后端', '数据库', 'api', '配置',
  ];

  // 检测匹配的维度
  const matchedDimensions = dimensionKeywords.filter((d) =>
    normalizedPrompt.includes(d)
  );

  // 复杂任务关键词
  const complexKeywords = [
    '全面', '完整', '整个项目', '所有', '彻底',
    '详细分析', '深入', '系统性',
  ];

  // 审计任务关键词
  const auditKeywords = ['审计', '安全检查', '漏洞扫描', '安全分析'];

  // 审查任务关键词
  const reviewKeywords = ['审查', 'review', '代码检查', 'code review'];

  // 规划任务关键词
  const planningKeywords = ['设计', '实现', '规划', '方案', '架构'];

  // PPT 任务关键词
  const pptKeywords = [
    'ppt', 'powerpoint', 'slidev', '演示文稿', '幻灯片',
    '演示', 'presentation', 'slide', '做个ppt', '生成ppt',
    '制作ppt', '写个ppt', 'slides',
  ];

  return {
    isMultiDimension: matchedDimensions.length >= 2,
    isComplexTask: complexKeywords.some((k) => normalizedPrompt.includes(k)),
    isAuditTask: auditKeywords.some((k) => normalizedPrompt.includes(k)),
    isReviewTask: reviewKeywords.some((k) => normalizedPrompt.includes(k)),
    isPlanningTask: planningKeywords.some((k) => normalizedPrompt.includes(k)),
    isPPTTask: pptKeywords.some((k) => normalizedPrompt.includes(k)),
    dimensions: matchedDimensions,
  };
}

/**
 * 根据任务特征获取需要注入的系统提醒
 */
export function getSystemReminders(prompt: string): string[] {
  const features = detectTaskFeatures(prompt);
  const reminders: string[] = [];

  // PPT 任务 → 格式选择提醒（优先级最高，放在最前面）
  if (features.isPPTTask) {
    reminders.push(REMINDERS.PPT_FORMAT_SELECTION);
  }

  // 多维度任务 → 并行派发提醒
  if (features.isMultiDimension) {
    reminders.push(REMINDERS.PARALLEL_DISPATCH);
  }

  // 复杂任务 → 必须委派提醒
  if (features.isComplexTask && !features.isMultiDimension) {
    reminders.push(REMINDERS.MUST_DELEGATE);
  }

  // 审计任务 → 审计模式提醒
  if (features.isAuditTask) {
    reminders.push(REMINDERS.AUDIT_MODE);
  }

  // 审查任务 → 审查模式提醒
  if (features.isReviewTask && !features.isAuditTask) {
    reminders.push(REMINDERS.REVIEW_MODE);
  }

  return reminders;
}

/**
 * 将系统提醒附加到用户消息
 */
export function appendRemindersToMessage(
  userMessage: string,
  reminders: string[]
): string {
  if (reminders.length === 0) {
    return userMessage;
  }

  return userMessage + '\n\n' + reminders.join('\n');
}
