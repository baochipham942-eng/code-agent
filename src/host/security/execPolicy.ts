// =====================================================================// Exec Policy - 命令执行策略持久化
// =====================================================================//
// 借鉴 Codex CLI 的 prefix_rule 设计：
// 用户批准一次命令后，生成持久化规则，后续匹配的命令自动跳过审批。
//
// 存储位置: .code-agent/exec-policy.json
// 格式: { rules: [{ pattern, decision, createdAt, source }] }

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import { getProjectConfigDir, getUserConfigDir } from '../config/configPaths';
import { canonicalizeCommand } from './canonicalizeCommand';
import { resolvedExecutable } from './commandParse';
import { isKnownSafeCommand } from './commandSafety';

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
// 导出供 `neo policy check` 离线校验复用（banned-prefix-allow 冲突检测）。
export const BANNED_PREFIXES = new Set([
  'python', 'python3', 'node', 'bash', 'sh', 'zsh',
  'sudo', 'su', 'eval', 'exec',
  // Windows shell 入口与任意执行（windows-support.md §3.2）
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'cmd', 'cmd.exe', 'iex', 'invoke-expression',
]);

// ----------------------------------------------------------------------------
// Pure matching helpers — 与 ExecPolicyStore 共享同一套语义
// （`neo policy check` 离线校验直接复用，避免实现分叉）
// ----------------------------------------------------------------------------

/** 命令策略只在统一 canonical form 上拆词；分析失败时返回空数组（不命中任何放行规则）。 */
export function tokenizePolicyCommand(command: string): string[] {
  const canonical = canonicalizeCommand(command);
  return canonical.parsingFailed || !canonical.command
    ? []
    : canonical.command.split(' ');
}

/**
 * 最长前缀匹配：更具体的规则优先；同长时先出现者胜出。
 * 返回命中的规则本身（含 pattern/decision/source），未命中返回 null。
 */
export function matchPolicyRule(
  rules: readonly PrefixRule[],
  command: string,
): PrefixRule | null {
  const tokens = tokenizePolicyCommand(command);
  if (tokens.length === 0) return null;

  let bestMatch: PrefixRule | null = null;
  let bestLength = 0;

  for (const rule of rules) {
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

  return bestMatch;
}

/**
 * 前缀是否装下了整条命令的风险：前缀自己是已知安全命令、整条却不是 ⇒ 风险在前缀外（false）。
 * 两者同安全（cat x）或前缀自身就不安全（git push / npm install）⇒ true。
 */
function prefixCarriesTheRisk(pattern: readonly string[], command: string): boolean {
  return !(isKnownSafeCommand(pattern.join(' ')) && !isKnownSafeCommand(command));
}

/**
 * 学来的 allow 规则是否真能放行这条命令。builtin 规则是产品自己声明的不受此约束；
 * 其余（source 为 user，或旧文件里根本没写 source——离线 schema 也把缺省归为 user）都要过 prefixCarriesTheRisk。
 * 运行时 match 与离线 `neo policy check/explain` 共用，避免验收看到 allow 而真机要审批。
 */
export function learnedRuleCovers(rule: PrefixRule, command: string): boolean {
  return rule.decision !== 'allow' || rule.source === 'builtin' || prefixCarriesTheRisk(rule.pattern, command);
}

/** 最长前缀命中 + 学来前缀守卫，一步给出最终决策（null = 不命中/被守卫拦下，走常规权限流程）。 */
export function resolvePolicyDecision(rules: readonly PrefixRule[], command: string): PolicyDecision | null {
  const rule = matchPolicyRule(rules, command);
  return rule && learnedRuleCovers(rule, command) ? rule.decision : null;
}

// ----------------------------------------------------------------------------
// ExecPolicyStore
// ----------------------------------------------------------------------------

export class ExecPolicyStore {
  private rules: PrefixRule[] = [];
  private filePath: string;
  private dirty = false;

  constructor(location: string | { dataDir: string }) {
    const configDir = typeof location === 'string'
      ? getProjectConfigDir(location)
      : location.dataDir;
    this.filePath = path.join(configDir, 'exec-policy.json');
    this.load();
  }

  /**
   * 匹配命令 — 检查是否有匹配的持久化规则
   *
   * @param command - bash 命令字符串
   * @returns 匹配的决策，或 null 表示未匹配
   */
  match(command: string): PolicyDecision | null {
    // 学来的前缀只放行「前缀本身就带着风险」的命令：`find .` 这种前缀单独看是安全命令，
    // 用户当初批的其实是 `-delete` 那部分，前缀没把风险装进去，就不能拿它放行
    // `find . -delete`（2026-09-05 真机学到 ['find','.'] 让 -delete 免审批）。
    // `git push` / `npm install` 前缀自身就不安全，照旧放行。
    return resolvePolicyDecision(this.rules, command);
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
    const tokens = tokenizePolicyCommand(command);
    if (tokens.length === 0) return false;

    const execution = resolvedExecutable(command);
    if (!execution || execution.program !== execution.originalProgram) {
      logger.debug('Skipping wrapped or uncertain command prefix', {
        originalProgram: execution?.originalProgram,
        resolvedProgram: execution?.program,
      });
      return false;
    }

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

    // 前缀单独看是安全命令而整条不是 ⇒ 风险在前缀之外的参数里（find . -delete），学出来的规则会比批的宽，不学。
    if (!prefixCarriesTheRisk(pattern, command)) {
      logger.debug('Skipping prefix that does not carry the approved risk', { pattern, from: command.substring(0, 80) });
      return false;
    }

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
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: ExecPolicyStore | null = null;
/** 非 null ⇒ 当前实例是按用户级配置目录建的，要跟着 CODE_AGENT_DATA_DIR 走。 */
let instanceUserDataDir: string | null = null;

/**
 * N-EVAL-EXECPOLICY-LEAK：单例建立时把 filePath 定死，而评测是**每题**才切
 * CODE_AGENT_DATA_DIR（eval-ci.ts 的 case 级 dataDir）。只要有任何一次
 * getExecPolicyStore() 发生在第一次切换之前（预热 / IPC / 上一题残留），整场评测学到的
 * 规则就全写回上一个目录——在没带 --data-dir 的跑法里那就是真实 ~/.code-agent。
 * 让单例自己比对当前 getUserConfigDir()，比要求每个切目录的调用方记得 reset 更难漏：
 * 按名字枚举调用方的清单每加一个新调用方就漏一次。
 * 带 projectDir 建的实例是项目级策略，不跟用户级目录走。
 */
export function getExecPolicyStore(projectDir?: string): ExecPolicyStore {
  if (!instance && projectDir) {
    instance = new ExecPolicyStore(projectDir);
    instanceUserDataDir = null;
    return instance;
  }
  const dataDir = getUserConfigDir();
  if (!instance || (instanceUserDataDir !== null && instanceUserDataDir !== dataDir)) {
    instance = new ExecPolicyStore({ dataDir });
    instanceUserDataDir = dataDir;
  }
  return instance;
}

export function resetExecPolicyStore(): void {
  instance = null;
  instanceUserDataDir = null;
}
