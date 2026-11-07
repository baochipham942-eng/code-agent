// ============================================================================
// RoleFirstWakeCard — 新专家第一次醒来的开场与建议
// 确认创建后出现在原确认卡位置，也出现在该专家主会话顶部，直到点建议或先不用。
// 视觉范本 role-wake-prototype-v2.html 屏一/屏二（2026-11-05 owner 返修）：
// 用户刚在确认卡看过名字与职责——卡片不再有名册行，头像只留首字（名字进
// aria-label/title）；failed 先说「建好了能用」，再用次要色说哪里没成功，
// 原始错误只在开发者模式露出，普通用户走 classifyAgentError 映射文案。
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { readPersistedExpertThread } from '@shared/contract/expertThread';
import type { RoleFirstWakeSnapshot } from '@shared/contract/roleAssets';
import { classifyAgentError } from '@shared/utils/agentErrorClassification';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { interpolate } from '../../../i18n/interpolate';
import { getFirstWake, listRoles, retryFirstWake, skipFirstWake } from '../../../services/rolesClient';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { goToExpertThread } from '../../../utils/inviteExpert';
import { resolveAgentErrorCopy, WAKE_CARD_CHECK_ACCOUNT_CATEGORIES } from './AgentErrorCard';
import { MODEL_OVERRIDE_CHANGE_EVENT, OPEN_MODEL_SWITCHER_EVENT } from '../../StatusBar/ModelSwitcher';
import { hasCalendarSource } from './roleWakeSources';
import { RoleWakeProposalsCard } from './RoleWakeProposalsCard';

const POLL_MS = 3000;

interface RoleFirstWakeCardProps {
  roleId: string;
  /** 包一层会话顶部的栏宽。确认卡原位不需要。 */
  framed?: boolean;
  /** 确认刚成功、快照还没回来时先显示进行中，避免空一拍。 */
  expectLive?: boolean;
  onDismissed?: () => void;
}

function isActiveState(state: RoleFirstWakeSnapshot['state'] | undefined): boolean {
  return state === 'pending' || state === 'running';
}

