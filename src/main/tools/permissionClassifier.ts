// ============================================================================
// Permission Auto-Approve Classifier
// ============================================================================
// LLM-based classifier that determines if a tool call is safe to auto-approve.
// Reduces user interruptions while maintaining security for dangerous operations.
//
// 分层策略：
// 1. Rule-based fast path — 覆盖 80%+ 常见场景，零延迟
// 2. LLM classifier — 规则无法判断时，调用轻量模型分类
// 3. Result caching — 避免重复分类相同工具调用模式

import { createLogger } from '../services/infra/logger';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { DecisionStep } from '../../shared/contract/decisionTrace';
import { createTraceStep } from '../security/decisionTraceBuilder';
import { isBashToolName, normalizeToolName } from './toolNames';

const logger = createLogger('PermissionClassifier');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type PermissionDecision = 'approve' | 'deny' | 'ask';

export interface ClassificationResult {
  decision: PermissionDecision;
  reason: string;
  confidence: number; // 0-1
  cached: boolean;
  /** Trace step for decision transparency (only populated on deny/ask) */
  traceStep?: DecisionStep;
}

export interface ClassifierConfig {
  /** Enable LLM-based classification (default: false, falls back to rules) */
  enableLlm?: boolean;
  /** Confidence threshold for auto-approve (default: 0.8) */
  confidenceThreshold?: number;
  /** Cache TTL in ms (default: 5 min) */
  cacheTtlMs?: number;
}

interface ClassificationContext {
  workingDirectory: string;
  permissionLevel?: string;
}

interface CacheEntry {
  result: ClassificationResult;
  expiresAt: number;
}

// ----------------------------------------------------------------------------
// 常量
// ----------------------------------------------------------------------------

const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const MAX_CACHE_SIZE = 100;

// 只读工具 — 无副作用，始终自动批准
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'Read',
  'glob',
  'Glob',
  'grep',
  'Grep',
  'list_directory',
  'ListDirectory',
  'search_files',
  'SearchFiles',
  'ToolSearch',
]);

// 网络工具 — 只读网络请求，自动批准
const NETWORK_READ_TOOLS = new Set([
  'web_fetch',
  'WebFetch',
  'web_search',
  'WebSearch',
]);

// MCP 工具前缀 — 默认 ask（未知副作用）
const MCP_TOOL_PREFIXES = ['mcp_', 'mcp:', 'MCPUnified'];

// 危险 bash 模式 — 始终拒绝或要求确认
const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string; decision: PermissionDecision }> = [
  { pattern: /rm\s+(-r|-rf|-f)\s*[\/~]/, reason: '递归删除系统目录', decision: 'deny' },
  { pattern: /rm\s+-rf?\s+\*/, reason: '递归删除通配符', decision: 'deny' },
  { pattern: />\s*\/dev\/sd/, reason: '直接写入块设备', decision: 'deny' },
  { pattern: /mkfs\s/, reason: '格式化文件系统', decision: 'deny' },
  { pattern: /dd\s+if=/, reason: 'dd 磁盘操作', decision: 'deny' },
  { pattern: /:\(\)\{.*\}/, reason: 'fork bomb', decision: 'deny' },
  { pattern: /chmod\s+(-R\s+)?777/, reason: '危险权限变更', decision: 'deny' },
  { pattern: /sudo\s+rm/, reason: 'sudo 删除', decision: 'ask' },
  { pattern: /sudo\s/, reason: 'sudo 命令', decision: 'ask' },
  { pattern: /kill\s+(-9\s+)?-1/, reason: '杀死所有进程', decision: 'deny' },
  { pattern: /git\s+push\s+.*--force/, reason: 'git force push', decision: 'ask' },
  { pattern: /git\s+reset\s+--hard/, reason: 'git hard reset', decision: 'ask' },
  { pattern: /curl\s.*\|\s*(sudo\s+)?sh/, reason: 'pipe curl to shell', decision: 'deny' },
  { pattern: /wget\s.*\|\s*(sudo\s+)?sh/, reason: 'pipe wget to shell', decision: 'deny' },
];

// 写入工具名映射
const WRITE_TOOLS = new Set([
  'write_file',
  'Write',
  'edit_file',
  'Edit',
]);

const HOME_DIR = os.homedir();
const CLAUDE_MEMORY_DIR = path.join(HOME_DIR, '.claude', 'context', 'memory');
const CLAUDE_PROJECTS_DIR = path.join(HOME_DIR, '.claude', 'projects');
const CODEX_MEMORIES_DIR = path.join(HOME_DIR, '.codex', 'memories');

function expandLeadingTilde(rawPath: string): string {
  if (rawPath === '~') return HOME_DIR;
  if (rawPath.startsWith('~/')) return path.join(HOME_DIR, rawPath.slice(2));
  return rawPath;
}

