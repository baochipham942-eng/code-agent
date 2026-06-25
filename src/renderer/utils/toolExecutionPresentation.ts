import type { ToolCall } from '@shared/contract';
import type { TraceNode } from '@shared/contract/trace';
import type { ToolStatus } from '../components/features/chat/MessageBubble/ToolCallDisplay/styles';
import type { ToolCapabilitySource } from '../types/runWorkbench';

export type ToolPermissionView =
  | 'read'
  | 'write'
  | 'shell'
  | 'network'
  | 'desktop'
  | 'memory'
  | 'mcp'
  | 'unknown';

export interface ToolLoopDecisionSummary {
  action: string;
  reason: string;
  expectedNextAction: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'error';
}

export interface ToolLikeForDecision {
  name: string;
  shortDescription?: string;
  expectedOutcome?: string;
  result?: unknown;
  success?: boolean;
  _streaming?: boolean;
  metadata?: Record<string, unknown> | null;
  /** 同一轮里之后又成功了，这次失败已被恢复，不应触发「工具报错」决策 */
  recovered?: boolean;
}

/**
 * 判定一条工具结果是否「自动加载重试」的良性内部状态（success:false 但不是真失败）。
 * 源头：messageProcessorUnavailableTools.ts —— 工具未加载→自动加载→让模型重试。
 * UI 各消费方据此不当失败处理，避免假失败污染状态/计数/决策 chip。
 */
export function isAutoLoadedRetry(metadata?: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  return metadata.autoLoaded === true || metadata.autoLoadedTools != null;
}

const WRITE_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'edit_file',
  'write_file',
  'apply_patch',
]);

const READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'list_directory',
]);

export function getToolCapabilitySource(toolName: string): ToolCapabilitySource {
  const lower = toolName.toLowerCase();
  if (lower.startsWith('mcp__') || lower.includes('mcp')) return 'mcp';
  if (lower.includes('skill')) return 'skill';
  if (lower.includes('connector') || lower.includes('mail') || lower.includes('calendar')) return 'connector';
  if (lower.includes('computer') || lower.includes('browser')) return 'computer';
  if (lower.includes('memory')) return 'memory';
  return 'builtin';
}

export function getToolPermissionView(toolName: string): ToolPermissionView {
  const lower = toolName.toLowerCase();
  if (WRITE_TOOLS.has(toolName)) return 'write';
  if (READ_TOOLS.has(toolName)) return 'read';
  if (lower === 'bash' || lower.includes('exec') || lower.includes('shell')) return 'shell';
  if (lower.includes('web') || lower.includes('fetch') || lower.includes('search')) return 'network';
  if (lower.includes('computer') || lower.includes('browser')) return 'desktop';
  if (lower.includes('memory')) return 'memory';
  if (lower.startsWith('mcp__') || lower.includes('mcp')) return 'mcp';
  return 'unknown';
}

