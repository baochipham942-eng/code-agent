// ============================================================================
// Core Memory - 用户偏好持久化（结构化版本）
// ============================================================================
// 存储跨会话的用户偏好，支持自动学习和手动设置。
// 基于 Smart Forking Phase 2 的 Prompt 5 设计。
// ============================================================================

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import type { Message } from '../../shared/types';

const logger = createLogger('CoreMemory');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 用户画像
 */
export interface HumanProfile {
  /** 用户名称 */
  name?: string;
  /** 角色，如"前端开发者"、"全栈工程师" */
  role?: string;
  /** 经验等级 */
  experienceLevel?: 'junior' | 'mid' | 'senior';
  /** 主要编程语言 */
  primaryLanguages: string[];
  /** 偏好框架 */
  preferredFrameworks: string[];
}

/**
 * 编码风格偏好
 */
export interface CodingStyle {
  /** 缩进方式 */
  indentation?: 'tabs' | '2spaces' | '4spaces';
  /** 引号风格 */
  quotes?: 'single' | 'double';
  /** 是否使用分号 */
  semicolons?: boolean;
  /** 尾逗号风格 */
  trailingComma?: 'none' | 'es5' | 'all';
  /** 命名规范 */
  namingConvention?: 'camelCase' | 'snake_case' | 'PascalCase';
}

/**
 * 工作流偏好
 */
export interface WorkflowPreferences {
  /** 偏好的测试框架 */
  preferredTestFramework?: string;
  /** commit 消息风格 */
  commitMessageStyle?: 'conventional' | 'simple';
  /** 是否偏好详细解释 */
  preferDetailedExplanations?: boolean;
  /** 代码注释语言 */
  preferCodeCommentsLanguage?: 'zh' | 'en';
  /** 是否偏好 CLI 工具 */
  prefersCLI?: boolean;
}

/**
 * Agent 人设（可选）
 */
export interface AgentPersona {
  /** 人设名称 */
  name?: string;
  /** 回复风格 */
  style?: 'concise' | 'detailed' | 'friendly';
  /** 专长领域 */
  expertise?: string[];
}

/**
 * 完整的 Core Memory 结构
 */
export interface CoreMemory {
  /** 用户画像 */
  human: HumanProfile;
  /** 编码风格 */
  codingStyle: CodingStyle;
  /** 工作流偏好 */
  workflow: WorkflowPreferences;
  /** Agent 人设 */
  persona?: AgentPersona;
  /** 自定义偏好（KV 扩展） */
  custom: Record<string, unknown>;
  /** 最后更新时间 */
  updatedAt: number;
  /** 版本号 */
  version: number;
}

/**
 * 学习到的偏好（部分）
 */
export type LearnedPreferences = Partial<Omit<CoreMemory, 'updatedAt' | 'version'>>;

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const CURRENT_VERSION = 1;
const CORE_MEMORY_FILENAME = 'core-memory.json';

const DEFAULT_CORE_MEMORY: CoreMemory = {
  human: {
    primaryLanguages: [],
    preferredFrameworks: [],
  },
  codingStyle: {},
  workflow: {},
  custom: {},
  updatedAt: Date.now(),
  version: CURRENT_VERSION,
};

// 编码风格检测模式
const STYLE_PATTERNS = {
  // 缩进检测
  tabs: /^\t/m,
  twoSpaces: /^  [^\s]/m,
  fourSpaces: /^    [^\s]/m,
  // 尾逗号检测
  trailingComma: /,\s*[\}\]]\s*$/m,
};

// 显式偏好关键词
const PREFERENCE_KEYWORDS = {
  languages: [
    { pattern: /我.*(?:喜欢|偏好|常用|主要用)\s*(TypeScript|JavaScript|Python|Go|Rust|Java)/gi, group: 1 },
    { pattern: /(?:prefer|use|like)\s*(TypeScript|JavaScript|Python|Go|Rust|Java)/gi, group: 1 },
  ],
  frameworks: [
    { pattern: /我.*(?:喜欢|偏好|常用)\s*(React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|Nest\.js|FastAPI|Django)/gi, group: 1 },
    { pattern: /(?:prefer|use|like)\s*(React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|Nest\.js|FastAPI|Django)/gi, group: 1 },
  ],
  commentLanguage: [
    { pattern: /请?用中文.*注释|中文注释/i, value: 'zh' as const },
    { pattern: /(?:use |write |prefer )?english comments/i, value: 'en' as const },
  ],
  detailed: [
    { pattern: /详细.*解释|多解释一些/i, value: true },
    { pattern: /简洁.*回复|不要.*解释/i, value: false },
  ],
};