function stripInlineReadParams(rawPath: string): string {
  const trimmed = rawPath.trim();

  const linesMatch = trimmed.match(/^(.+?)\s+lines?\s+\d+(?:-\d+)?$/i);
  if (linesMatch) {
    return linesMatch[1].trim();
  }

  const offsetLimitMatch = trimmed.match(/^(.+?)\s+(?:offset|limit)\b.*$/i);
  if (offsetLimitMatch) {
    return offsetLimitMatch[1].trim();
  }

  return trimmed;
}

function resolveCandidatePath(rawPath: string, workingDirectory: string): string {
  const sanitized = stripInlineReadParams(rawPath);
  const expanded = expandLeadingTilde(sanitized);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workingDirectory, expanded);
}

function isSensitiveMemoryPath(resolvedPath: string): boolean {
  if (resolvedPath === CLAUDE_MEMORY_DIR || resolvedPath.startsWith(`${CLAUDE_MEMORY_DIR}${path.sep}`)) {
    return true;
  }

  if (resolvedPath === CODEX_MEMORIES_DIR || resolvedPath.startsWith(`${CODEX_MEMORIES_DIR}${path.sep}`)) {
    return true;
  }

  if (
    (resolvedPath === CLAUDE_PROJECTS_DIR || resolvedPath.startsWith(`${CLAUDE_PROJECTS_DIR}${path.sep}`)) &&
    resolvedPath.includes(`${path.sep}memory${path.sep}`)
  ) {
    return true;
  }

  return false;
}

// ----------------------------------------------------------------------------
// PermissionClassifier
// ----------------------------------------------------------------------------

export class PermissionClassifier {
  private config: Required<ClassifierConfig>;
  private cache = new Map<string, CacheEntry>();

  constructor(config?: ClassifierConfig) {
    this.config = {
      enableLlm: config?.enableLlm ?? false,
      confidenceThreshold: config?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      cacheTtlMs: config?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    };
  }

  /**
   * 分类工具调用的安全性
   *
   * @param toolName - 工具名称
   * @param args - 工具参数
   * @param context - 执行上下文（工作目录、权限级别）
   * @returns 分类结果：approve / deny / ask
   */
  async classify(
    toolName: string,
    args: Record<string, unknown>,
    context: ClassificationContext
  ): Promise<ClassificationResult> {
    const startTime = Date.now();

    // 1. 检查缓存
    const cacheKey = this.buildCacheKey(toolName, args);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    // 2. Rule-based fast path
    const ruleResult = this.classifyByRules(toolName, args, context, startTime);
    if (ruleResult) {
      this.setCache(cacheKey, ruleResult);
      return ruleResult;
    }

    // 3. LLM classifier（规则无法判断时）
    if (this.config.enableLlm) {
      const llmResult = await this.classifyByLlm(toolName, args, context);
      if (llmResult && llmResult.confidence >= this.config.confidenceThreshold) {
        this.setCache(cacheKey, llmResult);
        return llmResult;
      }
      // LLM 信心不足，fall through to ask
      if (llmResult) {
        logger.debug('LLM confidence below threshold', {
          confidence: llmResult.confidence,
          threshold: this.config.confidenceThreshold,
        });
      }
    }

    // 4. 默认：ask 用户
    const reason = '无法自动判断安全性，需用户确认';
    const fallback: ClassificationResult = {
      decision: 'ask',
      reason,
      confidence: 0,
      cached: false,
      traceStep: createTraceStep('permission_classifier', 'fallback', 'ask', reason, startTime),
    };
    return fallback;
  }

  // --------------------------------------------------------------------------
  // Rule-based classifier
  // --------------------------------------------------------------------------

  private classifyByRules(
    toolName: string,
    args: Record<string, unknown>,
    context: ClassificationContext,
    startTime: number
  ): ClassificationResult | null {
    const sensitiveRead = this.classifySensitiveMemoryRead(toolName, args, context, startTime);
    if (sensitiveRead) {
      return sensitiveRead;
    }

    // R1: 只读工具 → approve (no traceStep on allow)
    if (READ_ONLY_TOOLS.has(toolName)) {
      return {
        decision: 'approve',
        reason: `只读工具 ${toolName}`,
        confidence: 1.0,
        cached: false,
      };
    }

    // R2: permissionLevel === 'read' → approve
    if (context.permissionLevel === 'read') {
      return {
        decision: 'approve',
        reason: `工具权限级别为 read`,
        confidence: 1.0,
        cached: false,
      };
    }

    // R3: 网络只读工具 → approve
    if (NETWORK_READ_TOOLS.has(toolName)) {
      return {
        decision: 'approve',
        reason: `网络只读工具 ${toolName}`,
        confidence: 0.95,
        cached: false,
      };
    }

    // R4: Bash 命令分类
    if (isBashToolName(toolName) && typeof args.command === 'string') {
      return this.classifyBashCommand(args.command, context, startTime);
    }

    // R5: 文件写入工具 — 按路径判断
    if (WRITE_TOOLS.has(toolName)) {
      return this.classifyFileWrite(args, context, startTime);
    }

    // R6: MCP 工具 → ask（未知副作用）
    if (this.isMcpTool(toolName)) {
      const reason = `MCP 工具 ${toolName} 可能有副作用`;
      return {
        decision: 'ask',
        reason,
        confidence: 0.9,
        cached: false,
        traceStep: createTraceStep('permission_classifier', 'R6: mcp_tool', 'ask', reason, startTime),
      };
    }

    // 规则无法判断
    return null;
  }