export function formatToolDuration(duration?: number): string | null {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null;
  if (duration < 1000) return `${Math.round(duration)}ms`;
  const seconds = duration / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

/** 工具错误类别（驱动 banner 升级 + 操作按钮决策，P0 失败去噪）。 */
export type ToolErrorKind =
  | 'quota'        // 额度/余额/欠费耗尽
  | 'rate_limit'   // 429 限流
  | 'auth'         // 401/403 鉴权
  | 'overloaded'   // 502/503/504 过载或网关
  | 'timeout'      // 超时
  | 'network'      // 网络连接异常
  | 'auto_loaded'; // 工具自动加载重试（benign）

/** 建议的主操作（驱动「重试 / 去设置」按钮）。 */
export type ToolErrorAction = 'retry' | 'settings';

export interface HumanizedToolError {
  /** 一行人话摘要，替代满屏原始报错 */
  summary: string;
  /** 补充说明（可选） */
  detail?: string;
  /** 是否提示去「设置 > Service API Keys」换 key */
  settingsHint?: boolean;
  /** 错误类别（供 banner 升级 / 按钮决策） */
  kind?: ToolErrorKind;
  /** 建议的主操作 */
  action?: ToolErrorAction;
  /** 是否应升级成全局 banner（API/额度类致命错误，不挂在单个工具 cell 下，P0 #3） */
  escalate?: boolean;
}

/**
 * 把工具的原始报错翻成人话 + 可操作提示。识别不了的返回 null（让调用方退回原始展示）。
 * 目标：报错说人话、可操作，而不是把 HTTP 401/402/429/503 + JSON 糊用户一脸。
 *
 * 判别顺序有意为之：**额度/余额排最前**——上游常把额度错误裹成「HTTP 401: insufficient_quota」，
 * 若 auth(401) 在前会误判成鉴权。auth 不收 `permission denied`（避免误伤 Bash 文件权限错误）。
 */
export function humanizeToolError(error?: string, _toolName?: string): HumanizedToolError | null {
  if (!error?.trim()) return null;
  const lower = error.toLowerCase();

  // 1. 额度/余额/欠费（最先）：搜索源 quota、exa credits、insufficient balance、402、欠费等
  if (/quota|insufficient_quota|no_more_credits|credits?\b|usage limit|billing|exceeded your|insufficient[_ ]?balance|余额不足|欠费|arrearage|payment required|\b402\b/i.test(error)) {
    const sources = ['perplexity', 'exa', 'tavily', 'brave', 'serper', 'bing', 'openai']
      .filter((s) => lower.includes(s));
    if (sources.length) {
      return {
        summary: `联网搜索额度不足：${sources.join(' / ')} 的 API 套餐用量已耗尽`,
        detail: '要恢复这些源请充值，或换一个还有额度的 key。',
        settingsHint: true,
        kind: 'quota',
        action: 'settings',
        escalate: true,
      };
    }
    return {
      summary: '额度/余额不足：当前服务的用量或余额已耗尽',
      detail: '请充值，或在设置里换一个还有额度的 key。',
      settingsHint: true,
      kind: 'quota',
      action: 'settings',
      escalate: true,
    };
  }

  // 2. 限流 429
  if (/\b429\b|too many requests|rate.?limit|requests per minute|rate exceeded/i.test(error)) {
    return {
      summary: '请求过于频繁，被限流',
      detail: '稍等片刻会自动重试；如持续可降低并发或稍后再试。',
      kind: 'rate_limit',
      action: 'retry',
      escalate: true,
    };
  }

  // 3. 鉴权 401/403（不收 permission denied，避免误伤 shell/文件权限错误）
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid[_ ]?api[_ ]?key|invalid token|authentication failed|authentication error/i.test(error)) {
    return {
      summary: '鉴权失败：API Key 无效或无权限',
      detail: '去「设置 > Service API Keys」检查对应服务的 Key。',
      settingsHint: true,
      kind: 'auth',
      action: 'settings',
      escalate: true,
    };
  }

  // 4. 过载 / 网关（含 504 gateway timeout，排在超时前）
  if (/\b50[234]\b|overloaded|capacity|service unavailable|bad gateway|gateway timeout|server is busy|temporarily unavailable/i.test(error)) {
    return {
      summary: '服务过载或暂时不可用',
      detail: '稍后会自动重试。',
      kind: 'overloaded',
      action: 'retry',
    };
  }

  // 5. 超时
  if (/timeout|timed out|etimedout|inactivity timeout|deadline exceeded/i.test(error)) {
    return {
      summary: '请求超时',
      detail: '稍后重试，或检查网络 / 代理。',
      kind: 'timeout',
      action: 'retry',
    };
  }

  // 6. 网络连接异常
  if (/econnreset|econnrefused|enotfound|eai_again|socket hang up|socket disconnected|network error|network request failed|fetch failed/i.test(error)) {
    return {
      summary: '网络异常，连接失败',
      detail: '检查网络或代理后重试。',
      kind: 'network',
      action: 'retry',
    };
  }

  // 7. 工具自动加载重试（villain 修复后一般不会走到这，留作防御）
  if (lower.includes('auto-loaded')) {
    return { summary: '工具已自动加载，正在用正确参数重试', kind: 'auto_loaded' };
  }

  return null;
}