// ----------------------------------------------------------------------------
// Core Memory Service
// ----------------------------------------------------------------------------

export class CoreMemoryService {
  private memory: CoreMemory;
  private filePath: string;
  private isDirty = false;

  constructor(customPath?: string) {
    this.filePath = customPath || this.getDefaultPath();
    this.memory = this.load();
  }

  /**
   * 获取默认存储路径
   */
  private getDefaultPath(): string {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, CORE_MEMORY_FILENAME);
  }

  /**
   * 加载 Core Memory
   */
  private load(): CoreMemory {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(data) as CoreMemory;

        // 版本迁移（如果需要）
        if (parsed.version < CURRENT_VERSION) {
          return this.migrate(parsed);
        }

        logger.info('Core memory loaded', { path: this.filePath });
        return { ...DEFAULT_CORE_MEMORY, ...parsed };
      }
    } catch (error) {
      logger.warn('Failed to load core memory, using defaults', { error });
    }

    return { ...DEFAULT_CORE_MEMORY };
  }

  /**
   * 版本迁移
   */
  private migrate(old: CoreMemory): CoreMemory {
    logger.info('Migrating core memory', { from: old.version, to: CURRENT_VERSION });
    // 目前只有 v1，无需迁移
    return { ...DEFAULT_CORE_MEMORY, ...old, version: CURRENT_VERSION };
  }

  /**
   * 保存 Core Memory
   */
  save(): void {
    try {
      this.memory.updatedAt = Date.now();
      fs.writeFileSync(this.filePath, JSON.stringify(this.memory, null, 2), 'utf-8');
      this.isDirty = false;
      logger.info('Core memory saved', { path: this.filePath });
    } catch (error) {
      logger.error('Failed to save core memory', { error });
    }
  }

  /**
   * 获取完整 Core Memory
   */
  getAll(): CoreMemory {
    return { ...this.memory };
  }

  /**
   * 获取用户画像
   */
  getHumanProfile(): HumanProfile {
    return { ...this.memory.human };
  }

  /**
   * 更新用户画像
   */
  setHumanProfile(profile: Partial<HumanProfile>): void {
    this.memory.human = { ...this.memory.human, ...profile };
    this.isDirty = true;
    this.save();
  }

  /**
   * 获取编码风格
   */
  getCodingStyle(): CodingStyle {
    return { ...this.memory.codingStyle };
  }

  /**
   * 更新编码风格
   */
  setCodingStyle(style: Partial<CodingStyle>): void {
    this.memory.codingStyle = { ...this.memory.codingStyle, ...style };
    this.isDirty = true;
    this.save();
  }

  /**
   * 获取工作流偏好
   */
  getWorkflow(): WorkflowPreferences {
    return { ...this.memory.workflow };
  }

  /**
   * 更新工作流偏好
   */
  setWorkflow(workflow: Partial<WorkflowPreferences>): void {
    this.memory.workflow = { ...this.memory.workflow, ...workflow };
    this.isDirty = true;
    this.save();
  }

  /**
   * 获取自定义偏好
   */
  getCustom<T>(key: string): T | undefined {
    return this.memory.custom[key] as T | undefined;
  }

  /**
   * 设置自定义偏好
   */
  setCustom(key: string, value: unknown): void {
    this.memory.custom[key] = value;
    this.isDirty = true;
    this.save();
  }

  /**
   * 从会话中学习偏好
   */
  learnFromSession(messages: Message[]): LearnedPreferences {
    const learned: LearnedPreferences = {};

    // 1. 从代码片段学习编码风格
    const codeBlocks = this.extractCodeBlocks(messages);
    if (codeBlocks.length > 0) {
      const inferredStyle = this.inferCodingStyle(codeBlocks);
      if (Object.keys(inferredStyle).length > 0) {
        learned.codingStyle = inferredStyle;
      }
    }

    // 2. 从用户陈述中提取显式偏好
    const userMessages = messages.filter((m) => m.role === 'user');
    const explicitPrefs = this.extractExplicitPreferences(userMessages);

    if (explicitPrefs.languages.length > 0 || explicitPrefs.frameworks.length > 0) {
      learned.human = {
        primaryLanguages: explicitPrefs.languages.length > 0
          ? explicitPrefs.languages
          : (learned.human?.primaryLanguages || []),
        preferredFrameworks: explicitPrefs.frameworks.length > 0
          ? explicitPrefs.frameworks
          : (learned.human?.preferredFrameworks || []),
      };
    }

    if (explicitPrefs.commentLanguage) {
      learned.workflow = {
        ...learned.workflow,
        preferCodeCommentsLanguage: explicitPrefs.commentLanguage,
      };
    }

    if (explicitPrefs.detailed !== undefined) {
      learned.workflow = {
        ...learned.workflow,
        preferDetailedExplanations: explicitPrefs.detailed,
      };
    }

    // 3. 合并学习到的偏好
    if (Object.keys(learned).length > 0) {
      this.mergeLearnedPreferences(learned);
      logger.info('Learned preferences from session', { learned });
    }

    return learned;
  }

  /**
   * 提取代码块
   */
  private extractCodeBlocks(messages: Message[]): string[] {
    const codeBlocks: string[] = [];
    const codeBlockRegex = /```(?:\w+)?\n([\s\S]*?)```/g;

    for (const msg of messages) {
      let match;
      while ((match = codeBlockRegex.exec(msg.content)) !== null) {
        if (match[1] && match[1].trim().length > 50) {
          codeBlocks.push(match[1]);
        }
      }
    }

    return codeBlocks;
  }

  /**
   * 从代码推断编码风格
   */
  private inferCodingStyle(codeBlocks: string[]): CodingStyle {
    const style: CodingStyle = {};
    const allCode = codeBlocks.join('\n');

    // 缩进检测
    if (STYLE_PATTERNS.tabs.test(allCode)) {
      style.indentation = 'tabs';
    } else if (STYLE_PATTERNS.fourSpaces.test(allCode)) {
      style.indentation = '4spaces';
    } else if (STYLE_PATTERNS.twoSpaces.test(allCode)) {
      style.indentation = '2spaces';
    }

    // 引号检测
    const singleCount = (allCode.match(/'/g) || []).length;
    const doubleCount = (allCode.match(/"/g) || []).length;
    if (singleCount > doubleCount * 2) {
      style.quotes = 'single';
    } else if (doubleCount > singleCount * 2) {
      style.quotes = 'double';
    }

    // 分号检测（TypeScript/JavaScript）
    const withSemi = (allCode.match(/;\s*$/gm) || []).length;
    const withoutSemi = (allCode.match(/[^;{}\s]\s*$/gm) || []).length;
    if (withSemi > withoutSemi * 2) {
      style.semicolons = true;
    } else if (withoutSemi > withSemi * 2) {
      style.semicolons = false;
    }

    // 尾逗号检测
    if (STYLE_PATTERNS.trailingComma.test(allCode)) {
      style.trailingComma = 'es5';
    }

    return style;
  }

  /**
   * 从用户消息中提取显式偏好
   */
  private extractExplicitPreferences(messages: Message[]): {
    languages: string[];
    frameworks: string[];
    commentLanguage?: 'zh' | 'en';
    detailed?: boolean;
  } {
    const result = {
      languages: new Set<string>(),
      frameworks: new Set<string>(),
      commentLanguage: undefined as 'zh' | 'en' | undefined,
      detailed: undefined as boolean | undefined,
    };

    const allText = messages.map((m) => m.content).join('\n');

    // 提取语言偏好
    for (const rule of PREFERENCE_KEYWORDS.languages) {
      let match;
      while ((match = rule.pattern.exec(allText)) !== null) {
        result.languages.add(match[rule.group]);
      }
    }

    // 提取框架偏好
    for (const rule of PREFERENCE_KEYWORDS.frameworks) {
      let match;
      while ((match = rule.pattern.exec(allText)) !== null) {
        result.frameworks.add(match[rule.group]);
      }
    }

    // 提取注释语言偏好
    for (const rule of PREFERENCE_KEYWORDS.commentLanguage) {
      if (rule.pattern.test(allText)) {
        result.commentLanguage = rule.value;
        break;
      }
    }

    // 提取详细程度偏好
    for (const rule of PREFERENCE_KEYWORDS.detailed) {
      if (rule.pattern.test(allText)) {
        result.detailed = rule.value;
        break;
      }
    }

    return {
      languages: Array.from(result.languages),
      frameworks: Array.from(result.frameworks),
      commentLanguage: result.commentLanguage,
      detailed: result.detailed,
    };
  }

  /**
   * 合并学习到的偏好（不覆盖已有值）
   */
  private mergeLearnedPreferences(learned: LearnedPreferences): void {
    // 合并用户画像
    if (learned.human) {
      const existing = this.memory.human;
      this.memory.human = {
        ...existing,
        primaryLanguages: [...new Set([...existing.primaryLanguages, ...(learned.human.primaryLanguages || [])])],
        preferredFrameworks: [...new Set([...existing.preferredFrameworks, ...(learned.human.preferredFrameworks || [])])],
      };
    }

    // 合并编码风格（只填充空值）
    if (learned.codingStyle) {
      for (const [key, value] of Object.entries(learned.codingStyle)) {
        if (value !== undefined && this.memory.codingStyle[key as keyof CodingStyle] === undefined) {
          (this.memory.codingStyle as Record<string, unknown>)[key] = value;
        }
      }
    }

    // 合并工作流偏好（只填充空值）
    if (learned.workflow) {
      for (const [key, value] of Object.entries(learned.workflow)) {
        if (value !== undefined && this.memory.workflow[key as keyof WorkflowPreferences] === undefined) {
          (this.memory.workflow as Record<string, unknown>)[key] = value;
        }
      }
    }

    this.isDirty = true;
    this.save();
  }

  /**
   * 格式化为 System Prompt 片段
   */
  formatForSystemPrompt(): string {
    const lines: string[] = [];

    // 用户画像
    const human = this.memory.human;
    if (human.name || human.role || human.primaryLanguages.length > 0) {
      lines.push('## User Profile');
      if (human.name) lines.push(`- Name: ${human.name}`);
      if (human.role) lines.push(`- Role: ${human.role}`);
      if (human.experienceLevel) lines.push(`- Experience: ${human.experienceLevel}`);
      if (human.primaryLanguages.length > 0) {
        lines.push(`- Languages: ${human.primaryLanguages.join(', ')}`);
      }
      if (human.preferredFrameworks.length > 0) {
        lines.push(`- Frameworks: ${human.preferredFrameworks.join(', ')}`);
      }
      lines.push('');
    }

    // 编码风格
    const style = this.memory.codingStyle;
    if (Object.keys(style).length > 0) {
      lines.push('## Coding Style Preferences');
      if (style.indentation) lines.push(`- Indentation: ${style.indentation}`);
      if (style.quotes) lines.push(`- Quotes: ${style.quotes}`);
      if (style.semicolons !== undefined) {
        lines.push(`- Semicolons: ${style.semicolons ? 'yes' : 'no'}`);
      }
      if (style.trailingComma) lines.push(`- Trailing comma: ${style.trailingComma}`);
      lines.push('');
    }

    // 工作流偏好
    const workflow = this.memory.workflow;
    if (Object.keys(workflow).length > 0) {
      lines.push('## Workflow Preferences');
      if (workflow.preferredTestFramework) {
        lines.push(`- Test framework: ${workflow.preferredTestFramework}`);
      }
      if (workflow.commitMessageStyle) {
        lines.push(`- Commit style: ${workflow.commitMessageStyle}`);
      }
      if (workflow.preferCodeCommentsLanguage) {
        lines.push(`- Comments language: ${workflow.preferCodeCommentsLanguage === 'zh' ? 'Chinese' : 'English'}`);
      }
      if (workflow.preferDetailedExplanations !== undefined) {
        lines.push(`- Explanations: ${workflow.preferDetailedExplanations ? 'detailed' : 'concise'}`);
      }
      lines.push('');
    }

    if (lines.length === 0) {
      return '';
    }

    return `# User Preferences (Core Memory)\n\n${lines.join('\n')}`;
  }

  /**
   * 重置为默认值
   */
  reset(): void {
    this.memory = { ...DEFAULT_CORE_MEMORY };
    this.save();
    logger.info('Core memory reset to defaults');
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let coreMemoryInstance: CoreMemoryService | null = null;

export function getCoreMemoryService(): CoreMemoryService {
  if (!coreMemoryInstance) {
    coreMemoryInstance = new CoreMemoryService();
  }
  return coreMemoryInstance;
}

export function initCoreMemoryService(customPath?: string): CoreMemoryService {
  coreMemoryInstance = new CoreMemoryService(customPath);
  return coreMemoryInstance;
}
