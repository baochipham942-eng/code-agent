// ============================================================================
// AgentErrorCard - 会话区运行失败卡片
// ============================================================================
// 数据来自 message.metadata.agentError（classifyAgentError 在 error 事件时写入）。
// 视觉真源：role-wake-prototype-v2.html 屏三——中性面（bg-void + border-strong）、
// 只有图标着 status-error、标题 14px / 正文 13px、安静描边按钮。
// 连续同因失败折叠（N-UI-AGENT-ERROR-REPEAT-COLLAPSE）：run.latest=false 的失败轮
// 压成一行灰字「没有回复 · 原因」，只有段内最新一轮渲染整卡，runLength≥2 时整卡
// 附带「连续 N 次」说明。run 由投影层渲染期推导（TraceNode.agentErrorRun），不落库。
// 动作按 category 显隐：重试=可恢复错误；切换模型=模型类错误；
// 新开会话=context_length/image_payload/generic；复制报告与技术详情=仅开发者模式。
// rate_limited 由 AgentErrorPresentation 降为时间线灰字行。
// 文案不持久化（metadata 只存 category + 排障字段），这里按 category 查 i18n 表。
// ============================================================================

import React, { useCallback } from 'react';
import { AlertTriangle, Copy, KeyRound, MessageSquarePlus, RotateCcw, SwitchCamera } from 'lucide-react';
import type { AgentErrorCategory, AgentErrorMetadata } from '@shared/contract';
import type { AgentErrorRunInfo } from '@shared/contract/trace';
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
  'usage_limit',
  'concurrency',
  'network',
]);

const NEW_SESSION_CATEGORIES: ReadonlySet<AgentErrorCategory> = new Set([
  'context_length',
  'image_payload',
  'generic',
]);

/**
 * 密钥无效、额度用尽、图片请求超限都不给「重试」：原样重发不会改变结果，
 * 摆一个按不出结果的按钮只会把人往错误方向引。
 */
const NO_RETRY_CATEGORIES: ReadonlySet<AgentErrorCategory> = new Set([
  'auth',
  'insufficient_balance',
  'usage_limit',
  'image_payload',
]);

/**
 * 建议正文写着「去检查这个模型的账号配置」，卡片却没有过去的入口——用户只能自己翻设置。
 * 授权类失败给一个直达按钮（Codex 验证 2026-08-01）。落点是设置 → 模型（API Key 的家），
 * 不是能力中心：能力中心管专家/技能/连接器/插件，模型账号不在那儿。
 */
const CHECK_ACCOUNT_CATEGORIES: ReadonlySet<AgentErrorCategory> = new Set([
  'auth',
  'insufficient_balance',
  'forbidden',
]);

/** 首次醒来卡 failed 态复用同一份「账号类错误」判据（RoleFirstWakeCard 换模型/查账号按钮）。 */
export const WAKE_CARD_CHECK_ACCOUNT_CATEGORIES: ReadonlySet<AgentErrorCategory> = CHECK_ACCOUNT_CATEGORIES;

// interrupted 留在这四组之外：回复前被停掉时仍给重试，不换模型、不查账号、不开新会话。

function shouldShowRetry(category: AgentErrorCategory): boolean {
  return !NO_RETRY_CATEGORIES.has(category);
}

function shouldShowSwitchModel(category: AgentErrorCategory): boolean {
  return SWITCH_MODEL_CATEGORIES.has(category);
}

function shouldShowNewSession(category: AgentErrorCategory): boolean {
  return NEW_SESSION_CATEGORIES.has(category);
}

function buildTechnicalItems(
  error: AgentErrorMetadata,
  t: Translations,
  includeModel: boolean,
): string[] {
  const items: string[] = [];
  if (includeModel && error.modelId) items.push(`${t.agentError.details.model} ${error.modelId}`);
  if (error.provider) items.push(`${t.agentError.details.provider} ${error.provider}`);
  if (error.code) items.push(`${t.agentError.details.code} ${error.code}`);
  if (error.httpStatus) items.push(`${t.agentError.details.httpStatus} ${error.httpStatus}`);
  if (error.traceId) items.push(`${t.agentError.details.traceId} ${error.traceId}`);
  return items;
}

