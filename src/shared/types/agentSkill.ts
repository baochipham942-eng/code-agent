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

  // 依赖检查字段
  bins?: string[];           // 需要的命令行工具
  'env-vars'?: string[];     // 需要的环境变量
  references?: string[];     // 引用的参考文件（相对路径）
}

/**
 * 依赖检查结果
 */
export interface SkillDependencyStatus {
  /** 是否所有依赖都满足 */
  satisfied: boolean;
  /** 缺失的命令行工具 */
  missingBins: string[];
  /** 缺失的环境变量 */
  missingEnvVars: string[];
  /** 缺失的引用文件 */
  missingReferences: string[];
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

  // === 依赖信息 ===
  bins?: string[];
  envVars?: string[];
  references?: string[];
  referenceContents?: Map<string, string>;
  dependencyStatus?: SkillDependencyStatus;

  /** Whether the full promptContent has been loaded (for lazy loading) */
  loaded?: boolean;
}

export type SkillSource = 'user' | 'project' | 'plugin' | 'builtin' | 'library';

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
