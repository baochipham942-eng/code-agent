// ============================================================================
// Exec Policy - 命令执行策略持久化
// ============================================================================
//
// 借鉴 Codex CLI 的 prefix_rule 设计：
// 用户批准一次命令后，生成持久化规则，后续匹配的命令自动跳过审批。
//
// 存储位置: .code-agent/exec-policy.json
// 格式: { rules: [{ pattern, decision, createdAt, source }] }

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ExecPolicy');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type PolicyDecision = 'allow' | 'prompt' | 'forbidden';

export interface PrefixRule {
  /** 命令前缀模式，如 ["npm", "install"] */
  pattern: string[];
  /** 决策 */
  decision: PolicyDecision;
  /** 创建时间 */
  createdAt: number;
  /** 规则来源 */
  source: 'user' | 'builtin';
}

interface ExecPolicyFile {
  version: 1;
  rules: PrefixRule[];
}

// 禁止作为 prefix_rule 的模式（过于宽泛）
const BANNED_PREFIXES = new Set([
  'python', 'python3', 'node', 'bash', 'sh', 'zsh',
  'sudo', 'su', 'eval', 'exec',
]);

// ----------------------------------------------------------------------------
// ExecPolicyStore
// ----------------------------------------------------------------------------

export class ExecPolicyStore {
  private rules: PrefixRule[] = [];
  private filePath: string;
  private dirty = false;

  constructor(projectDir: string) {
    this.filePath = path.join(projectDir, '.code-agent', 'exec-policy.json');
    this.load();
  }

  /**
   * 匹配命令 — 检查是否有匹配的持久化规则
   *
   * @param command - bash 命令字符串
   * @returns 匹配的决策，或 null 表示未匹配
   */
  match(command: string): PolicyDecision | null {
    const tokens = this.tokenize(command);
    if (tokens.length === 0) return null;

    // 从最长匹配开始（更具体的规则优先）
    let bestMatch: PrefixRule | null = null;
    let bestLength = 0;

    for (const rule of this.rules) {
      if (rule.pattern.length > tokens.length) continue;

      let matches = true;
      for (let i = 0; i < rule.pattern.length; i++) {
        if (rule.pattern[i] !== tokens[i]) {
          matches = false;
          break;
        }
      }

      if (matches && rule.pattern.length > bestLength) {
        bestMatch = rule;
        bestLength = rule.pattern.length;
      }
    }

    return bestMatch?.decision ?? null;
  }

  /**
   * 从用户批准的命令中提取规则
   *
   * 例如用户批准 "npm install lodash"，
   * 提取规则 ["npm", "install"]（去掉具体参数）
   *
   * @param command - 用户批准的命令
   * @returns 是否成功添加规则
   */
  learnFromApproval(command: string): boolean {
    const tokens = this.tokenize(command);
    if (tokens.length === 0) return false;

    // 取前 1-2 个 token 作为 prefix（避免过于宽泛或过于具体）
    const program = tokens[0];

    // 检查是否为禁止的 prefix
    if (BANNED_PREFIXES.has(program)) {
      logger.debug('Skipping banned prefix', { program });
      return false;
    }

    // 取前缀：程序名 + 第一个子命令
    const prefixLength = Math.min(2, tokens.length);
    const pattern = tokens.slice(0, prefixLength);

    // 检查是否已存在相同规则
    const exists = this.rules.some(r =>
      r.pattern.length === pattern.length &&
      r.pattern.every((p, i) => p === pattern[i])
    );
    if (exists) return false;

    const rule: PrefixRule = {
      pattern,
      decision: 'allow',
      createdAt: Date.now(),
      source: 'user',
    };

    this.rules.push(rule);
    this.dirty = true;
    logger.info('Learned new exec policy rule', { pattern, from: command.substring(0, 80) });

    // 异步保存，不阻塞
    this.save().catch(err => logger.error('Failed to save exec policy', err));

    return true;
  }

  /**
   * 添加显式规则
   */
  addRule(pattern: string[], decision: PolicyDecision, source: 'user' | 'builtin' = 'user'): void {
    // 去重
    const exists = this.rules.some(r =>
      r.pattern.length === pattern.length &&
      r.pattern.every((p, i) => p === pattern[i])
    );
    if (exists) return;

    this.rules.push({
      pattern,
      decision,
      createdAt: Date.now(),
      source,
    });
    this.dirty = true;
  }

  /**
   * 获取所有规则
   */
  getRules(): readonly PrefixRule[] {
    return this.rules;
  }

  /**
   * 持久化到磁盘
   */
  async save(): Promise<void> {
    if (!this.dirty) return;

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: ExecPolicyFile = {
        version: 1,
        rules: this.rules,
      };

      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
      logger.debug('Exec policy saved', { path: this.filePath, ruleCount: this.rules.length });
    } catch (error) {
      logger.error('Failed to save exec policy', error);
    }
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;

      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as ExecPolicyFile;

      if (data.version === 1 && Array.isArray(data.rules)) {
        this.rules = data.rules;
        logger.info('Loaded exec policy', { ruleCount: this.rules.length });
      }
    } catch (error) {
      logger.warn('Failed to load exec policy, starting fresh', error);
      this.rules = [];
    }
  }

  /**
   * 简单分词（跳过引号内的空格）
   */
  private tokenize(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (const ch of command.trim()) {
      if (!inQuote && (ch === '"' || ch === "'")) {
        inQuote = true;
        quoteChar = ch;
      } else if (inQuote && ch === quoteChar) {
        inQuote = false;
      } else if (!inQuote && (ch === ' ' || ch === '\t')) {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);

    return tokens;
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: ExecPolicyStore | null = null;

export function getExecPolicyStore(projectDir?: string): ExecPolicyStore {
  if (!instance && projectDir) {
    instance = new ExecPolicyStore(projectDir);
  }
  if (!instance) {
    // Fallback: use home directory
    instance = new ExecPolicyStore(process.env.HOME || '/tmp');
  }
  return instance;
}

export function resetExecPolicyStore(): void {
  instance = null;
}