  private classifySensitiveMemoryRead(
    toolName: string,
    args: Record<string, unknown>,
    context: ClassificationContext,
    startTime: number
  ): ClassificationResult | null {
    if (!READ_ONLY_TOOLS.has(toolName) && context.permissionLevel !== 'read') {
      return null;
    }

    const candidates = Object.entries(args)
      .filter(([key, value]) => {
        if (typeof value !== 'string' || !value.trim()) return false;
        return key.includes('path') || key === 'pattern';
      })
      .map(([, value]) => value as string);

    for (const candidate of candidates) {
      const resolved = resolveCandidatePath(candidate, context.workingDirectory);
      if (!isSensitiveMemoryPath(resolved)) continue;

      const reason = `读取私人记忆目录需要用户确认: ${resolved}`;
      return {
        decision: 'ask',
        reason,
        confidence: 0.98,
        cached: false,
        traceStep: createTraceStep('permission_classifier', 'R0: sensitive_memory_read', 'ask', reason, startTime),
      };
    }

    return null;
  }

  /**
   * Bash 命令分类
   */
  private classifyBashCommand(
    command: string,
    context: ClassificationContext,
    startTime: number
  ): ClassificationResult | null {
    const trimmed = command.trim();

    // B1: 危险模式检测
    for (const { pattern, reason, decision } of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(trimmed)) {
        const fullReason = `危险命令: ${reason}`;
        const outcome = decision === 'approve' ? 'allow' : decision === 'deny' ? 'deny' : 'ask';
        return {
          decision,
          reason: fullReason,
          confidence: 1.0,
          cached: false,
          traceStep: outcome !== 'allow'
            ? createTraceStep('permission_classifier', `B1: ${reason}`, outcome, fullReason, startTime)
            : undefined,
        };
      }
    }

    // B2: 只读命令模式 — 常见的信息查看命令
    const readOnlyPrefixes = [
      'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
      'pwd', 'whoami', 'uname', 'date', 'which', 'where', 'type',
      'echo', 'printf',
      'git status', 'git log', 'git diff', 'git branch', 'git show',
      'git rev-parse', 'git describe', 'git remote -v', 'git tag',
      'node -v', 'npm -v', 'npx tsc --noEmit', 'npm run typecheck',
      'npm run lint', 'npm run test', 'npm run build',
      'python --version', 'python3 --version',
      'cargo --version', 'rustc --version',
      'grep', 'rg', 'find', 'fd',
      'jq', 'yq',
      'curl --version', 'wget --version',
    ];

    for (const prefix of readOnlyPrefixes) {
      if (trimmed === prefix || trimmed.startsWith(prefix + ' ') || trimmed.startsWith(prefix + '\t')) {
        return {
          decision: 'approve',
          reason: `安全命令: ${prefix}`,
          confidence: 0.95,
          cached: false,
        };
      }
    }

    // B3: 在项目目录内的 npm/npx 命令 → approve
    if (/^(npm|npx|pnpm|yarn)\s/.test(trimmed)) {
      return {
        decision: 'approve',
        reason: '包管理器命令',
        confidence: 0.9,
        cached: false,
      };
    }

    // B4: cd 命令 → approve
    if (/^cd\s/.test(trimmed)) {
      return {
        decision: 'approve',
        reason: 'cd 命令',
        confidence: 1.0,
        cached: false,
      };
    }