/** usage_limit 的恢复时间：按本机时区、带日期时分，同一时刻在任何时区下都是同一瞬间。 */
function formatResetTime(resetAt: string, locale: string): string | null {
  const date = new Date(resetAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 按 category 查 i18n 文案；context_length 的建议带 token 数模板，usage_limit 带窗口词与恢复时间。 */
export function resolveAgentErrorCopy(
  error: Pick<AgentErrorMetadata, 'category' | 'requestedTokens' | 'maxTokens' | 'usageWindowText' | 'resetAt'>,
  t: Translations,
  locale = 'zh-CN',
): { title: string; suggestion: string } {
  const copy = t.agentError.categories[error.category] ?? t.agentError.categories.generic;
  if (error.category === 'usage_limit') {
    const usage = t.agentError.categories.usage_limit;
    const resetTime = error.resetAt ? formatResetTime(error.resetAt, locale) : null;
    return {
      title: error.usageWindowText ? usage.title.replace('{window}', error.usageWindowText) : usage.titleNoWindow,
      suggestion: resetTime ? usage.suggestion.replace('{resetTime}', resetTime) : usage.suggestionNoReset,
    };
  }
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

/** 灰字行的短原因：按 category 查短语表，一行放得下、不带建议动作。 */
function resolveAgentErrorShortReason(
  category: AgentErrorCategory,
  t: Translations,
): string {
  return t.agentError.shortReasons[category] ?? t.agentError.shortReasons.generic;
}

/**
 * 整卡上的「连续 N 次」说明，runLength≥2 才有。不可重试类（NO_RETRY_CATEGORIES）
 * 明说「再发也不会好」；可重试类只陈述次数，不断言重试无效。
 */
function buildRepeatNotice(
  run: Pick<AgentErrorRunInfo, 'runLength'> | undefined,
  category: AgentErrorCategory,
  t: Translations,
): string | null {
  if (!run || run.runLength < 2) return null;
  const template = NO_RETRY_CATEGORIES.has(category)
    ? t.agentError.repeat.noRetry
    : t.agentError.repeat.retryable;
  return template.replace('{n}', String(run.runLength));
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

// 原型屏三的安静描边按钮：1px border-strong、底色 void、32px 高、13px 常规字重、
// 圆角 8px；hover 换 surface 底 + border-hover。
const ACTION_BUTTON_CLASS =
  'flex h-8 items-center gap-1.5 rounded-lg border border-border-strong bg-void px-3 text-[13px] font-normal text-text-secondary transition-colors hover:border-border-hover hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border-strong disabled:hover:bg-void disabled:hover:text-text-secondary';

const AgentErrorCard: React.FC<{
  error: AgentErrorMetadata;
  /** 所在 assistant 消息 id（重试时据此回找上一条 user 消息） */
  messageId: string;
  sessionId?: string;
  /** 同因连续段（投影层推导）；缺失按单次失败处理 */
  run?: AgentErrorRunInfo;
}> = ({ error, messageId, sessionId, run }) => {
  const { t, language } = useI18n();
  const { title, suggestion } = resolveAgentErrorCopy(error, t, language === 'zh' ? 'zh-CN' : 'en-US');
  const developerMode = useAppStore((state) => state.developerMode);
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

  // 技术详情（模型名/错误码/HTTP/Trace ID/复制报告）只对开发者模式露出；goalAbort
  // 连开发者模式也整组隐藏（goal 中止卡只保留可执行出口）。
  const showTechnicalDetails = developerMode && !error.goalAbort;
  const ranOnModel = showTechnicalDetails && error.modelId
    ? `${t.agentError.details.model} ${error.modelId}`
    : null;
  const technicalItems = showTechnicalDetails ? buildTechnicalItems(error, t, false) : [];
  const repeatNotice = buildRepeatNotice(run, error.category, t);

  return (
    <div
      role="alert"
      aria-label={t.agentError.ariaLabel}
      className="mt-3 rounded-xl border border-border-strong bg-void px-4 py-3"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-error" aria-hidden="true" />
        <div className="min-w-0 flex-1">{title}</div>
      </div>

      <div className="mt-0.5 pl-[22px] text-[13px] leading-relaxed text-text-secondary">
        {suggestion}
        {repeatNotice && (
          <span className={language === 'zh' ? undefined : 'ml-1'}>{repeatNotice}</span>
        )}
      </div>

      {ranOnModel && (
        <div className="mt-1.5 pl-[22px] font-mono text-[10px] text-text-tertiary">{ranOnModel}</div>
      )}

      {technicalItems.length > 0 && (
        <details className="mt-1 pl-[22px]">
          <summary className="cursor-pointer text-[10px] text-text-tertiary hover:text-text-secondary">
            {t.agentError.details.technical}
          </summary>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-text-tertiary">
            {technicalItems.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </details>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-[22px]">
        {shouldShowRetry(error.category) && (
          <button /* ds-allow:button: 报错卡操作行是紧凑小按钮组，Button primitive 无此紧凑变体 */
            type="button"
            onClick={handleRetry}
            disabled={isRunning}
            title={isRunning ? t.agentError.actions.retryRunning : t.agentError.actions.retry}
            className={ACTION_BUTTON_CLASS}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t.agentError.actions.retry}
          </button>
        )}
        {shouldShowSwitchModel(error.category) && (
          <button /* ds-allow:button: 报错卡操作行是紧凑小按钮组，Button primitive 无此紧凑变体 */
            type="button"
            onClick={handleSwitchModel}
            className={ACTION_BUTTON_CLASS}
          >
            <SwitchCamera className="h-3.5 w-3.5" />
            {t.agentError.actions.switchModel}
          </button>
        )}
        {CHECK_ACCOUNT_CATEGORIES.has(error.category) && (
          <button /* ds-allow:button: 报错卡操作行是紧凑小按钮组，Button primitive 无此紧凑变体 */
            type="button"
            onClick={handleCheckAccount}
            className={ACTION_BUTTON_CLASS}
          >
            <KeyRound className="h-3.5 w-3.5" />
            {t.agentError.actions.checkAccount}
          </button>
        )}
        {shouldShowNewSession(error.category) && (
          <button /* ds-allow:button: 报错卡操作行是紧凑小按钮组，Button primitive 无此紧凑变体 */
            type="button"
            onClick={handleNewSession}
            className={ACTION_BUTTON_CLASS}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {t.agentError.actions.newSession}
          </button>
        )}
        {showTechnicalDetails && (
          <button /* ds-allow:button: 报错卡操作行是紧凑小按钮组，Button primitive 无此紧凑变体 */
            type="button"
            onClick={handleCopyReport}
            className={ACTION_BUTTON_CLASS}
          >
            <Copy className="h-3.5 w-3.5" />
            {t.agentError.actions.copyReport}
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * 被同因后继压扁的失败轮：一行灰字「没有回复 · 原因」，警告图标、三级文字、无按钮、
 * 不抢 role="alert"（整段只有最新一张卡是警报，早先的失败安静躺在时间线里）。
 */
const SupersededErrorLine: React.FC<{
  error: AgentErrorMetadata;
}> = ({ error }) => {
  const { t } = useI18n();
  return (
    <div
      role="status"
      data-testid="agent-error-muted-line"
      className="mt-2 flex items-center gap-1.5 text-xs text-text-tertiary"
    >
      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>
        {t.agentError.mutedLine.replace('{reason}', resolveAgentErrorShortReason(error.category, t))}
      </span>
    </div>
  );
};

const RateLimitedErrorLine: React.FC<{
  error: AgentErrorMetadata;
  messageId: string;
  sessionId?: string;
}> = ({ error, messageId, sessionId }) => {
  const { t, language } = useI18n();
  const developerMode = useAppStore((state) => state.developerMode);
  const isRunning = useSessionStore((state) => (sessionId ? state.runningSessionIds.has(sessionId) : false));
  const { title, suggestion } = resolveAgentErrorCopy(error, t, language === 'zh' ? 'zh-CN' : 'en-US');
  const technicalItems = buildTechnicalItems(error, t, true);
  const showDeveloperDetails = developerMode && !error.goalAbort;

  const handleRetry = useCallback(() => {
    useMessageActionStore.getState().regenerateMessage(messageId);
  }, [messageId]);

  const handleCopyReport = useCallback(async () => {
    const report = buildAgentErrorReport({ error, title, suggestion, sessionId, t });
    try {
      await navigator.clipboard.writeText(report);
      toast.success(t.agentError.actions.copied);
    } catch {
      toast.error(t.agentError.actions.copyFailed);
    }
  }, [error, title, suggestion, sessionId, t]);

  return (
    <div
      role="status"
      data-testid="rate-limited-error-line"
      className="flex flex-wrap items-baseline gap-x-1.5 py-0.5 text-xs text-zinc-500"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 self-center text-badge-warning" aria-hidden="true" />
      <span>{t.agentError.rateLimitedInline}</span>
      <span aria-hidden="true">·</span>
      <button /* ds-allow:button: 时间线灰字行的行内文字链接，不使用按钮外壳 */
        type="button"
        onClick={handleRetry}
        disabled={isRunning}
        title={isRunning ? t.agentError.actions.retryRunning : t.agentError.actions.retry}
        className="text-badge-info underline underline-offset-2 hover:text-badge-info/80 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:no-underline"
      >
        {t.agentError.actions.retry}
      </button>
      {showDeveloperDetails && (
        <>
          <span aria-hidden="true">·</span>
          <details className="min-w-0 text-[10px] text-zinc-500">
            <summary className="cursor-pointer hover:text-zinc-400">
              {t.agentError.details.technical}
            </summary>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-zinc-500">
              {technicalItems.map((item) => (
                <span key={item}>{item}</span>
              ))}
              <button /* ds-allow:button: 开发者详情内的行内复制链接 */
                type="button"
                onClick={() => void handleCopyReport()}
                className="font-sans text-badge-info underline underline-offset-2 hover:text-badge-info/80"
              >
                {t.agentError.actions.copyReport}
              </button>
            </div>
          </details>
        </>
      )}
    </div>
  );
};

export const AgentErrorPresentation: React.FC<{
  error: AgentErrorMetadata;
  messageId: string;
  sessionId?: string;
  /** 同因连续段（投影层推导）。latest=false 的失败轮压成灰字行；缺失按单次失败。 */
  run?: AgentErrorRunInfo;
}> = (props) => {
  // 同一轮内的重复失败上报（两条用户消息之间同因再次落错）：同一失败，不渲染。
  if (props.run?.duplicate) return null;
  // rate_limited 不参与折叠：保持既有的时间线灰字行 + 重试路径。
  if (props.error.category === 'rate_limited') {
    return <RateLimitedErrorLine {...props} />;
  }
  if (props.run && !props.run.latest) {
    return <SupersededErrorLine error={props.error} />;
  }
  return <AgentErrorCard {...props} />;
};
