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
import {
  createHostReason,
  HostReasonCode,
  type HostReasonPayload,
} from '../../shared/contract/permission';
import { createTraceStep } from '../security/decisionTraceBuilder';
import { isKnownSafeCommand, splitCompoundCommand } from '../security/commandSafety';
import { canonicalizeCommand } from '../security/canonicalizeCommand';
import { RM_FLAGS_REQUIRED, RM_HEAD } from '../security/rmFlagPattern';
import { checkCommandPolicy } from './modules/shell/commandPolicy';
import { isBashToolName, normalizeToolName } from './toolNames';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { isPathWithinRoot } from '../runtime/workspaceScope';
import { connectorExternalWriteReason, isConnectorToolName } from '../../shared/contract/workbenchTools';
import { isSensitiveCredentialPath } from '../sandbox/sensitivePaths';

const logger = createLogger('PermissionClassifier');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type PermissionDecision = 'approve' | 'deny' | 'ask';

export interface ClassificationResult {
  decision: PermissionDecision;
  /** Host→renderer 的稳定原因载荷；reason 仅供 host 内部日志兼容。 */
  hostReason?: HostReasonPayload;
  reason: string;
  confidence: number; // 0-1
  cached: boolean;
  /** Stable UI presentation code for deterministic Host denials. */
  errorCode?: string;
  /** Trace step for decision transparency (only populated on deny/ask) */
  traceStep?: DecisionStep;
  /**
   * EXTERNAL 风险类标记（B1）：工具是否产生对外可见副作用（发出去收不回，如发邮件/IM 消息）。
   * 与 decision 正交、不改变审批结果——由 resolveToolPermissionClassification 统一打标，
   * 供 B2 无人值守停车 / B4 target 授权与审计消费。判据见 tools/externalSideEffect.ts。
   */
  external?: boolean;
  /**
   * 信任边界 ask（W3 写边界）：终审层的便利放行（devModeAutoApprove / autoApprove[level] /
   * renderer 权限记忆）必须让路，由 toolExecutor 映射为 forceConfirm。与 directory_access
   * 同性质——边界决策不该被为日常操作设的开关顺带批掉（真机事故 2026-08-13：W3 ask 被
   * devModeAutoApprove 自动放行，文件真写进 $HOME）。
   */
  trustBoundary?: boolean;
}

function classificationHostReason(
  result: ClassificationResult,
  toolName: string,
): ClassificationResult {
  if (result.hostReason) return result;
  const code = result.decision === 'approve'
    ? HostReasonCode.PermissionClassifierAllowed
    : result.decision === 'deny'
      ? HostReasonCode.PermissionClassifierDenied
      : HostReasonCode.PermissionClassifierConfirmationRequired;
  return {
    ...result,
    hostReason: createHostReason(code, result.reason, { toolName }),
  };
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
  /** Base directory for resolving relative tool paths. */
  workingDirectory: string;
  /** Authoritative write boundary. Absent means no write target is inside a workspace. */
  workspaceRoot?: string;
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

const DELEGATION_TOOLS = new Set([
  'Task',
  'spawn_agent',
  'AgentSpawn',
]);

const PROCESS_OBSERVATION_ACTIONS = new Set(['list', 'poll', 'log', 'output']);
const PROCESS_CONTROL_ACTIONS = new Set(['write', 'submit', 'kill']);

// MCP 工具前缀 — 默认 ask（未知副作用）
const MCP_TOOL_PREFIXES = ['mcp_', 'mcp:', 'MCPUnified'];

// MCPUnified 的纯只读 action：不改动任何外部/本地状态（MCP 资源按协议设计为只读）。
// invoke（任意工具调用）与 add_server（改配置、起进程）不在此列。
const MCPUNIFIED_READ_ONLY_ACTIONS = new Set(['status', 'list_tools', 'list_resources', 'read_resource']);

// 危险 bash 模式 — 始终拒绝或要求确认
const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string; decision: PermissionDecision }> = [
  // rm 的绝对/相对目标先解析为真实路径，再由 classifyResolvedRm 判 critical path。
  { pattern: new RegExp(`${RM_HEAD}${RM_FLAGS_REQUIRED}\\*`), reason: '递归删除通配符', decision: 'deny' },
  { pattern: />\s*\/dev\/sd/, reason: '直接写入块设备', decision: 'deny' },
  { pattern: /mkfs\s/, reason: '格式化文件系统', decision: 'deny' },
  { pattern: /\bdd\b[^;&|]*\bof=\/dev\//, reason: 'dd 写入设备', decision: 'deny' },
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
  'append_file',
  'Append',
  'edit_file',
  'Edit',
]);