export const RoleFirstWakeCard: React.FC<RoleFirstWakeCardProps> = ({
  roleId,
  framed = false,
  expectLive = false,
  onDismissed,
}) => {
  const { t, language } = useI18n();
  const copy = t.roleFirstWake;
  const [snapshot, setSnapshot] = useState<RoleFirstWakeSnapshot | null | undefined>(undefined);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState(roleId);
  const [pollEpoch, setPollEpoch] = useState(0);
  const developerMode = useAppStore((state) => state.developerMode);
  const onDismissedRef = useRef(onDismissed);
  onDismissedRef.current = onDismissed;

  useEffect(() => {
    let cancelled = false;
    void listRoles().then((entries) => {
      if (cancelled) return;
      const name = entries.find((entry) => entry.roleId === roleId)?.displayName?.trim();
      if (name) setDisplayName(name);
    }).catch(() => {
      // 展示名只用于头像与无障碍标签，失败就用 roleId
    });
    return () => { cancelled = true; };
  }, [roleId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      timer = setTimeout(() => { void tick(); }, POLL_MS);
    };

    const tick = async () => {
      try {
        const next = await getFirstWake(roleId);
        if (cancelled) return;
        setSnapshot(next);
        if (isActiveState(next?.state)) schedule();
      } catch {
        if (!cancelled) schedule();
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // pollEpoch：点「重新查看」后从 failed 复位 pending，轮询要跟着重启
  }, [roleId, pollEpoch]);

  useEffect(() => {
    if (snapshot === null || snapshot?.state === 'skipped') onDismissedRef.current?.();
  }, [snapshot]);

  const live = snapshot ?? (expectLive ? 'optimistic' : null);
  const visible = !dismissed && snapshot !== null && snapshot?.state !== 'skipped' && Boolean(live);

  // 空会话压空态（ChatView 据此不渲染「继续上次的会话」与起手卡）；卡不可见时还回去
  useEffect(() => {
    if (!visible) return undefined;
    useAppStore.getState().setFirstWakeCardRoleId(roleId);
    return () => { useAppStore.getState().setFirstWakeCardRoleId(null, roleId); };
  }, [visible, roleId]);

  // 「换个模型再看」打开选择器；用户真换了模型（override 事件）就自动重看一次。
  // 走 ref：handler 依赖 busy 等渲染期闭包，直接进 deps 会每渲染重挂监听。
  const handleRetryRef = useRef<() => void>(() => {});

  const hide = () => {
    setDismissed(true);
    onDismissedRef.current?.();
  };

  const handleSkip = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await skipFirstWake(roleId);
      hide();
    } catch {
      setBusy(false);
    }
  };

  const handleSuggestion = async (prompt: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await skipFirstWake(roleId);
      hide();
      await goToExpertThread(roleId, { seed: prompt });
    } catch {
      setBusy(false);
    }
  };

  // 「重新查看」：真实的 failed→pending 复位入队（roles IPC firstWakeRetry），
  // 本地先摆回 pending 态并重启轮询，避免等到下一个 3s 拍才动。
  const handleRetry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await retryFirstWake(roleId);
      setSnapshot((prev) => (prev ? { ...prev, state: 'pending' } : { state: 'pending', sourcesMode: 'none', suggestions: [] }));
      setPollEpoch((epoch) => epoch + 1);
    } catch {
      // 宿主拒绝（已不 failed 等）不动本地态，下一拍轮询自然对齐
    } finally {
      setBusy(false);
    }
  };

  const openConnectors = () => {
    // connectors 不是 SettingsTab。普通用户的「连接器」在能力中心，openSettingsTab('mcp') 也会落到同一页。
    useAppStore.getState().openCapabilityHub('connectors');
  };

  const openThread = () => {
    void goToExpertThread(roleId);
  };

  handleRetryRef.current = () => { void handleRetry(); };

  useEffect(() => {
    if (snapshot?.state !== 'failed') return undefined;
    const handler = () => { handleRetryRef.current(); };
    window.addEventListener(MODEL_OVERRIDE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(MODEL_OVERRIDE_CHANGE_EVENT, handler);
  }, [snapshot?.state]);

  if (!visible) return null;

  const state = snapshot?.state ?? 'pending';
  const sourcesMode = snapshot?.sourcesMode ?? 'none';
  const suggestions = sourcesMode === 'connected' ? (snapshot?.suggestions ?? []).slice(0, 3) : [];
  const intro = snapshot?.intro?.trim() ?? '';
  const showRunning = isActiveState(state) || live === 'optimistic';
  const showFailed = state === 'failed';
  const showNone = state === 'completed' && sourcesMode === 'none';
  const showSuggestions = state === 'completed' && sourcesMode === 'connected';

  // failed 文案：普通用户只见短原因映射（roleFirstWake.reasons），generic 直接省略冒号和原因；原始错误仅开发者模式露出
  const failureReason = snapshot?.failureReason?.trim() ?? '';
  const failureCategory = (failureReason ? classifyAgentError({ message: failureReason })?.category : undefined) ?? 'generic';
  const scopeText = hasCalendarSource(snapshot?.sources) ? copy.scopeCalendar : copy.scopeData;
  const shortReason = (copy.reasons as Record<string, string | undefined>)[failureCategory];
  const fallbackReason = failureCategory === 'generic'
    ? undefined
    : resolveAgentErrorCopy(
      { category: failureCategory },
      t,
      language === 'zh' ? 'zh-CN' : 'en-US',
    ).title;
  const mappedReason = shortReason ?? fallbackReason;
  const failedLookLine = developerMode && failureReason
    ? failureReason
    : mappedReason
      ? interpolate(copy.failedLook, { scope: scopeText, reason: mappedReason })
      : interpolate(copy.failedLookGeneric, { scope: scopeText });
  // 出路按 category 分流（与 AgentErrorCard 同一套策略）：账号类给换模型+查账号，其余给重看
  const showAccountActions = WAKE_CARD_CHECK_ACCOUNT_CATEGORIES.has(failureCategory);

  const outlineButtonClass = 'rounded-lg border border-border-strong bg-void px-3 py-1.5 text-left text-sm font-normal text-text-secondary transition-colors hover:border-border-hover hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50';
  const skipButton = (
    <button
      type="button"
      disabled={busy}
      className="ml-auto rounded-md px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
      onClick={() => { void handleSkip(); }}
    >
      {copy.skip}
    </button>
  );

  // 视觉范本 role-wake-prototype-v2.html 屏一/屏二：醒来角色像普通一轮发言——28px
  // 首字头像（名字进 aria-label/title，屏上不再有名册行）、无填充面板；建议是一排
  // 安静的描边按钮，「先不用」淡在最右。颜色全走主题 token，亮暗（含高对比）都成立。
  // mt-2：composer 位与 transcript 底部渐隐区是零间距贴边（实测 scroller.bottom ==
  // card.top），渐隐的半透明残字会贴进卡面读成「文字透出来」；补 8px 呼吸位。
  const body = (
    <div
      className="mb-2 mt-2 grid grid-cols-[28px_minmax(0,1fr)] gap-x-3"
      data-testid="role-first-wake-card"
      data-state={state}
      data-sources-mode={sourcesMode}
    >
      <div
        role="img"
        aria-label={displayName}
        title={displayName}
        className="flex size-7 items-center justify-center rounded-full bg-badge-accent text-sm font-semibold text-badge-accent"
      >
        {displayName.trim().charAt(0) || '·'}
      </div>
      <div className="col-start-2 min-w-0 pt-[3px]">
        {showRunning && (
          <div className="flex items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-full bg-brand animate-pulse motion-reduce:animate-none"
              aria-hidden="true"
              data-testid="role-first-wake-pulse"
            />
            <p className="text-base leading-relaxed text-text-tertiary">{copy.running}</p>
            {skipButton}
          </div>
        )}
        {showFailed && (
          <div className="space-y-0.5">
            <p className="text-base leading-relaxed text-text-primary">{copy.failedReady}</p>
            <p className="text-sm leading-relaxed text-text-secondary" data-testid="role-first-wake-reason">{failedLookLine}</p>
          </div>
        )}
        {(showSuggestions || showNone) && (
          <p className="whitespace-pre-wrap text-base leading-relaxed text-text-primary" data-testid="role-first-wake-intro">
            {intro || copy.introFallback}
          </p>
        )}
        {showNone && <p className="mt-1 text-sm text-text-tertiary">{copy.connectHint}</p>}
        {!showRunning && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {showSuggestions && suggestions.map((suggestion) => (
              <button
                key={suggestion.prompt}
                type="button"
                disabled={busy}
                className={outlineButtonClass}
                onClick={() => { void handleSuggestion(suggestion.prompt); }}
              >
                {suggestion.title}
              </button>
            ))}
            {showNone && (
              <Button variant="primary" size="sm" onClick={openConnectors}>{copy.connect}</Button>
            )}
            {!framed && (showNone || showFailed) && (
              <button
                type="button"
                className={outlineButtonClass}
                onClick={openThread}
              >
                {copy.goToThread}
              </button>
            )}
            {showFailed && showAccountActions && (
              <>
                <button
                  type="button"
                  className={outlineButtonClass}
                  onClick={() => { window.dispatchEvent(new CustomEvent(OPEN_MODEL_SWITCHER_EVENT)); }}
                >
                  {copy.switchModel}
                </button>
                <button
                  type="button"
                  className={outlineButtonClass}
                  onClick={() => { useAppStore.getState().openSettingsTab('model'); }}
                >
                  {copy.checkAccount}
                </button>
              </>
            )}
            {showFailed && !showAccountActions && (
              <button
                type="button"
                disabled={busy}
                className={outlineButtonClass}
                onClick={() => { void handleRetry(); }}
              >
                {copy.retryLook}
              </button>
            )}
            {skipButton}
          </div>
        )}
      </div>
    </div>
  );

  if (!framed) return body;
  return (
    <div className="chat-col-pad mt-2">
      <div className="mx-auto w-full max-w-3xl">{body}</div>
    </div>
  );
};

