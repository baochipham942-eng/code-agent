// ============================================================================
// Hook Templates - 内置钩子模板定义
// ============================================================================

import type { HookEvent } from '../events';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 钩子模板类别
 */
export type HookTemplateCategory =
  | 'memory'      // 记忆相关
  | 'workflow'    // 工作流相关
  | 'security'    // 安全相关
  | 'logging'     // 日志相关
  | 'custom';     // 自定义

/**
 * 钩子模板定义
 */
export interface HookTemplate {
  /** 模板 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 触发事件 */
  event: HookEvent;
  /** 是否默认启用 */
  enabled: boolean;
  /** 类别 */
  category: HookTemplateCategory;
  /** 配置选项 */
  options?: HookTemplateOption[];
  /** 依赖服务 */
  dependencies?: string[];
}

/**
 * 模板配置选项
 */
export interface HookTemplateOption {
  /** 选项 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 类型 */
  type: 'boolean' | 'string' | 'number' | 'select';
  /** 默认值 */
  defaultValue: unknown;
  /** 可选值（用于 select 类型）*/
  options?: Array<{ value: string; label: string }>;
}

// ----------------------------------------------------------------------------
// Built-in Templates
// ----------------------------------------------------------------------------

/**
 * 内置钩子模板
 *
 * 这些模板提供开箱即用的功能，用户可以在设置中启用/禁用。
 */
export const BUILT_IN_TEMPLATES: HookTemplate[] = [
  // Memory Hooks
  {
    id: 'session-start-memory-inject',
    name: '会话开始记忆注入',
    description: '会话开始时自动注入相关记忆，帮助 Agent 快速理解上下文',
    event: 'SessionStart',
    enabled: true,
    category: 'memory',
    dependencies: ['MemoryService'],
    options: [
      {
        id: 'maxMemories',
        name: '最大注入数量',
        description: '每次注入的最大记忆条数',
        type: 'number',
        defaultValue: 5,
      },
      {
        id: 'minConfidence',
        name: '最低置信度',
        description: '只注入置信度高于此值的记忆',
        type: 'number',
        defaultValue: 0.7,
      },
    ],
  },
  {
    id: 'session-end-memory-persist',
    name: '会话结束记忆持久化',
    description: '会话结束时自动提取并保存学习成果',
    event: 'SessionEnd',
    enabled: true,
    category: 'memory',
    dependencies: ['MemoryService'],
    options: [
      {
        id: 'extractPatterns',
        name: '提取工作流模式',
        description: '是否提取工具使用序列模式',
        type: 'boolean',
        defaultValue: true,
      },
      {
        id: 'extractErrors',
        name: '提取错误恢复',
        description: '是否提取错误恢复模式',
        type: 'boolean',
        defaultValue: true,
      },
      {
        id: 'extractPreferences',
        name: '提取用户偏好',
        description: '是否提取用户偏好',
        type: 'boolean',
        defaultValue: true,
      },
    ],
  },

  // Context Hooks
  {
    id: 'pre-compact-context-preserve',
    name: '压缩前上下文保留',
    description: '压缩上下文前提取并保留关键信息',
    event: 'PreCompact',
    enabled: true,
    category: 'workflow',
    options: [
      {
        id: 'strategy',
        name: '压缩策略',
        description: '选择压缩保留策略',
        type: 'select',
        defaultValue: 'balanced',
        options: [
          { value: 'aggressive', label: '激进（仅保留最关键信息）' },
          { value: 'balanced', label: '平衡（推荐）' },
          { value: 'conservative', label: '保守（保留更多上下文）' },
        ],
      },
      {
        id: 'preserveDecisions',
        name: '保留决策',
        description: '是否保留关键决策记录',
        type: 'boolean',
        defaultValue: true,
      },
      {
        id: 'preserveCodeChanges',
        name: '保留代码变更',
        description: '是否保留代码变更记录',
        type: 'boolean',
        defaultValue: true,
      },
    ],
  },

  // Security Hooks (示例)
  {
    id: 'dangerous-command-warning',
    name: '危险命令警告',
    description: '执行可能危险的命令前发出警告',
    event: 'PreToolUse',
    enabled: false,
    category: 'security',
    options: [
      {
        id: 'patterns',
        name: '危险模式',
        description: '逗号分隔的危险命令模式',
        type: 'string',
        defaultValue: 'rm -rf,drop table,delete from',
      },
      {
        id: 'action',
        name: '触发动作',
        description: '检测到危险命令时的动作',
        type: 'select',
        defaultValue: 'warn',
        options: [
          { value: 'warn', label: '警告但允许' },
          { value: 'block', label: '阻止执行' },
          { value: 'confirm', label: '需要确认' },
        ],
      },
    ],
  },

  // Logging Hooks
  {
    id: 'tool-execution-log',
    name: '工具执行日志',
    description: '记录所有工具执行的详细日志',
    event: 'PostToolUse',
    enabled: false,
    category: 'logging',
    options: [
      {
        id: 'logLevel',
        name: '日志级别',
        description: '日志详细程度',
        type: 'select',
        defaultValue: 'info',
        options: [
          { value: 'debug', label: '调试（最详细）' },
          { value: 'info', label: '信息' },
          { value: 'warn', label: '警告' },
        ],
      },
      {
        id: 'includeOutput',
        name: '包含输出',
        description: '是否在日志中包含工具输出',
        type: 'boolean',
        defaultValue: false,
      },
    ],
  },

  // Workflow Hooks
  {
    id: 'auto-commit-reminder',
    name: '自动提交提醒',
    description: '完成代码修改后提醒用户提交',
    event: 'Stop',
    enabled: false,
    category: 'workflow',
    options: [
      {
        id: 'minChanges',
        name: '最小变更数',
        description: '触发提醒的最小文件变更数',
        type: 'number',
        defaultValue: 3,
      },
    ],
  },

  // Context Injection Hooks
  {
    id: 'session-start-agents-inject',
    name: 'AGENTS.md 指令注入',
    description: '会话开始时自动发现并注入项目目录中的 AGENTS.md 指令',
    event: 'SessionStart',
    enabled: true,
    category: 'workflow',
    options: [
      {
        id: 'maxDepth',
        name: '最大搜索深度',
        description: '向下搜索 AGENTS.md 的最大目录深度',
        type: 'number',
        defaultValue: 3,
      },
      {
        id: 'includeParents',
        name: '包含父目录',
        description: '是否包含工作目录的父目录中的 AGENTS.md',
        type: 'boolean',
        defaultValue: true,
      },
    ],
  },

  // Evolution Hooks (Gen8)
  {
    id: 'session-end-meta-learning',
    name: '会话结束元学习',
    description: '会话结束时自动分析工具使用模式，提取可复用模式',
    event: 'SessionEnd',
    enabled: true,
    category: 'memory',
    dependencies: ['EvolutionPersistence'],
    options: [
      {
        id: 'extractPatterns',
        name: '提取工具模式',
        description: '是否提取工具使用序列模式',
        type: 'boolean',
        defaultValue: true,
      },
      {
        id: 'detectGaps',
        name: '检测能力缺口',
        description: '是否检测并记录能力缺口',
        type: 'boolean',
        defaultValue: true,
      },
      {
        id: 'updateStrategies',
        name: '更新策略',
        description: '是否根据会话结果更新策略',
        type: 'boolean',
        defaultValue: true,
      },
    ],
  },
  {
    id: 'tool-failure-learning',
    name: '工具失败学习',
    description: '工具执行失败时分析错误模式，避免重复错误',
    event: 'PostToolUseFailure',
    enabled: true,
    category: 'memory',
    dependencies: ['EvolutionPersistence'],
    options: [
      {
        id: 'minOccurrences',
        name: '最小出现次数',
        description: '触发模式提取的最小失败次数',
        type: 'number',
        defaultValue: 2,
      },
    ],
  },
];