const HOME_DIR = os.homedir();
const CLAUDE_MEMORY_DIR = path.join(HOME_DIR, '.claude', 'context', 'memory');
const CLAUDE_PROJECTS_DIR = path.join(HOME_DIR, '.claude', 'projects');
const CODEX_MEMORIES_DIR = path.join(HOME_DIR, '.codex', 'memories');
const CREDENTIAL_READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'strings', 'xxd', 'base64', 'cp', 'scp',
]);
const SYSTEM_DIRECTORIES = [
  'System', 'usr', 'bin', 'sbin', 'etc', 'var', 'private', 'opt', 'cores', 'dev', 'Network', 'Library',
].map((name) => path.join(path.parse(HOME_DIR).root, name));

function expandLeadingTilde(rawPath: string): string {
  if (rawPath === '~') return HOME_DIR;
  if (rawPath.startsWith('~/')) return path.join(HOME_DIR, rawPath.slice(2));
  if (rawPath === '$HOME' || rawPath === '${HOME}') return HOME_DIR;
  if (rawPath.startsWith('$HOME/')) return path.join(HOME_DIR, rawPath.slice(6));
  if (rawPath.startsWith('${HOME}/')) return path.join(HOME_DIR, rawPath.slice(8));
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

function isPathInside(candidate: string, boundary: string): boolean {
  const relative = path.relative(boundary, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

function commandWords(command: string): string[] {
  // B1 必须与硬阻断层使用同一份 shell 规范化结果。这里不能直接按原始空白切词：
  // shell 会在执行前去掉普通引号并展开 $HOME，若分类器保留引号，凭据路径与 git
  // 配置键就能用 `"..."` 绕过。无法静态解析的命令已由 classifyBash 的 B0
  // parsingFailed 分支 fail-closed，因此这里消费 canonical form 是安全的。
  return canonicalizeCommand(command).command.split(/\s+/).filter(Boolean);
}

function commandProgram(word: string | undefined): string {
  return word ? path.posix.basename(word) : '';
}

const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function effectiveCommandWords(command: string): string[] {
  const words = commandWords(command);
  let index = 0;
  while (index < words.length) {
    while (index < words.length && SHELL_ASSIGNMENT.test(words[index])) index += 1;
    const wrapperStart = index;
    const program = commandProgram(words[index]);

    if (program === 'command') {
      index += 1;
      while (index < words.length && words[index].startsWith('-')) {
        const option = words[index];
        if (option === '--') {
          index += 1;
          break;
        }
        // `command -v/-V` only inspects names; it does not execute the following word.
        if (/^-[p]*[vV]/.test(option)) return words.slice(wrapperStart);
        if (!/^-p+$/.test(option)) return words.slice(wrapperStart);
        index += 1;
      }
      continue;
    }

    if (program !== 'env') return words.slice(index);
    index += 1;
    while (index < words.length) {
      const word = words[index];
      if (word === '--') {
        index += 1;
        break;
      }
      if (SHELL_ASSIGNMENT.test(word)) {
        index += 1;
        continue;
      }
      if (['-u', '--unset', '-C', '--chdir'].includes(word)) {
        index += 2;
        continue;
      }
      if (word.startsWith('--unset=') || word.startsWith('--chdir=')) {
        index += 1;
        continue;
      }
      if (word.startsWith('-')) {
        index += 1;
        continue;
      }
      break;
    }
  }
  return words.slice(index);
}

function gitCommand(command: string): { subcommand: string; args: string[] } | null {
  const words = effectiveCommandWords(command);
  if (commandProgram(words[0]) !== 'git') return null;
  let index = 1;
  while (index < words.length && words[index].startsWith('-')) {
    const option = words[index];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(option)) index += 2;
    else index += 1;
  }
  if (index >= words.length) return null;
  return { subcommand: words[index], args: words.slice(index + 1) };
}

function gitMutationReason(command: string): string | null {
  const git = gitCommand(command);
  if (!git) return null;
  if (git.subcommand === 'push') return 'git push 会写入远端';
  if (git.subcommand === 'remote') {
    const action = git.args.find((arg) => !arg.startsWith('-'));
    return action && ['set-url', 'add', 'rename'].includes(action)
      ? '修改 git 远端配置'
      : null;
  }
  if (git.subcommand !== 'config') return null;

  const readFlags = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope']);
  const mutationFlags = new Set(['--add', '--replace-all', '--unset', '--unset-all', '--remove-section', '--rename-section']);
  const optionsWithValue = new Set(['--file', '-f', '--blob', '--type', '--default']);
  let hasReadFlag = false;
  let hasMutationFlag = false;
  const operands: string[] = [];
  for (let index = 0; index < git.args.length; index += 1) {
    const arg = git.args[index];
    if (readFlags.has(arg)) {
      hasReadFlag = true;
      continue;
    }
    if (mutationFlags.has(arg)) {
      hasMutationFlag = true;
      continue;
    }
    if (optionsWithValue.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    operands.push(arg);
  }
  const key = operands[0]?.toLowerCase();
  if (!key) return null;
  const protectedKey = /^url\..+\.insteadof$/i.test(key)
    || /^credential(?:\.|$)/i.test(key)
    || key === 'core.sshcommand'
    || key === 'http.proxy';
  return protectedKey && !hasReadFlag && (hasMutationFlag || operands.length >= 2)
    ? '修改 git 远端或凭据配置'
    : null;
}

function credentialReadTarget(command: string, context: ClassificationContext): string | null {
  const words = effectiveCommandWords(command);
  if (!CREDENTIAL_READ_COMMANDS.has(commandProgram(words[0]))) return null;
  const projectRoot = context.workspaceRoot ?? context.workingDirectory;
  for (const word of words.slice(1)) {
    if (!word || word.startsWith('-')) continue;
    const resolved = resolveCandidatePath(word, context.workingDirectory);
    if (isSensitiveCredentialPath(resolved, { homeDir: HOME_DIR, projectRoot })) return resolved;
  }
  return null;
}

function readPathCandidates(args: Record<string, unknown>): string[] {
  return Object.entries(args)
    .filter(([key, value]) => {
      if (typeof value !== 'string' || !value.trim()) return false;
      return key.includes('path') || key === 'pattern';
    })
    .map(([, value]) => value as string);
}

function resolvedRecursiveRmTargets(command: string, workingDirectory: string): string[] | null {
  const words = effectiveCommandWords(command);
  if (commandProgram(words[0]) !== 'rm') return null;
  const flags = words.slice(1).filter((word) => word.startsWith('-') && word !== '--');
  const recursive = flags.some((flag) => flag === '--recursive' || /^-[A-Za-z]*[rR]/.test(flag));
  if (!recursive) return null;

  return words.slice(1)
    .filter((word) => !word.startsWith('-'))
    .map((target) => resolveCandidatePath(target, workingDirectory));
}

function resolvedRmCriticalTarget(command: string, context: ClassificationContext): string | null {
  const workdir = path.resolve(context.workingDirectory);
  const workspace = path.resolve(context.workspaceRoot ?? workdir);
  const targets = resolvedRecursiveRmTargets(command, workdir);
  if (!targets) return null;

  for (const resolved of targets) {
    const root = path.parse(resolved).root;
    const rootLevel = path.dirname(resolved) === root;
    const home = resolved === HOME_DIR;
    const workdirOrParent = isPathInside(workdir, resolved);
    if (resolved === root || rootLevel || home || workdirOrParent) return resolved;

    // The workspace boundary is authoritative even when macOS places the
    // checkout below /private/tmp. Its descendants continue through the
    // normal classifier chain instead of inheriting a lexical system-dir deny.
    if (isPathInside(resolved, workspace)) continue;

    const systemDirectory = SYSTEM_DIRECTORIES.some((directory) => isPathInside(resolved, directory));
    if (systemDirectory) return resolved;
  }
  return null;
}

export function recursiveRmIsContainedInWorkspace(
  command: string,
  context: Pick<ClassificationContext, 'workingDirectory' | 'workspaceRoot'>,
): boolean {
  const workdir = path.resolve(context.workingDirectory);
  const workspace = path.resolve(context.workspaceRoot ?? workdir);
  const targets = resolvedRecursiveRmTargets(command, workdir);
  if (!targets?.length) return false;
  return targets.every((resolved) => (
    isPathInside(resolved, workspace)
    && !isPathInside(workdir, resolved)
  ));
}

function contextAfterCdSegment(
  segment: string,
  context: ClassificationContext,
): ClassificationContext | null {
  const words = commandWords(segment);
  if (commandProgram(words[0]) !== 'cd') return null;

  const args = words.slice(1);
  const separator = args.indexOf('--');
  const candidates = (separator >= 0 ? args.slice(separator + 1) : args)
    .filter((arg) => !arg.startsWith('-'));
  const target = candidates[0] ?? '~';
  // `cd -` depends on shell history, so its successor cwd cannot be reconstructed here.
  if (target === '-') return context;
  return {
    ...context,
    workingDirectory: resolveCandidatePath(target, context.workingDirectory),
  };
}

/**
 * P0 safe-command bypass must not skip actions whose arguments change the
 * permission decision. Keep this predicate beside the classifier rules so the
 * fast path and full classification cannot drift.
 */
export function bashCommandRequiresPermission(
  command: string,
  context: Pick<ClassificationContext, 'workingDirectory' | 'workspaceRoot'>,
): boolean {
  const canonical = checkCommandPolicy(command).canonicalCommand;
  const segments = splitCompoundCommand(canonical);
  if (!segments) return false;
  let segmentContext: ClassificationContext = { ...context, permissionLevel: 'execute' };
  return segments.some((segment) => {
    const advancedContext = contextAfterCdSegment(segment, segmentContext);
    if (advancedContext) {
      segmentContext = advancedContext;
      return false;
    }
    return credentialReadTarget(segment, segmentContext) !== null
      || gitMutationReason(segment) !== null
      || resolvedRmCriticalTarget(segment, segmentContext) !== null;
  });
}

export function readArgumentsRequirePermission(
  toolName: string,
  args: Record<string, unknown>,
  context: Pick<ClassificationContext, 'workingDirectory' | 'workspaceRoot'>,
): boolean {
  if (!READ_ONLY_TOOLS.has(toolName)) return false;
  return readPathCandidates(args).some((candidate) => {
    const resolved = resolveCandidatePath(candidate, context.workingDirectory);
    return isSensitiveCredentialPath(resolved, {
      homeDir: HOME_DIR,
      projectRoot: context.workspaceRoot ?? context.workingDirectory,
    });
  });
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
    const cacheKey = this.buildCacheKey(toolName, args, context);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return { ...classificationHostReason(cached, toolName), cached: true };
    }

    // 2. Rule-based fast path
    const ruleResult = this.classifyByRules(toolName, args, context, startTime);
    if (ruleResult) {
      const structured = classificationHostReason(ruleResult, toolName);
      this.setCache(cacheKey, structured);
      return structured;
    }

    // 3. LLM classifier（规则无法判断时）
    if (this.config.enableLlm) {
      const llmResult = await this.classifyByLlm(toolName, args, context);
      if (llmResult && llmResult.confidence >= this.config.confidenceThreshold) {
        const structured = classificationHostReason(llmResult, toolName);
        this.setCache(cacheKey, structured);
        return structured;
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
    return classificationHostReason(fallback, toolName);
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

    // C1: 连接器写回会在外部系统产生真实副作用，必须确定性逐次确认。
    // 工具归属来自连接器描述符，写权限来自工具 schema 传入的 context，避免按名字猜动作。
    if (context.permissionLevel === 'write' && isConnectorToolName(toolName)) {
      const reason = connectorExternalWriteReason(toolName);
      if (reason) {
        return {
          decision: 'ask',
          reason,
          confidence: 1.0,
          cached: false,
          traceStep: createTraceStep(
            'permission_classifier',
            'C1: connector_external_write',
            'ask',
            reason,
            startTime,
          ),
          trustBoundary: true,
        };
      }
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

    // R4: 内部多代理委派工具 → approve
    if (DELEGATION_TOOLS.has(toolName)) {
      return {
        decision: 'approve',
        reason: `内部委派工具 ${toolName}`,
        confidence: 1.0,
        cached: false,
      };
    }

    const processAction = this.classifyProcessAction(toolName, args, startTime);
    if (processAction) {
      return processAction;
    }

    // R5: Bash 命令分类
    if (isBashToolName(toolName) && typeof args.command === 'string') {
      return this.classifyBashCommand(args.command, context, startTime);
    }

    // R6: 文件写入工具 — 按路径判断
    if (WRITE_TOOLS.has(toolName)) {
      return this.classifyFileWrite(toolName, args, context, startTime);
    }

    // R7: MCP 工具 → ask（未知副作用）
    if (this.isMcpTool(toolName)) {
      // R6b: MCPUnified 的纯只读 action（连接状态/工具与资源清单/读资源）没有写副作用，
      // 与 web_fetch 同级——只读操作永不进确认门（headless 下 ask = 一刀切拒，
      // status 都被 fail-closed 就是这里的 over-gating）。invoke / add_server 维持 ask。
      if (toolName === 'MCPUnified' && MCPUNIFIED_READ_ONLY_ACTIONS.has(String(args.action ?? ''))) {
        return {
          decision: 'approve',
          reason: `MCPUnified 只读动作: ${String(args.action)}`,
          confidence: 0.95,
          cached: false,
        };
      }
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

  private classifyProcessAction(
    toolName: string,
    args: Record<string, unknown>,
    startTime: number
  ): ClassificationResult | null {
    if (toolName !== 'Process') return null;
    const action = typeof args.action === 'string' ? args.action : '';

    if (PROCESS_OBSERVATION_ACTIONS.has(action)) {
      return {
        decision: 'approve',
        reason: `Process 观察类动作: ${action}`,
        confidence: 1.0,
        cached: false,
      };
    }

    if (PROCESS_CONTROL_ACTIONS.has(action)) {
      const reason = `Process 控制类动作需要确认: ${action}`;
      return {
        decision: 'ask',
        reason,
        confidence: 0.95,
        cached: false,
        traceStep: createTraceStep('permission_classifier', 'P1: process_control_action', 'ask', reason, startTime),
      };
    }

    const reason = 'Process action 缺失或未知，需用户确认';
    return {
      decision: 'ask',
      reason,
      confidence: 0.7,
      cached: false,
      traceStep: createTraceStep('permission_classifier', 'P0: process_unknown_action', 'ask', reason, startTime),
    };
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

    const candidates = readPathCandidates(args);

    for (const candidate of candidates) {
      const resolved = resolveCandidatePath(candidate, context.workingDirectory);
      if (isSensitiveCredentialPath(resolved, {
        homeDir: HOME_DIR,
        projectRoot: context.workspaceRoot ?? context.workingDirectory,
      })) {
        const reason = `读取凭据路径需要用户确认: ${resolved}`;
        return {
          decision: 'ask',
          reason,
          confidence: 1,
          cached: false,
          traceStep: createTraceStep('permission_classifier', 'R0: sensitive_credential_read', 'ask', reason, startTime),
          trustBoundary: true,
        };
      }
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
    const policyDecision = checkCommandPolicy(command);
    const trimmed = policyDecision.canonicalCommand;
    if (!policyDecision.allowed) {
      const reason = `命令策略拒绝: ${policyDecision.reason ?? 'blocked'}`;
      return {
        decision: 'deny',
        reason,
        confidence: 1.0,
        cached: false,
        traceStep: createTraceStep(
          'permission_classifier',
          policyDecision.source === 'hard-block' ? 'B0: command_hard_block' : 'B0: command_user_deny',
          'deny',
          reason,
          startTime,
        ),
      };
    }

    if (policyDecision.parsingFailed) {
      const reason = `命令无法可靠拆词: ${policyDecision.parsingFailureReason ?? 'unknown parse failure'}`;
      return {
        decision: 'ask',
        reason,
        confidence: 1,
        cached: false,
        traceStep: createTraceStep('permission_classifier', 'B0: command_parse_failure', 'ask', reason, startTime),
      };
    }

    if (policyDecision.action === 'allow') {
      return {
        decision: 'approve',
        reason: policyDecision.reason ?? '命令级权限规则允许',
        confidence: 1.0,
        cached: false,
      };
    }

    const segments = splitCompoundCommand(trimmed);
    if (!segments || segments.length === 0) {
      return null;
    }

    if (segments.length === 1) {
      // 拆段器会丢弃尾部空段；只有整串确实等于该段时才允许走单段 cd 快捷判断。
      if (segments[0] !== trimmed) return null;
      return this.classifyBashSegment(segments[0], context, startTime);
    }

    // 沿用 #1609 的逐段风险分类，同时把 cd 的 cwd 影响传给后续段的路径解析。
    // 不改变 cd 自身或未知段的判决，只修正后续 rm/凭据相对路径的解析基准。
    let strictest: ClassificationResult | null = null;
    let segmentContext = context;
    let executableSegmentCount = 0;
    for (const segment of segments) {
      const advancedContext = contextAfterCdSegment(segment, segmentContext);
      if (advancedContext) {
        segmentContext = advancedContext;
        continue;
      }
      executableSegmentCount += 1;
      const result = this.classifyBashSegment(segment, segmentContext, startTime)
        ?? this.createUnknownCompoundAsk(segment, startTime);
      if (result.decision === 'deny') return result;
      if (!strictest || result.decision === 'ask') strictest = result;
    }

    if (executableSegmentCount === 0) {
      return {
        decision: 'approve',
        reason: 'cd 命令',
        confidence: 1.0,
        cached: false,
      };
    }

    return strictest;
  }

  /** 对单个 Bash 段按 B1 → B4 分类。 */
  private classifyBashSegment(
    command: string,
    context: ClassificationContext,
    startTime: number,
  ): ClassificationResult | null {
    const canonicalCommand = canonicalizeCommand(command).command;
    const rmCriticalTarget = resolvedRmCriticalTarget(command, context);
    if (rmCriticalTarget) {
      const reason = `危险命令: 递归删除关键路径 ${rmCriticalTarget}`;
      return {
        decision: 'deny',
        reason,
        confidence: 1,
        cached: false,
        traceStep: createTraceStep('permission_classifier', 'B1: resolved_rm_critical_path', 'deny', reason, startTime),
      };
    }

    const sensitiveTarget = credentialReadTarget(command, context);
    if (sensitiveTarget) {
      const reason = `读取凭据路径需要用户确认: ${sensitiveTarget}`;
      return {
        decision: 'ask',
        reason,
        confidence: 1,
        cached: false,
        traceStep: createTraceStep('permission_classifier', 'B1: sensitive_credential_read', 'ask', reason, startTime),
        trustBoundary: true,
      };
    }

    const gitReason = gitMutationReason(command);
    if (gitReason) {
      const reason = `${gitReason}，需要用户确认`;
      return {
        decision: 'ask',
        reason,
        confidence: 1,
        cached: false,
        traceStep: createTraceStep('permission_classifier', 'B1: git_remote_or_credential_write', 'ask', reason, startTime),
        trustBoundary: true,
      };
    }

    // B1: 危险模式检测
    for (const { pattern, reason, decision } of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(canonicalCommand)) {
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

    // B2: Bash 安全判据统一由 commandSafety 解析重定向、复合命令与危险参数。
    if (isKnownSafeCommand(command)) {
      return {
        decision: 'approve',
        reason: '安全命令',
        confidence: 0.95,
        cached: false,
      };
    }

    // B3: 包管理器命令可能安装依赖、运行任意 package script 或访问网络，默认 ask。
    // 明确只读/验证类命令已在 B2 白名单列出。
    if (/^(npm|npx|pnpm|yarn)\s/.test(command)) {
      const reason = '包管理器命令可能修改依赖、执行脚本或访问网络';
      return {
        decision: 'ask',
        reason,
        confidence: 0.85,
        cached: false,
        traceStep: createTraceStep('permission_classifier', 'B3: package_manager', 'ask', reason, startTime),
      };
    }

    // B4: cd 命令 → approve
    if (/^cd(?:\s|$)/.test(command)) {
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

  private createUnknownCompoundAsk(segment: string, startTime: number): ClassificationResult {
    const reason = `复合命令包含需确认段: ${segment}`;
    return {
      decision: 'ask',
      reason,
      confidence: 1.0,
      cached: false,
      traceStep: createTraceStep('permission_classifier', 'B4: compound_unknown', 'ask', reason, startTime),
    };
  }

  /**
   * 文件写入分类 — 按目标路径判断
   */
  private classifyFileWrite(
    toolName: string,
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

    const candidate = path.resolve(context.workingDirectory, filePath);
    const resolved = resolveCanonicalRunPath(candidate);
    if (!context.workspaceRoot) {
      const reason = `写入项目目录外: ${resolved}`;
      return {
        decision: 'ask',
        reason,
        hostReason: createHostReason(
          HostReasonCode.PermissionFileOutsideWorkspaceConfirmationRequired,
          reason,
          { toolName, path: resolved },
        ),
        confidence: 0.9,
        cached: false,
        traceStep: createTraceStep('permission_classifier', 'W3: outside_project', 'ask', reason, startTime),
        trustBoundary: true,
      };
    }

    const workspaceBoundary = path.resolve(context.workspaceRoot);
    const workspace = resolveCanonicalRunPath(workspaceBoundary);
    const canonicalInsideWorkspace = isPathInside(resolved, workspace);

    // W1: 写入项目目录内 → approve (no traceStep)
    if (canonicalInsideWorkspace) {
      return {
        decision: 'approve',
        reason: '写入项目目录内',
        confidence: 0.95,
        cached: false,
      };
    }

    // A path that appears to stay inside the workspace but resolves through a
    // symlink to an external target is an authorization-boundary escape. Check
    // it before the temporary-directory allowlist so a link into /tmp cannot
    // turn an external write into an implicit approval.
    if (isPathInside(candidate, workspaceBoundary)) {
      const reason = `写入项目目录外: ${resolved}`;
      return {
        decision: 'ask',
        reason,
        hostReason: createHostReason(
          HostReasonCode.PermissionFileOutsideWorkspaceConfirmationRequired,
          reason,
          { toolName, path: resolved },
        ),
        confidence: 0.9,
        cached: false,
        traceStep: createTraceStep('permission_classifier', 'W3: outside_project', 'ask', reason, startTime),
        trustBoundary: true,
      };
    }

    // W2: 写入临时目录 → approve (no traceStep)
    const tmpRoot = resolveCanonicalRunPath(os.tmpdir());
    if (
      isPathWithinRoot(resolved, tmpRoot) ||
      (process.platform !== 'win32' && isPathWithinRoot(resolved, '/tmp'))
    ) {
      return {
        decision: 'approve',
        reason: '写入临时目录',
        confidence: 0.95,
        cached: false,
      };
    }

    // W3: 写入项目目录外 → ask
    const reason = `写入项目目录外: ${resolved}`;
    return {
      decision: 'ask',
      reason,
      hostReason: createHostReason(
        HostReasonCode.PermissionFileOutsideWorkspaceConfirmationRequired,
        reason,
        { toolName, path: resolved },
      ),
      confidence: 0.9,
      cached: false,
      traceStep: createTraceStep('permission_classifier', 'W3: outside_project', 'ask', reason, startTime),
      trustBoundary: true,
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

  private buildCacheKey(
    toolName: string,
    args: Record<string, unknown>,
    context: ClassificationContext,
  ): string {
    const workspaceNamespace = context.workspaceRoot
      ? resolveCanonicalRunPath(path.resolve(context.workspaceRoot))
      : '<no-authoritative-workspace>';
    const namespace = [
      workspaceNamespace,
      resolveCanonicalRunPath(path.resolve(context.workingDirectory)),
    ].join('\u0000');
    if (isBashToolName(toolName)) {
      // Bash 命令：使用完整归一化命令。只取前缀会把 `npm run test` 和 `npm run postinstall`
      // 合并成一个缓存项，进而复用错误的权限判断。
      const command = (args.command as string) || '';
      const normalized = command.trim().replace(/\s+/g, ' ');
      return crypto.createHash('md5').update(`${namespace}:bash:${normalized}`).digest('hex');
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
      // Credential decisions are file-specific: README.md and .env in the same
      // directory must never share an approval cache entry.
      return crypto.createHash('md5').update(
        `${namespace}:${normalizeToolName(toolName)}:${JSON.stringify(args)}`,
      ).digest('hex');
    }

    // 其他工具：标准化参数后 hash
    const argsPattern = this.normalizeArgs(args);
    return crypto.createHash('md5').update(
      `${namespace}:${normalizeToolName(toolName)}:${JSON.stringify(argsPattern)}`,
    ).digest('hex');
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
  context: ClassificationContext,
): Promise<ClassificationResult> {
  return getPermissionClassifier().classify(toolName, args, context);
}