    // 无法判断
    return null;
  }

  /**
   * 文件写入分类 — 按目标路径判断
   */
  private classifyFileWrite(
    args: Record<string, unknown>,
    context: ClassificationContext,
    startTime: number
  ): ClassificationResult | null {
    const filePath = (args.file_path as string) || (args.path as string);
    if (!filePath) {
      const reason = '文件路径缺失';
      return {
        decision: 'ask',
        reason,
        confidence: 0.5,
        cached: false,
        traceStep: createTraceStep('permission_classifier', 'W0: no_path', 'ask', reason, startTime),
      };
    }

    const resolved = path.resolve(context.workingDirectory, filePath);
    const cwd = path.resolve(context.workingDirectory);

    // W1: 写入项目目录内 → approve (no traceStep)
    if (resolved.startsWith(cwd + path.sep) || resolved === cwd) {
      return {
        decision: 'approve',
        reason: '写入项目目录内',
        confidence: 0.95,
        cached: false,
      };
    }

    // W2: 写入 /tmp → approve (no traceStep)
    if (resolved.startsWith('/tmp/') || resolved.startsWith('/tmp')) {
      return {
        decision: 'approve',
        reason: '写入 /tmp 目录',
        confidence: 0.95,
        cached: false,
      };
    }

    // W3: 写入项目目录外 → ask
    const reason = `写入项目目录外: ${resolved}`;
    return {
      decision: 'ask',
      reason,
      confidence: 0.9,
      cached: false,
      traceStep: createTraceStep('permission_classifier', 'W3: outside_project', 'ask', reason, startTime),
    };
  }

  /**
   * 判断是否为 MCP 工具
   */
  private isMcpTool(toolName: string): boolean {
    return MCP_TOOL_PREFIXES.some(
      (prefix) => toolName.startsWith(prefix) || toolName === prefix
    );
  }

  // --------------------------------------------------------------------------
  // LLM classifier（stub — 待接入 model router）
  // --------------------------------------------------------------------------

  private async classifyByLlm(
    _toolName: string,
    _args: Record<string, unknown>,
    _context: ClassificationContext
  ): Promise<ClassificationResult | null> {
    // TODO: 接入 model router，使用轻量模型（如 deepseek-chat）分类
    // 预期实现：
    // 1. 构建 compact prompt: {toolName, args_summary, workingDirectory}
    // 2. 调用 model router 的 fast/cheap 模型
    // 3. 解析 JSON 响应: {decision, reason, confidence}
    // 4. 返回 ClassificationResult
    logger.debug('LLM classifier not yet implemented, falling back to ask');
    return {
      decision: 'ask',
      reason: 'LLM 分类器未实现',
      confidence: 0,
      cached: false,
    };
  }

  // --------------------------------------------------------------------------
  // Cache
  // --------------------------------------------------------------------------

  private buildCacheKey(toolName: string, args: Record<string, unknown>): string {
    if (isBashToolName(toolName)) {
      // Bash 命令：取前两个 token 作为 pattern
      const command = (args.command as string) || '';
      const tokens = command.trim().split(/\s+/).slice(0, 2).join(' ');
      return crypto.createHash('md5').update(`bash:${tokens}`).digest('hex');
    }

    // 其他工具：标准化参数后 hash
    const argsPattern = this.normalizeArgs(args);
    return crypto.createHash('md5').update(`${normalizeToolName(toolName)}:${JSON.stringify(argsPattern)}`).digest('hex');
  }

  /**
   * 标准化参数 — 移除具体值，只保留结构
   * 用于缓存 key 生成，使相似调用共享缓存
   */
  private normalizeArgs(args: Record<string, unknown>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        // 文件路径：保留目录层级但模糊化文件名
        if (key.includes('path') || key.includes('file')) {
          const dir = path.dirname(value);
          normalized[key] = dir;
        } else if (value.length > 100) {
          // 长字符串：只保留类型标记
          normalized[key] = `<string:${value.length}>`;
        } else {
          normalized[key] = value;
        }
      } else {
        normalized[key] = typeof value as string;
      }
    }
    return normalized;
  }

  private getFromCache(key: string): ClassificationResult | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.result;
  }

  private setCache(key: string, result: ClassificationResult): void {
    // 缓存容量控制：FIFO 淘汰
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      result,
      expiresAt: Date.now() + this.config.cacheTtlMs,
    });
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: MAX_CACHE_SIZE };
  }
}

// ----------------------------------------------------------------------------
// Singleton & Public API
// ----------------------------------------------------------------------------

let instance: PermissionClassifier | null = null;

/**
 * 获取分类器单例
 */
export function getPermissionClassifier(config?: ClassifierConfig): PermissionClassifier {
  if (!instance || config) {
    instance = new PermissionClassifier(config);
  }
  return instance;
}

/**
 * 分类工具调用的安全性（快捷方法）
 *
 * @param toolName - 工具名称
 * @param args - 工具参数
 * @param context - 执行上下文
 * @returns 分类结果
 */
export async function classifyPermission(
  toolName: string,
  args: Record<string, unknown>,
  context: { workingDirectory: string; permissionLevel?: string }
): Promise<ClassificationResult> {
  return getPermissionClassifier().classify(toolName, args, context);
}
