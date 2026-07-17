import type { ToolCall } from '@shared/contract';
import type { ToolStatus } from '../components/features/chat/MessageBubble/ToolCallDisplay/styles';
import type { ToolCapabilitySource } from '../types/runWorkbench';
import type { Translations } from '../i18n';

export type ToolPermissionView =
  | 'read'
  | 'write'
  | 'shell'
  | 'network'
  | 'desktop'
  | 'memory'
  | 'mcp'
  | 'unknown';

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

/** 分类结果（无文案，纯逻辑）——humanizeToolError 在此基础上补 t 驱动的文案。 */
interface ToolErrorClassification {
  kind: ToolErrorKind;
  action?: ToolErrorAction;
  settingsHint?: boolean;
  escalate?: boolean;
  /** 仅 quota 类命中具体搜索源时填充 */
  sources?: string[];
}

/**
 * 识别工具报错属于哪一类（额度/限流/鉴权/过载/超时/网络/自动加载重试），不产出文案。
 * 识别不了的返回 null。判定与文案分离：isEscalatedToolError 只需要 escalate 位，
 * 不该为了读一个布尔值被迫牵进 Translations。
 *
 * 判别顺序有意为之：**额度/余额排最前**——上游常把额度错误裹成「HTTP 401: insufficient_quota」，
 * 若 auth(401) 在前会误判成鉴权。auth 不收 `permission denied`（避免误伤 Bash 文件权限错误）。
 */
function classifyToolError(error: string): ToolErrorClassification | null {
  const lower = error.toLowerCase();

  // 1. 额度/余额/欠费（最先）：搜索源 quota、exa credits、insufficient balance、402、欠费等
  if (/quota|insufficient_quota|no_more_credits|credits?\b|usage limit|billing|exceeded your|insufficient[_ ]?balance|余额不足|欠费|arrearage|payment required|\b402\b/i.test(error)) {
    const sources = ['perplexity', 'exa', 'tavily', 'brave', 'serper', 'bing', 'openai']
      .filter((s) => lower.includes(s));
    return {
      kind: 'quota',
      action: 'settings',
      settingsHint: true,
      escalate: true,
      sources: sources.length ? sources : undefined,
    };
  }

  // 2. 限流 429
  if (/\b429\b|too many requests|rate.?limit|requests per minute|rate exceeded/i.test(error)) {
    return { kind: 'rate_limit', action: 'retry', escalate: true };
  }

  // 3. 鉴权 401/403（不收 permission denied，避免误伤 shell/文件权限错误）
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid[_ ]?api[_ ]?key|invalid token|authentication failed|authentication error/i.test(error)) {
    return { kind: 'auth', action: 'settings', settingsHint: true, escalate: true };
  }

  // 4. 过载 / 网关（含 504 gateway timeout，排在超时前）
  if (/\b50[234]\b|overloaded|capacity|service unavailable|bad gateway|gateway timeout|server is busy|temporarily unavailable/i.test(error)) {
    return { kind: 'overloaded', action: 'retry' };
  }

  // 5. 超时
  if (/timeout|timed out|etimedout|inactivity timeout|deadline exceeded/i.test(error)) {
    return { kind: 'timeout', action: 'retry' };
  }

  // 6. 网络连接异常
  if (/econnreset|econnrefused|enotfound|eai_again|socket hang up|socket disconnected|network error|network request failed|fetch failed/i.test(error)) {
    return { kind: 'network', action: 'retry' };
  }

  // 7. 工具自动加载重试（villain 修复后一般不会走到这，留作防御）
  if (lower.includes('auto-loaded')) {
    return { kind: 'auto_loaded' };
  }

  return null;
}

/**
 * 把工具的原始报错翻成人话 + 可操作提示。识别不了的返回 null（让调用方退回原始展示）。
 * 目标：报错说人话、可操作，而不是把 HTTP 401/402/429/503 + JSON 糊用户一脸。
 */
export function humanizeToolError(error: string | undefined, _toolName: string | undefined, t: Translations): HumanizedToolError | null {
  if (!error?.trim()) return null;
  const classification = classifyToolError(error);
  if (!classification) return null;
  const { kind, action, settingsHint, escalate, sources } = classification;

  switch (kind) {
    case 'quota':
      if (sources?.length) {
        return {
          summary: t.toolErrors.quota.sourcesSummary.replace('{sources}', sources.join(' / ')),
          detail: t.toolErrors.quota.sourcesDetail,
          settingsHint,
          kind,
          action,
          escalate,
        };
      }
      return { summary: t.toolErrors.quota.summary, detail: t.toolErrors.quota.detail, settingsHint, kind, action, escalate };
    case 'rate_limit':
      return { summary: t.toolErrors.rateLimit.summary, detail: t.toolErrors.rateLimit.detail, kind, action, escalate };
    case 'auth':
      return { summary: t.toolErrors.auth.summary, detail: t.toolErrors.auth.detail, settingsHint, kind, action, escalate };
    case 'overloaded':
      return { summary: t.toolErrors.overloaded.summary, detail: t.toolErrors.overloaded.detail, kind, action };
    case 'timeout':
      return { summary: t.toolErrors.timeout.summary, detail: t.toolErrors.timeout.detail, kind, action };
    case 'network':
      return { summary: t.toolErrors.network.summary, detail: t.toolErrors.network.detail, kind, action };
    case 'auto_loaded':
      return { summary: t.toolErrors.autoLoaded.summary, kind };
  }
}

/**
 * 判断一次工具失败是否需要用户介入（额度耗尽 / 鉴权失效 / 限流），而非 agent
 * 探索过程中的良性试错（工具未安装、非零退出码、超时、网络抖动等）。
 * 未被分类的错误一律按探索性失败处理——宁可保守安静，因为 agent 最终会在
 * 回复里说清楚结果，不需要每次试错都喊给用户看。只读 escalate 位，不涉及
 * 文案，故不需要 Translations。
 */
export function isEscalatedToolError(toolCall: Pick<ToolCall, 'result'>): boolean {
  const result = toolCall.result;
  if (result?.success !== false) return false;
  const errorText = result.error || (typeof result.output === 'string' ? result.output : '');
  if (!errorText?.trim()) return false;
  return classifyToolError(errorText)?.escalate === true;
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

export function getToolRecoveryHint(toolCall: ToolCall, status: ToolStatus, t: Translations): string {
  const hint = t.toolRecoveryHint;
  if (status === 'pending') return hint.pending;
  if (status === 'interrupted') return hint.interrupted;
  if (status === 'error') {
    if (toolCall.expectedOutcome) return hint.errorWithOutcome.replace('{outcome}', toolCall.expectedOutcome);
    return hint.errorGeneric;
  }
  if (toolCall.result?.outputPath) return hint.outputRecorded;
  return hint.resultRecorded;
}
