// ============================================================================
// Agent Modes - 代理模式系统
// ============================================================================
// 借鉴 Claude Code：模式只控制工具权限，不强制执行流程
// 让指挥家（主 Agent）自己决定如何处理任务
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
  /** 系统提醒（保持简洁，不强制流程） */
  systemReminder: string;
  /** 只读模式：禁止写入工具 */
  readOnly: boolean;
}

/**
 * 各模式的配置
 *
 * 设计原则：
 * - 不硬编码执行流程，让 Agent 自主决策
 * - 只通过工具权限控制行为边界
 * - systemReminder 保持简洁，只说明模式目的
 */
export const MODE_CONFIGS: Record<AgentMode, ModeConfig> = {
  normal: {
    name: '普通模式',
    description: '默认工作模式，可读可写',
    systemReminder: '',
    readOnly: false,
  },

  plan: {
    name: '规划模式',
    description: '只读模式，用于分析和规划',
    systemReminder: '规划模式：当前为只读，完成规划后请求用户批准再执行。',
    readOnly: true,
  },

  review: {
    name: '审查模式',
    description: '只读模式，用于代码审查',
    systemReminder: '审查模式：专注于代码质量、潜在问题、安全性分析。',
    readOnly: true,
  },

  audit: {
    name: '审计模式',
    description: '只读模式，用于安全审计',
    systemReminder: '审计模式：专注于安全漏洞、敏感数据、配置风险分析。',
    readOnly: true,
  },
};

/**
 * 根据任务特征自动选择模式
 *
 * 注意：只在明确需要只读模式时才切换，避免过度触发
 */
export function selectMode(taskPrompt: string): AgentMode {
  const features = detectTaskFeatures(taskPrompt);

  // 审计任务 → 审计模式（只读）
  if (features.isAuditTask) {
    return 'audit';
  }

  // 审查任务 → 审查模式（只读）
  if (features.isReviewTask) {
    return 'review';
  }

  // 默认：普通模式，让 Agent 自己决定如何处理
  // 不再自动触发 plan 模式，避免过度规划
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
 * 检查模式是否为只读
 */
export function isReadOnlyMode(mode: AgentMode): boolean {
  return MODE_CONFIGS[mode].readOnly;
}
