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
import { createHostReason, HostReasonCode, type HostReasonPayload } from '../../shared/contract/permission';
import { createTraceStep } from '../security/decisionTraceBuilder';
import {
  isKnownSafeCommand,
  lenientCompoundSegments, splitCompoundCommand,
} from '../security/commandSafety';
import { canonicalizeCommand } from '../security/canonicalizeCommand';
import {
  parseShellCommand, type SegmentTerminator,
} from '../security/commandParse';
import { RM_FLAGS_REQUIRED, RM_HEAD } from '../security/rmFlagPattern';
import { checkCommandPolicy } from './modules/shell/commandPolicy';
import { inspectPermissionCommand, neverApprove } from './permissionCommandParse';
import {
  FENCED_IN_PROJECT_WRITE_REASON,
  enforceWriteFenceObligation,
  fencedWriteSkipConfirm, isFencedInProjectWriteEligible,
} from '../sandbox/writeFence';
import { isBashToolName, normalizeToolName } from './toolNames';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { isPathWithinRoot } from '../runtime/workspaceScope';
import { connectorWriteAskClassification } from './connectorTokenWrite';
import { isProtectedWritePath, isSensitiveCredentialPath } from '../sandbox/sensitivePaths';
import { resolvedRmCriticalTarget } from '../security/recursiveRmPathSafety';
import type { JevSystemOneCall } from '../../shared/constants/jevQuestions';
import { classifyByJev, isPermissionLlmClassifierEnabled } from './permissionClassifierJev';
import { createProductionJevCall } from '../model/jevFeatures';
import {
  CANONICAL_HOME_DIR, bashCommandRequiresPermission, contextAfterCdSegment, credentialReadTarget,
  ddCopiesWorkspaceFile, gitMutationReason, hasPositiveAllowCandidate, isNpmPublishDryRun, isPathInside, isSensitiveMemoryPath, readPathCandidates,
  recursivelyRemovesPath, resolveCandidatePath,
} from './permissionClassifierShell';

export { bashCommandRequiresPermission };

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
  /** The classifier asked because no rule could determine the command risk. */
  riskUnknown?: boolean;
  /** Do not store this result in the command-text cache (fenced in-project writes; Jev non-Bash approvals). */
  bypassCache?: boolean;
  /** Skip-confirm approve must wrap the command in the OS write fence. Bash consumes this. */
  requiresOsWriteFence?: boolean;
  /** Canonical workspace root the classifier used for the in-zone check; bash's only fence root. */
  writeFenceWorkspaceRoot?: string;
}

function classificationHostReason(result: ClassificationResult, toolName: string): ClassificationResult {
  if (result.hostReason) return result;
  const code = result.decision === 'approve'
    ? HostReasonCode.PermissionClassifierAllowed
    : result.decision === 'deny'
      ? HostReasonCode.PermissionClassifierDenied
      : HostReasonCode.PermissionClassifierConfirmationRequired;
  return {
    ...result, hostReason: createHostReason(code, result.reason, { toolName }),
  };
}

export interface ClassifierConfig {
  /** Enable LLM-based classification（默认读 CODE_AGENT_PERMISSION_LLM_CLASSIFIER，N-JEV-DEFAULT-ON 起默认开） */
  enableLlm?: boolean;
  /** Confidence threshold for auto-approve (default: 0.8) */
  confidenceThreshold?: number;
  /** Cache TTL in ms (default: 5 min) */
  cacheTtlMs?: number;
  /** Jev systemOne 注入点（测试/回放用替身）。生产缺省走 createProductionJevCall；别 mock 网络——桩的是函数。 */
  jevSystemOne?: JevSystemOneCall;
}

