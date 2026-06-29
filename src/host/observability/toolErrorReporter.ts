// ============================================================================
// Tool Error Reporter — 把"可执行的"工具失败上报到 Sentry（错误通道，ADR-030）
// ============================================================================
//
// 与 Supabase fleet telemetry（分析通道）互补：此通道不依赖运行时活跃登录会话，
// 覆盖 100% 用户（含只用缓存共享 key、长期不保持登录的同事）。
//
// 红线：
//   - 只上报"真正可执行"的基础设施级失败（见 allowlist）。agent 自恢复 / 用户空间的
//     良性错误（文件没找到、edit 不唯一、参数校验失败等）不上报，否则刷爆配额、淹没信号。
//   - 同一 (tool, category) 在窗口内只报一次（去重 = 客户端采样），控配额。
//   - 脱敏复用 scrubString + sentryNode 的 beforeSend(scrubEvent)，永不含源码 / prompt / key / 家目录。
//   - opt-out 由 captureMessage 继承 crashReporting.enabled，关则全程 no-op。
//
// ============================================================================

import os from 'os';
import type { ErrorCategory } from '../../shared/contract/telemetry';
import { classifyError } from '../telemetry/telemetryCollectorInternal';
import { scrubString } from '../../shared/observability/scrubEvent';
import { captureMessage } from './sentryNode';

// 可上报的错误分类：基础设施 / 环境 / 鉴权层面的失败，指向"系统出了问题"。
// agent 试错型 / 用户空间型（file_not_found、edit_not_unique、tool_args_validation、
// path_hallucination、syntax_error、command_failure、permission_denied、http_4xx、unknown）
// 一律不上报。上线后据真实分布迭代（ADR-030 Deferred）。
export const SENTRY_REPORTABLE_ERROR_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'timeout',
  'rate_limit',
  'network_error',
  'http_5xx',
  'auth_failed',
  'dependency_missing',
  'sandbox_denied',
  'context_overflow',
]);

// 同一 (tool, category) 去重窗口：5 分钟内只报一次。
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const recentKeys = new Map<string, number>();

export function shouldReportToolError(category: ErrorCategory): boolean {
  return SENTRY_REPORTABLE_ERROR_CATEGORIES.has(category);
}

export interface ToolErrorReportInput {
  toolName: string;
  error: string;
  sessionId?: string;
  durationMs?: number;
  /** 测试可注入时钟；省略则用 Date.now()。 */
  now?: number;
}

/**
 * 决策并上报一个工具失败到 Sentry。返回是否实际上报（被 allowlist 过滤 / 去重命中则 false）。
 * 永不抛错 —— 上报失败绝不能影响工具执行主链路。
 */
export function reportToolError(input: ToolErrorReportInput): boolean {
  try {
    const category = classifyError(input.error);
    if (!shouldReportToolError(category)) return false;

    const now = input.now ?? Date.now();
    const key = `${input.toolName}:${category}`;
    const last = recentKeys.get(key);
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) return false;
    recentKeys.set(key, now);
    pruneExpired(now);

    const homeDir = os.homedir();
    const tags: Record<string, string> = { tool: input.toolName, errorCategory: category };
    if (input.sessionId) tags.sessionId = input.sessionId;

    captureMessage(`Tool error: ${input.toolName} (${category})`, 'error', {
      tags,
      extra: {
        error: scrubString(input.error, { homeDir }),
        durationMs: input.durationMs,
      },
    });
    return true;
  } catch {
    return false;
  }
}

function pruneExpired(now: number): void {
  for (const [k, t] of recentKeys) {
    if (now - t >= DEDUP_WINDOW_MS) recentKeys.delete(k);
  }
}

/** 仅供测试：清空去重状态。 */
export function __resetToolErrorReporterForTest(): void {
  recentKeys.clear();
}