export interface ToolErrorActionState {
  /** 是否展示通用错误 action 行（仅失败工具结果） */
  show: boolean;
  /** 供「复制错误」用的原始错误文本（含 ANSI，渲染层自行 strip） */
  errorText: string;
  /** 是否可「从此重试」——需要拿到所属消息 id（经 mediaContext 传入） */
  canRetry: boolean;
}

/**
 * 失败工具结果的可点 action 决策：复制错误 + 从此重试。
 * 「从此重试」复用既有 forkFromHere（messageActionStore），与会话页消息级
 * 「从此重试」同一条路径；只在拿得到所属 messageId 时才可点。
 * 注：浏览器/Computer 类失败有自己的只读 recovery actions（BrowserComputerNextStepActions），
 * 由调用方另行 gate，不走这里。
 */
export function buildToolErrorActions(
  toolCall: ToolCall,
  messageId: string | undefined,
): ToolErrorActionState {
  const result = toolCall.result;
  const failed = !!result && result.success === false;
  if (!failed) {
    return { show: false, errorText: '', canRetry: false };
  }
  const errorText = result.error
    || (typeof result.output === 'string' ? result.output : '');
  return {
    show: true,
    errorText,
    canRetry: typeof messageId === 'string' && messageId.length > 0,
  };
}

export function getToolRecoveryHint(toolCall: ToolCall, status: ToolStatus): string {
  if (status === 'pending') return '等待结果';
  if (status === 'interrupted') return '可重新运行';
  if (status === 'error') {
    if (toolCall.expectedOutcome) return `可重试：${toolCall.expectedOutcome}`;
    return '可以重试或换个工具';
  }
  if (toolCall.result?.outputPath) return '产物已记录';
  return '结果已记录';
}

function bestToolReason(tool: ToolLikeForDecision): string {
  return tool.expectedOutcome || tool.shortDescription || tool.name;
}

export function summarizeToolLoopDecision(allTools: ToolLikeForDecision[]): ToolLoopDecisionSummary | null {
  // 自动加载重试 + 已恢复的失败都是良性/已收尾状态，决策判定里完全忽略——否则会被误判成
  // 失败弹「工具报错」，把成功的一轮演成翻车。
  const tools = allTools.filter((tool) => !isAutoLoadedRetry(tool.metadata) && !tool.recovered);
  if (tools.length === 0) return null;

  const failed = tools.find((tool) => tool.success === false);
  if (failed) {
    return {
      action: '工具报错',
      reason: bestToolReason(failed),
      expectedNextAction: '可以重试，或换个工具试试',
      tone: 'error',
    };
  }

  const pending = tools.find((tool) => tool._streaming || tool.result === undefined);
  if (pending) {
    return {
      action: '等待工具返回',
      reason: bestToolReason(pending),
      expectedNextAction: '收到结果后继续汇总或执行下一步',
      tone: 'neutral',
    };
  }

  return {
    action: tools.length > 1 ? `完成 ${tools.length} 个工具调用` : '工具结果已返回',
    reason: bestToolReason(tools[0]),
    expectedNextAction: '把结果并入回复或继续下一步',
    tone: 'success',
  };
}

export function summarizeToolLoopDecisionFromNodes(nodes: TraceNode[]): ToolLoopDecisionSummary | null {
  const tools: ToolLikeForDecision[] = nodes
    .map((node) => node.toolCall)
    .filter((toolCall): toolCall is NonNullable<TraceNode['toolCall']> => Boolean(toolCall))
    .map((toolCall) => ({
      name: toolCall.name,
      shortDescription: toolCall.shortDescription,
      expectedOutcome: toolCall.expectedOutcome,
      result: toolCall.result,
      success: toolCall.success,
      _streaming: toolCall._streaming,
      metadata: toolCall.metadata,
      recovered: toolCall.recovered,
    }));

  return summarizeToolLoopDecision(tools);
}