export interface ClassificationContext {
  /** Base directory for resolving relative tool paths. */
  workingDirectory: string;
  /** Authoritative write boundary. Absent means no write target is inside a workspace. */
  workspaceRoot?: string;
  permissionLevel?: string;
  /** Per-classification cache only; never survives symlink or filesystem changes. */
  pathResolutionCache?: Map<string, string>;
  /** True when workingDirectory is this tool call's real cwd. Auto-mode process.cwd() re-run must omit it. */
  workingDirectoryFromToolCall?: boolean;
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
  'read_file', 'Read', 'glob', 'Glob',
  'grep', 'Grep', 'list_directory', 'ListDirectory',
  'search_files', 'SearchFiles', 'ToolSearch',
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
  { pattern: /\bdd\b[^;&|\n]*\bof=\/dev\//, reason: 'dd 写入设备', decision: 'deny' },
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
  // 表格卡第二张工作表走 DocEdit（file_path）。它不在 Jev 扩桶里，规则落空就
  // 一律 ask；无工作区的新会话没有人点批准。与 Edit 同一条路径判据：工作区内放行，
  // 区外和受保护路径仍 ask。
  'DocEdit',
  // Office 一轮文件交付的原生生成器（output_path）。不进写入桶就落到 LLM 分类器
  // 兜底 → ask，无头新会话没人点批准（r4 实测 docx_generate 卡审批 34s 后整轮取消）。
  // 产物路径判据与 Edit 一致：工作区内放行，区外/受保护路径仍 ask。
  'docx_generate',
  'excel_generate',
]);

// 生成器类写入工具的路径是可选参数：缺省时产物落在会话工作目录（resolveInputPath
// 对 fileName 的行为），按 workingDirectory 本身参与边界判断即可。
const GENERATOR_WRITE_TOOLS = new Set(['docx_generate', 'excel_generate']);

export function readArgumentsRequirePermission(
  toolName: string,
  args: Record<string, unknown>,
  context: Pick<ClassificationContext, 'workingDirectory' | 'workspaceRoot'>,
): boolean {
  if (!READ_ONLY_TOOLS.has(toolName)) return false;
  try {
    const classificationContext: ClassificationContext = { ...context, pathResolutionCache: new Map() };
    return readPathCandidates(toolName, args).some((candidate) => {
      const resolved = resolveCandidatePath(
        candidate,
        context.workingDirectory,
        classificationContext.pathResolutionCache,
      );
      return isSensitiveCredentialPath(resolved, {
        homeDir: CANONICAL_HOME_DIR,
        projectRoot: resolveCanonicalRunPath(context.workspaceRoot ?? context.workingDirectory),
      });
    });
  } catch {
    return true;
  }
}