/**
 * roleId 优先取 expertThread 标记；首次醒来会话没有该标记（写入会改变路由），
 * roleId 只在 origin.metadata（kind=cron, trigger=first_wake）里，重开会话时靠它找回卡片。
 * 导出共用：空会话欢迎页（NewSessionWelcome）靠同一判定认出「这条空会话属于哪位专家」，
 * 不另立第二份判据。
 */
export function resolveBannerRoleId(
  session: { metadata?: unknown; origin?: { kind?: string; metadata?: Record<string, unknown> } } | undefined,
): string | undefined {
  if (!session) return undefined;
  const fromThread = readPersistedExpertThread(session.metadata as never)?.roleId;
  if (fromThread) return fromThread;
  const origin = session.origin;
  if (origin?.kind !== 'cron' || origin.metadata?.trigger !== 'first_wake') return undefined;
  const roleId = origin.metadata.roleId;
  return typeof roleId === 'string' && roleId ? roleId : undefined;
}

/** 当前会话是某专家的主 thread 时，把同一张卡放在对话顶部。 */
export const RoleFirstWakeThreadBanner: React.FC<{
  /** 空会话欢迎页已承接同一批 wake proposals 时，不在顶部重复渲染。 */
  suppressWakeProposals?: boolean;
}> = ({ suppressWakeProposals = false }) => {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSession = useSessionStore((state) => (
    state.sessions.find((session) => session.id === state.currentSessionId)
  ));
  const roleId = resolveBannerRoleId(currentSession);
  if (!currentSessionId || !roleId) return null;
  return (
    <>
      <RoleFirstWakeCard roleId={roleId} framed />
      {!suppressWakeProposals && <RoleWakeProposalsCard roleId={roleId} framed />}
    </>
  );
};
