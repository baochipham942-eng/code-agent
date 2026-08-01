// ============================================================================
// AgentErrorCard - 会话区运行失败卡片
// ============================================================================
// 数据来自 message.metadata.agentError（classifyAgentError 在 error 事件时写入）。
// 布局对照 WorkBuddy ErrorBanner：标题行（⚠ + 发生了什么）→ 建议行 → 详情行
// （错误码/HTTP/Trace ID，有才显示）→ 操作行。动作按 category 显隐：
// 重试=全部；切换模型=模型类错误；新开会话=context_length/generic；复制报告=全部。
// 文案不持久化（metadata 只存 category + 排障字段），这里按 category 查 i18n 表。
// ============================================================================

import React, { useCallback } from 'react';
import { AlertTriangle, Copy, KeyRound, MessageSquarePlus, RotateCcw, SwitchCamera } from 'lucide-react';
import type { AgentErrorCategory, AgentErrorMetadata } from '@shared/contract';
import { useI18n } from '../../../hooks/useI18n';
import type { Translations } from '../../../i18n';
import { toast } from '../../../hooks/useToast';
import { useAppStore } from '../../../stores/appStore';
import { useMessageActionStore } from '../../../stores/messageActionStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { OPEN_MODEL_SWITCHER_EVENT } from '../../StatusBar/ModelSwitcher';

const SWITCH_MODEL_CATEGORIES: ReadonlySet<AgentErrorCategory> = new Set([
  'auth',
  'model_not_found',
  'forbidden',
  'rate_limited',
  'concurrency',
  'network',
]);

const NEW_SESSION_CATEGORIES: ReadonlySet<AgentErrorCategory> = new Set([
  'context_length',
  'generic',
]);

/**
 * 密钥无效 / 额度用尽这一档不给「重试」：重试一万次也是同一个 401，
 * 摆一个按不出结果的按钮只会把人往错误方向引（真机 2026-08-01 反馈）。
 */
const NO_RETRY_CATEGORIES: ReadonlySet<AgentErrorCategory> = new Set(['auth']);

/**
 * 建议正文写着「去检查这个模型的账号配置」，卡片却没有过去的入口——用户只能自己翻设置。
 * 授权类失败给一个直达按钮（Codex 验证 2026-08-01）。落点是设置 → 模型（API Key 的家），
 * 不是能力中心：能力中心管专家/技能/连接器/插件，模型账号不在那儿。
 */
const CHECK_ACCOUNT_CATEGORIES: ReadonlySet<AgentErrorCategory> = new Set(['auth', 'forbidden']);

function shouldShowRetry(category: AgentErrorCategory): boolean {
  return !NO_RETRY_CATEGORIES.has(category);
}

function shouldShowSwitchModel(category: AgentErrorCategory): boolean {
  return SWITCH_MODEL_CATEGORIES.has(category);
}

function shouldShowNewSession(category: AgentErrorCategory): boolean {
  return NEW_SESSION_CATEGORIES.has(category);
}

/** 按 category 查 i18n 文案；context_length 的建议带 token 数模板。 */
export function resolveAgentErrorCopy(
  error: Pick<AgentErrorMetadata, 'category' | 'requestedTokens' | 'maxTokens'>,
  t: Translations,
): { title: string; suggestion: string } {
  const copy = t.agentError.categories[error.category] ?? t.agentError.categories.generic;
  if (error.category !== 'context_length') return copy;
  const requestedK = error.requestedTokens ? Math.round(error.requestedTokens / 1000) : '?';
  const maxK = error.maxTokens ? Math.round(error.maxTokens / 1000) : '?';
  return {
    title: copy.title,
    suggestion: copy.suggestion
      .replace('{requestedK}', String(requestedK))
      .replace('{maxK}', String(maxK)),
  };
}

/** WorkBuddy 式结构化错误报告：friendly 文案 + 排障字段，排障收益主要靠它。 */
export function buildAgentErrorReport(args: {
  error: AgentErrorMetadata;
  title: string;
  suggestion: string;
  sessionId?: string;
  t: Translations;
}): string {
  const { error, title, suggestion, sessionId, t } = args;
  const labels = t.agentError.report;
  const lines: string[] = [
    `## ${labels.title}`,
    `${labels.message}: ${title}`,
    `${labels.suggestion}: ${suggestion}`,
    `${labels.category}: ${error.category}`,
  ];
  if (error.code) lines.push(`${labels.code}: ${error.code}`);
  if (error.httpStatus) lines.push(`${labels.httpStatus}: ${error.httpStatus}`);
  if (error.traceId) lines.push(`${labels.traceId}: ${error.traceId}`);
  if (sessionId) lines.push(`${labels.sessionId}: ${sessionId}`);
  if (error.modelId) {
    lines.push(`${labels.model}: ${error.provider ? `${error.provider} / ${error.modelId}` : error.modelId}`);
  }
  lines.push(`${labels.timestamp}: ${new Date(error.timestamp).toISOString()}`);
  lines.push(`${labels.raw}: ${error.rawMessage}`);
  return lines.join('\n');
}

const ACTION_BUTTON_CLASS =
  'flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/60 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-zinc-800/60 disabled:hover:text-zinc-300';