function outsideProjectWriteAsk(
  toolName: string,
  resolved: string,
  startTime: number,
): ClassificationResult {
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

function protectedWriteAsk(
  toolName: string,
  resolved: string,
  startTime: number,
): ClassificationResult {
  const reason = `protected write path requires confirmation: ${resolved}`;
  return {
    decision: 'ask',
    reason,
    hostReason: createHostReason(
      HostReasonCode.PermissionPolicyConfirmationRequired,
      reason,
      { toolName, path: resolved },
    ),
    confidence: 1,
    cached: false,
    traceStep: createTraceStep('permission_classifier', 'W0: protected_write_path', 'ask', reason, startTime),
    trustBoundary: true,
  };
}

// ----------------------------------------------------------------------------
// PermissionClassifier
// ----------------------------------------------------------------------------

export class PermissionClassifier {
  private config: Required<Omit<ClassifierConfig, 'jevSystemOne'>>;
  private jevSystemOne: JevSystemOneCall;
  private cache = new Map<string, CacheEntry>();

  constructor(config?: ClassifierConfig) {
    this.config = {
      enableLlm: config?.enableLlm ?? isPermissionLlmClassifierEnabled(),
      confidenceThreshold: config?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      cacheTtlMs: config?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    };
    this.jevSystemOne = config?.jevSystemOne ?? createProductionJevCall('permissionClassifier');
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
    const classificationContext: ClassificationContext = {
      ...context,
      pathResolutionCache: new Map(),
    };
    let ruleResult: ClassificationResult | null;
    try {
      ruleResult = this.classifyByRules(toolName, args, classificationContext, startTime);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const reason = `路径安全分析失败，已拒绝执行: ${detail}`;
      ruleResult = { decision: 'deny', reason, confidence: 1, cached: false,
        errorCode: 'PERMISSION_PATH_ANALYSIS_FAILED',
        traceStep: createTraceStep('permission_classifier', 'B0: path_analysis_failed', 'deny', reason, startTime) };
    }
    if (ruleResult) {
      const structured = classificationHostReason(enforceWriteFenceObligation(ruleResult), toolName);
      this.setCache(cacheKey, structured);
      return structured;
    }

    // 3. LLM classifier（规则无法判断时）
    if (this.config.enableLlm) {
      const llmResult = await classifyByJev(toolName, args, context, this.jevSystemOne, startTime);
      if (llmResult && llmResult.confidence >= this.config.confidenceThreshold) {
        // 与规则 approve 同一道后处理：写围栏义务不过关的 approve 一律降级 ask。
        const structured = classificationHostReason(enforceWriteFenceObligation(llmResult), toolName);
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
      riskUnknown: true,
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

    // C1/C1b: 连接器写回与 http_request 令牌写都以用户已连接应用的身份在外部系统
    // 产生真实副作用，必须确定性逐次确认（判据与文案见 connectorTokenWrite.ts，
    // 先于一切 approve 规则与 LLM 档）。
    const connectorWriteAsk = connectorWriteAskClassification(toolName, args, context.permissionLevel, startTime);
    if (connectorWriteAsk) return connectorWriteAsk;

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

    // R6: 文件写入工具 — 按路径判断。
    // 生成器只在有权威工作区（新会话首轮起就有 project root）时走确定性写围栏；
    // 无工作区场景维持既有 Jev 语境判定，不改变后台 run 的审批语义（jev R4 契约）。
    if (WRITE_TOOLS.has(toolName)
      && (context.workspaceRoot || !GENERATOR_WRITE_TOOLS.has(toolName))) {
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

    const candidates = readPathCandidates(toolName, args);

    for (const candidate of candidates) {
      const resolved = resolveCandidatePath(candidate, context.workingDirectory, context.pathResolutionCache);
      if (isSensitiveCredentialPath(resolved, {
        homeDir: CANONICAL_HOME_DIR,
        projectRoot: resolveCanonicalRunPath(context.workspaceRoot ?? context.workingDirectory),
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
        confidence: 1.0, cached: false,
      };
    }

    // Reverse mutation: drop isOsWriteFenceAvailable() ⇒ symlink/TOCTOU writes escape.
    // Reverse mutation: drop workingDirectoryFromToolCall ⇒ CLI auto-mode process.cwd()
    // re-run auto-approves a relative write while bash executes in the tool's outside cwd.
    // Reverse mutation: drop requiresOsWriteFence / writeFenceWorkspaceRoot ⇒ bash
    // no longer wraps skip-confirm writes.
    // Eligibility rejects quoted redirect targets (`> "file"`); quoted tee operands
    // still parse. Reuse the original command for the deny probe, not a reconstructed segment.
    const fence = isFencedInProjectWriteEligible(command, context) ? fencedWriteSkipConfirm(context) : undefined;
    const fenceProbe = fence ? this.classifyBashSegment(command, context, startTime) : undefined;
    if (fence && fenceProbe?.decision !== 'deny') return {
      decision: 'approve', reason: FENCED_IN_PROJECT_WRITE_REASON, confidence: 0.95, cached: false, bypassCache: true,
      requiresOsWriteFence: true, writeFenceWorkspaceRoot: fence.workspaceRoot };

    // The shared parser reconstructs each segment with shell-safe quoting, so text
    // arguments remain one word while policy checks still consume canonical text.
    const rawTrimmed = command.trim();
    const rawInspection = inspectPermissionCommand(rawTrimmed, startTime);
    const segments = splitCompoundCommand(rawTrimmed);
    if (!segments || segments.length === 0) {
      // Failing to split is not evidence of safety: a null here hands the command to the caller's
      // fallback ask and silently downgrades a dangerous-command deny (round 7 / round 13 shape).
      // Let the deny rules read the whole command first; anything short of deny still falls through.
      const whole = neverApprove(this.classifyBashSegment(rawTrimmed, context, startTime));
      // 第 42 轮（结构性收口）：解析失败不再清空段视图——与 lenientCommandWords 同一立场，抬到段级。
      // lenient 段照走 cd 的 cwd 推进；只有走查出 deny 才盖过整串扫描（heredoc 后 `cd / && …; rm -rf usr`
      // 在原 cwd 下够不着关键路径），walked 的 approve 出不去（neverApprove），整串扫描已拿到的 ask
      // 及其理由（round 33 heredoc 凭据）原样保留。
      const lenient = lenientCompoundSegments(rawTrimmed);
      if (!lenient) return whole;
      const walked = neverApprove(this.classifySegmentWalk(
        lenient.segments, lenient.terminators, rawInspection.outputRedirectionAsk, context, startTime));
      return walked?.decision === 'deny' ? walked : whole ?? walked;
    }

    if (segments.length === 1) {
      // A segment's deny or specific ask outranks the generic redirection ask; only an approve yields.
      const result = fenceProbe ?? this.classifyBashSegment(segments[0], context, startTime);
      return neverApprove(result) ?? rawInspection.outputRedirectionAsk ?? result;
    }

    // 沿用 #1609 的逐段风险分类，同时把 cd 的 cwd 影响传给后续段的路径解析。
    // 不改变 cd 自身或未知段的判决，只修正后续 rm/凭据相对路径的解析基准。
    // splitCompoundCommand rebuilds these one-for-one from the same parse's segments.
    const terminators = parseShellCommand(rawTrimmed).segments.map((segment) => segment.terminator);
    return this.classifySegmentWalk(segments, terminators, rawInspection.outputRedirectionAsk, context, startTime);
  }

  /** 严格段视图与 lenient 段视图共用的逐段走查：cd 段推进 cwd，可执行段逐段分类，deny 短路；
   *  全 cd 时看重定向 ask，否则批准 cd。结果可能含 approve，两条调用路径各自负责 neverApprove。 */
  private classifySegmentWalk(segments: string[], terminators: SegmentTerminator[],
    redirectAsk: ClassificationResult | null | undefined, context: ClassificationContext, startTime: number,
  ): ClassificationResult | null {
    let strictest: ClassificationResult | null = redirectAsk ?? null;
    let segmentContext = context;
    let executableSegmentCount = 0;
    for (const [index, segment] of segments.entries()) {
      const advancedContext = contextAfterCdSegment(segment, segmentContext, terminators, index);
      if (advancedContext) { segmentContext = advancedContext; continue; }
      executableSegmentCount += 1;
      const result = this.classifyBashSegment(segment, segmentContext, startTime)
        ?? this.createUnknownCompoundAsk(segment, startTime);
      if (result.decision === 'deny') return result;
      if (!strictest || result.decision === 'ask') strictest = result;
    }

    if (executableSegmentCount === 0) {
      return redirectAsk ?? { decision: 'approve', reason: 'cd 命令', confidence: 1.0, cached: false };
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
    const commandInspection = inspectPermissionCommand(command, startTime);
    // Deliberately not returned here. Round 7 fixed exactly this shape for outputRedirectionAsk:
    // an early ask hides the dangerous-command deny below, so `chronic bash -c 'chmod -R 777 …'`
    // would drop from a hard refusal to something a user can approve. Hold it until every deny
    // has had its say, and still refuse before any approve path.

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

    const sensitiveTarget = credentialReadTarget(command, context);
    if (sensitiveTarget) {
      const sensitiveDelete = recursivelyRemovesPath(command);
      const reason = sensitiveDelete
        ? `危险命令: 递归删除凭据路径 ${sensitiveTarget}`
        : `读取凭据路径需要用户确认: ${sensitiveTarget}`;
      return {
        decision: sensitiveDelete ? 'deny' : 'ask',
        reason,
        confidence: 1,
        cached: false,
        traceStep: createTraceStep(
          'permission_classifier',
          sensitiveDelete ? 'B1: sensitive_credential_delete' : 'B1: sensitive_credential_read',
          sensitiveDelete ? 'deny' : 'ask',
          reason,
          startTime,
        ),
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

    // Every deny has been considered by now; an unparsable command must never reach an approve.
    if (commandInspection.parseFailureAsk) return commandInspection.parseFailureAsk;

    // B1: 未限定 shell 身份（./bash、--rcfile、-ic 等以解释器为程序）是信任边界 ask——
    // 判官（Jev 档）说放行也必须回到用户确认（N-JEV-DEFAULT-ON-CONSENT ①）。
    if (commandInspection.untrustedShellIdentityAsk) return commandInspection.untrustedShellIdentityAsk;

    // Product-level allow only. This deliberately does not enter the execution
    // safe-command whitelist because npm lifecycle scripts still run in dry-run.
    if (isNpmPublishDryRun(command)) {
      return {
        decision: 'approve',
        reason: 'npm publish dry-run 预览',
        confidence: 0.95,
        cached: false,
      };
    }

    // B2: Bash 安全判据统一由 commandSafety 解析重定向、复合命令与危险参数。
    if ((!hasPositiveAllowCandidate(command) && isKnownSafeCommand(command))
      || ddCopiesWorkspaceFile(command, context)) {
      return {
        decision: 'approve',
        reason: '安全命令',
        confidence: 0.95,
        cached: false,
      };
    }

    // B3: 包管理器命令可能安装依赖、运行任意 package script 或访问网络，默认 ask。
    // 明确只读/验证类命令已在 B2 白名单列出。
    if (commandInspection.packageManager) {
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
    if (commandInspection.changeDirectory) {
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
      riskUnknown: true,
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
    const filePath = (args.file_path as string) || (args.path as string) || (args.output_path as string)
      || (GENERATOR_WRITE_TOOLS.has(toolName) ? '.' : undefined);
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
    const workspaceBoundary = context.workspaceRoot
      ? path.resolve(context.workspaceRoot)
      : undefined;
    const workspace = workspaceBoundary
      ? resolveCanonicalRunPath(workspaceBoundary)
      : undefined;
    if (isProtectedWritePath(resolved, { homeDir: CANONICAL_HOME_DIR, projectRoot: workspace })) {
      return protectedWriteAsk(toolName, resolved, startTime);
    }
    if (!workspaceBoundary || !workspace) return outsideProjectWriteAsk(toolName, resolved, startTime);
    if (isPathInside(resolved, workspace)) {
      return { decision: 'approve', reason: '写入项目目录内', confidence: 0.95, cached: false };
    }
    // Symlink that looks in-workspace but resolves outside is a boundary escape;
    // check before the /tmp allowlist so a link into /tmp cannot become implicit approval.
    if (isPathInside(candidate, workspaceBoundary)) return outsideProjectWriteAsk(toolName, resolved, startTime);
    const tmpRoot = resolveCanonicalRunPath(os.tmpdir());
    if (
      isPathWithinRoot(resolved, tmpRoot)
      || (process.platform !== 'win32' && isPathWithinRoot(resolved, '/tmp'))
    ) {
      return { decision: 'approve', reason: '写入临时目录', confidence: 0.95, cached: false };
    }
    return outsideProjectWriteAsk(toolName, resolved, startTime);
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
    if (result.bypassCache) return;
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
