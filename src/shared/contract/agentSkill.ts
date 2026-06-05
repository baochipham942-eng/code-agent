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
  aliases?: string | string[];
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string | string[];

  // Claude Code 扩展字段
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
  /** opt-in 严格工具集：激活时模型只看得见 allowed-tools 的工具（隐藏 core Edit/Write 等） */
  'strict-toolset'?: boolean;
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
  aliases?: string[];
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
  /**
   * opt-in 严格工具集（frontmatter: strict-toolset）：true 时该 skill 激活期间模型只看得见
   * allowedTools 里的工具，边界外工具（含 core 的 Edit/Write/Bash）不发给模型。
   * 用于必须强约束工具选择的 meta skill（edit-role/create-role）。默认 false。
   */
  strictToolset?: boolean;
  model?: string;
  executionContext: 'fork' | 'inline';
  agent?: string;
  argumentHint?: string;

  // === 来源追踪 ===
  source: SkillSource;

  /**
   * 全局启用状态（disabledSkills 黑名单语义，默认 true）
   * 仅在 IPC 返回给前端时填充，发现阶段不写入
   */
  enabled?: boolean;

  // === 依赖信息 ===
  bins?: string[];
  envVars?: string[];
  references?: string[];
  referenceContents?: Map<string, string>;
  dependencyStatus?: SkillDependencyStatus;

  /** Whether the full promptContent has been loaded (for lazy loading) */
  loaded?: boolean;

  /** GAP-007: 解析时发现的未知 frontmatter 字段告警（拼写错误检测，供 UI/日志展示） */
  frontmatterWarnings?: string[];
}

export type SkillSource = 'user' | 'project' | 'plugin' | 'builtin' | 'cloud' | 'library';

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
  /**
   * GAP-001: Skill allowed-tools 限权边界。
   * 设置后，边界外的工具调用强制用户审批（不能被 classifier/安全白名单/预授权自动放行）。
   * 与 preApprovedTools 的区别：preApprovedTools 是扩权（边界内免审批，仅 builtin/plugin），
   * toolBoundary 是限权（边界外强制审批，所有来源的 skill 都生效）。
   */
  toolBoundary?: SkillToolBoundary;
}

/**
 * Skill 工具边界（来自 allowed-tools frontmatter）
 */
export interface SkillToolBoundary {
  /** 设定边界的 skill 名（用于审批提示与日志） */
  skillName: string;
  /** 边界内的工具列表（支持 Bash(git:*) 前缀模式） */
  allowedTools: string[];
  /**
   * opt-in 严格工具集：true 时把模型**可见**工具集硬收缩到 allowedTools（边界外工具
   * 直接不发给模型），而非 GAP-001 默认的「可见但调用强制审批」软边界。
   * 用于 meta skill（edit-role/create-role），防止弱模型抓 core 工具（Edit/Write）绕过
   * skill 设计的流程（如 propose_role 确认卡）。仅对显式开启的 skill 生效。
   */
  strict?: boolean;
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
