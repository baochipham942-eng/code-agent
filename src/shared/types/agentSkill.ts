// ============================================================================
// Agent Skills Standard Types
// Based on https://agentskills.io/specification
// ============================================================================

/**
 * Agent Skills 标准的 YAML frontmatter 结构
 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;

  // Claude Code 扩展字段
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
  model?: string;
  context?: 'fork' | 'inline';
  agent?: string;
  'argument-hint'?: string;
}

/**
 * 解析后的 Skill 结构
 */
export interface ParsedSkill {
  // === Agent Skills 标准字段 ===
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;

  // === 内容 ===
  promptContent: string;
  basePath: string;

  // === 执行控制 (Claude Code 扩展) ===
  allowedTools: string[];
  disableModelInvocation: boolean;
  userInvocable: boolean;
  model?: string;
  executionContext: 'fork' | 'inline';
  agent?: string;
  argumentHint?: string;

  // === 来源追踪 ===
  source: SkillSource;
}

export type SkillSource = 'user' | 'project' | 'plugin' | 'builtin';

/**
 * Skill 注入消息类型
 */
export interface SkillMessage {
  role: 'user';
  content: string;
  isMeta?: boolean;
  autocheckpoint?: boolean;
}

/**
 * Skill 工具返回结果
 */
export interface SkillToolResult {
  success: boolean;
  error?: string;
  data?: { commandName: string };
  newMessages?: SkillMessage[];
  contextModifier?: SkillContextModifier;
}

/**
 * Skill 上下文修改器
 */
export interface SkillContextModifier {
  preApprovedTools?: string[];
  modelOverride?: string;
}

/**
 * Skill 执行上下文
 */
export interface SkillExecutionContext {
  preApprovedTools: string[];
  modelOverride?: string;
}

/**
 * Skill 解析错误
 */
export class SkillParseError extends Error {
  constructor(
    message: string,
    public readonly skillPath: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'SkillParseError';
  }
}

/**
 * Skill 验证错误
 */
export class SkillValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    public readonly value: unknown
  ) {
    super(message);
    this.name = 'SkillValidationError';
  }
}
