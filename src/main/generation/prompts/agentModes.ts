// ============================================================================
// Agent Modes - 代理模式系统（借鉴 Claude Code）
// ============================================================================
// Claude Code 有多种模式：Plan Mode, Learning Mode, Delegate Mode 等
// 每种模式有专门的提示和行为规范
// ============================================================================

import { detectTaskFeatures, type TaskFeatures } from './systemReminders';

/**
 * 代理模式类型
 */
export type AgentMode = 'normal' | 'plan' | 'review' | 'audit';

/**
 * 模式配置
 */
export interface ModeConfig {
  name: string;
  description: string;
  systemReminder: string;
  suggestedAgents: string[];
  parallelByDefault: boolean;
}

/**
 * 各模式的配置
 */
export const MODE_CONFIGS: Record<AgentMode, ModeConfig> = {
  /**
   * 普通模式 - 默认模式
   */
  normal: {
    name: '普通模式',
    description: '默认工作模式，根据任务自主决策',
    systemReminder: '',
    suggestedAgents: [],
    parallelByDefault: false,
  },

  /**
   * 规划模式 - 复杂任务的规划设计
   */
  plan: {
    name: '规划模式',
    description: '用于复杂任务的规划和设计',
    systemReminder: `
<system-reminder>
**规划模式已激活**

你现在处于规划模式，请遵循 5-Phase 流程：

**Phase 1: 并行探索**
同时派发多个 explore 子代理探索代码库的不同方面：
\`\`\`
task(subagent_type="explore", prompt="探索前端架构...")
task(subagent_type="explore", prompt="探索后端架构...")
task(subagent_type="explore", prompt="探索数据模型...")
\`\`\`

**Phase 2: 设计方案**
基于探索结果，派发 plan 子代理设计实现方案。

**Phase 3: 审查整合**
整合所有信息，如有不确定点使用 ask_user_question 澄清。

**Phase 4: 输出计划**
生成清晰的实现计划文档。

**Phase 5: 请求批准**
使用 exit_plan_mode 工具（不是文字）请求用户批准。

**重要**：规划模式是只读模式，禁止文件写入操作。
</system-reminder>
`,
    suggestedAgents: ['explore', 'plan'],
    parallelByDefault: true,
  },

  /**
   * 审查模式 - 代码审查
   */
  review: {
    name: '审查模式',
    description: '用于代码审查和质量检查',
    systemReminder: `
<system-reminder>
**审查模式已激活**

请按以下流程进行代码审查：

1. **获取变更范围**
   使用 bash 执行 git diff --name-only 获取变更文件列表

2. **并行审查**
   同时派发多个 code-review 子代理，每个负责一个审查维度：
   \`\`\`
   task(subagent_type="code-review", prompt="代码质量审查：命名、结构、重复...")
   task(subagent_type="code-review", prompt="潜在问题审查：边界条件、错误处理...")
   task(subagent_type="code-review", prompt="安全性审查：输入验证、敏感数据...")
   \`\`\`

3. **整合报告**
   收集所有子代理结果，生成统一的审查报告。

**审查维度**：代码质量、潜在问题、性能考量、安全性、可维护性
</system-reminder>
`,
    suggestedAgents: ['code-review', 'explore'],
    parallelByDefault: true,
  },

  /**
   * 审计模式 - 安全审计
   */
  audit: {
    name: '审计模式',
    description: '用于安全审计和漏洞扫描',
    systemReminder: `
<system-reminder>
**审计模式已激活**

请按以下流程进行安全审计：

1. **并行审计**
   同时派发多个 code-review 子代理，每个负责一个安全维度：
   \`\`\`
   task(subagent_type="code-review", prompt="认证授权审计：检查身份验证、权限控制...")
   task(subagent_type="code-review", prompt="输入验证审计：检查 SQL 注入、XSS...")
   task(subagent_type="code-review", prompt="数据安全审计：检查加密、敏感数据处理...")
   task(subagent_type="explore", prompt="依赖安全检查：分析 package.json...")
   task(subagent_type="code-review", prompt="配置安全审计：检查硬编码密钥、环境变量...")
   \`\`\`

2. **整合报告**
   收集所有子代理结果，按严重程度分类：
   - Critical: 必须立即修复
   - High: 应尽快修复
   - Medium: 建议修复
   - Low: 可选修复

3. **输出格式**
   生成详细的安全审计报告，包含问题描述、代码位置、修复建议。

**审计维度**：认证授权、输入验证、数据安全、依赖安全、配置安全
</system-reminder>
`,
    suggestedAgents: ['code-review', 'explore'],
    parallelByDefault: true,
  },
};

/**
 * 根据任务特征自动选择模式
 */
export function selectMode(taskPrompt: string): AgentMode {
  const features = detectTaskFeatures(taskPrompt);
  const normalizedPrompt = taskPrompt.toLowerCase();

  // 审计任务 → 审计模式
  if (features.isAuditTask) {
    return 'audit';
  }

  // 审查任务 → 审查模式
  if (features.isReviewTask) {
    return 'review';
  }

  // 规划/设计任务 → 规划模式
  if (features.isPlanningTask && features.isComplexTask) {
    return 'plan';
  }

  // 复杂多维度任务 → 规划模式
  if (features.isMultiDimension && features.isComplexTask) {
    return 'plan';
  }

  return 'normal';
}

/**
 * 获取模式的系统提醒
 */
export function getModeReminder(mode: AgentMode): string {
  return MODE_CONFIGS[mode].systemReminder;
}

/**
 * 获取模式配置
 */
export function getModeConfig(mode: AgentMode): ModeConfig {
  return MODE_CONFIGS[mode];
}

/**
 * 检查模式是否默认使用并行
 */
export function isParallelByDefault(mode: AgentMode): boolean {
  return MODE_CONFIGS[mode].parallelByDefault;
}

/**
 * 获取模式建议的子代理类型
 */
export function getSuggestedAgents(mode: AgentMode): string[] {
  return MODE_CONFIGS[mode].suggestedAgents;
}