export const AgentErrorCard: React.FC<{
  error: AgentErrorMetadata;
  /** 所在 assistant 消息 id（重试时据此回找上一条 user 消息） */
  messageId: string;
  sessionId?: string;
}> = ({ error, messageId, sessionId }) => {
  const { t } = useI18n();
  const { title, suggestion } = resolveAgentErrorCopy(error, t);
  // 运行中禁用重试，避免并发重发把正在跑的轮次搞乱
  const isRunning = useSessionStore((s) => (sessionId ? s.runningSessionIds.has(sessionId) : false));

  const handleRetry = useCallback(() => {
    // 复用消息动作的 regenerate 机制：回找这条 assistant 之前的最后一条 user 消息重发
    useMessageActionStore.getState().regenerateMessage(messageId);
  }, [messageId]);

  const handleSwitchModel = useCallback(() => {
    // 打开状态栏 ModelSwitcher（与 MODEL_OVERRIDE_CHANGE_EVENT 同一套 window 事件约定）
    window.dispatchEvent(new CustomEvent(OPEN_MODEL_SWITCHER_EVENT));
  }, []);

  const handleCheckAccount = useCallback(() => {
    useAppStore.getState().openSettingsTab('model');
  }, []);

  const handleNewSession = useCallback(() => {
    void useSessionStore.getState().createSession();
  }, []);

  const handleCopyReport = useCallback(async () => {
    const report = buildAgentErrorReport({ error, title, suggestion, sessionId, t });
    try {
      await navigator.clipboard.writeText(report);
      toast.success(t.agentError.actions.copied);
    } catch {
      toast.error(t.agentError.actions.copyFailed);
    }
  }, [error, title, suggestion, sessionId, t]);

  // 主视图只留「这一轮真跑的是哪个模型」——切过模型之后这是用户最先要确认的事。
  // provider id / 错误码 / HTTP 码 / Trace ID 是排障字段，看不出下一步动作，
  // 收进折叠区，别跟两个有效按钮抢注意力（拍板 2026-08-01「折中方案」）。
  const ranOnModel = error.modelId ? `${t.agentError.details.model} ${error.modelId}` : null;
  const technicalItems: string[] = [];
  if (error.provider) technicalItems.push(`${t.agentError.details.provider} ${error.provider}`);
  if (error.code) technicalItems.push(`${t.agentError.details.code} ${error.code}`);
  if (error.httpStatus) technicalItems.push(`${t.agentError.details.httpStatus} ${error.httpStatus}`);
  if (error.traceId) technicalItems.push(`${t.agentError.details.traceId} ${error.traceId}`);

  return (
    <div
      role="alert"
      aria-label={t.agentError.ariaLabel}
      className="my-1 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-red-300">{title}</div>
          <div className="mt-1 text-[11px] leading-relaxed text-red-300/80">{suggestion}</div>
        </div>
      </div>

      {ranOnModel && (
        <div className="mt-1.5 pl-6 font-mono text-[10px] text-zinc-500">{ranOnModel}</div>
      )}

      {technicalItems.length > 0 && (
        <details className="mt-1 pl-6">
          <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-400">
            {t.agentError.details.technical}
          </summary>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-zinc-500">
            {technicalItems.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </details>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-6">
        {shouldShowRetry(error.category) && (
          <button /* ds-allow:button: 报错卡操作行是紧凑小按钮组，Button primitive 无此紧凑变体 */
            type="button"
            onClick={handleRetry}
            disabled={isRunning}
            title={isRunning ? t.agentError.actions.retryRunning : t.agentError.actions.retry}
            className={ACTION_BUTTON_CLASS}
          >
            <RotateCcw className="h-3 w-3" />
            {t.agentError.actions.retry}
          </button>
        )}
        {shouldShowSwitchModel(error.category) && (
          <button /* ds-allow:button: 报错卡操作行是紧凑小按钮组，Button primitive 无此紧凑变体 */
            type="button"
            onClick={handleSwitchModel}
            className={ACTION_BUTTON_CLASS}
          >
            <SwitchCamera className="h-3 w-3" />
            {t.agentError.actions.switchModel}
          </button>
        )}
        {CHECK_ACCOUNT_CATEGORIES.has(error.category) && (
          <button /* ds-allow:button: 报错卡操作行是紧凑小按钮组，Button primitive 无此紧凑变体 */
            type="button"
            onClick={handleCheckAccount}
            className={ACTION_BUTTON_CLASS}
          >
            <KeyRound className="h-3 w-3" />
            {t.agentError.actions.checkAccount}
          </button>
        )}
        {shouldShowNewSession(error.category) && (
          <button /* ds-allow:button: 报错卡操作行是紧凑小按钮组，Button primitive 无此紧凑变体 */
            type="button"
            onClick={handleNewSession}
            className={ACTION_BUTTON_CLASS}
          >
            <MessageSquarePlus className="h-3 w-3" />
            {t.agentError.actions.newSession}
          </button>
        )}
        <button /* ds-allow:button: 报错卡操作行是紧凑小按钮组，Button primitive 无此紧凑变体 */
          type="button"
          onClick={handleCopyReport}
          className={ACTION_BUTTON_CLASS}
        >
          <Copy className="h-3 w-3" />
          {t.agentError.actions.copyReport}
        </button>
      </div>
    </div>
  );
};