// ----------------------------------------------------------------------------
// Template Utilities
// ----------------------------------------------------------------------------

/**
 * 获取所有模板
 */
export function getAllTemplates(): HookTemplate[] {
  return [...BUILT_IN_TEMPLATES];
}

/**
 * 按类别获取模板
 */
export function getTemplatesByCategory(category: HookTemplateCategory): HookTemplate[] {
  return BUILT_IN_TEMPLATES.filter(t => t.category === category);
}

/**
 * 按事件获取模板
 */
export function getTemplatesByEvent(event: HookEvent): HookTemplate[] {
  return BUILT_IN_TEMPLATES.filter(t => t.event === event);
}

/**
 * 获取默认启用的模板
 */
export function getEnabledTemplates(): HookTemplate[] {
  return BUILT_IN_TEMPLATES.filter(t => t.enabled);
}

/**
 * 根据 ID 获取模板
 */
export function getTemplateById(id: string): HookTemplate | undefined {
  return BUILT_IN_TEMPLATES.find(t => t.id === id);
}

/**
 * 获取模板的默认配置
 */
export function getTemplateDefaultConfig(id: string): Record<string, unknown> {
  const template = getTemplateById(id);
  if (!template || !template.options) {
    return {};
  }

  const config: Record<string, unknown> = {};
  for (const option of template.options) {
    config[option.id] = option.defaultValue;
  }
  return config;
}
