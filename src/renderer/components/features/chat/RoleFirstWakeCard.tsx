// ============================================================================
// RoleFirstWakeCard — 新专家第一次醒来的介绍与建议
// 确认创建后出现在原确认卡位置，也出现在该专家主会话顶部，直到点建议或跳过。
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { readPersistedExpertThread } from '@shared/contract/expertThread';
import type { RoleFirstWakeSnapshot } from '@shared/contract/roleAssets';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { interpolate } from '../../../i18n/interpolate';
import { getFirstWake, listRoles, skipFirstWake } from '../../../services/rolesClient';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { goToExpertThread } from '../../../utils/inviteExpert';
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
  const { t } = useI18n();
  const copy = t.roleFirstWake;
  const [snapshot, setSnapshot] = useState<RoleFirstWakeSnapshot | null | undefined>(undefined);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState(roleId);
  const onDismissedRef = useRef(onDismissed);
  onDismissedRef.current = onDismissed;

  useEffect(() => {
    let cancelled = false;
    void listRoles().then((entries) => {
      if (cancelled) return;
      const name = entries.find((entry) => entry.roleId === roleId)?.displayName?.trim();
      if (name) setDisplayName(name);
    }).catch(() => {
      // 展示名只是标题，失败就用 roleId
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
  }, [roleId]);

  useEffect(() => {
    if (snapshot === null || snapshot?.state === 'skipped') onDismissedRef.current?.();
  }, [snapshot]);

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

  const openConnectors = () => {
    // connectors 不是 SettingsTab。普通用户的「连接器」在能力中心，openSettingsTab('mcp') 也会落到同一页。
    useAppStore.getState().openCapabilityHub('connectors');
  };

  const openThread = () => {
    void goToExpertThread(roleId);
  };

  if (dismissed || snapshot === null || snapshot?.state === 'skipped') return null;
  const live = snapshot ?? (expectLive ? 'optimistic' : null);
  if (!live) return null;

  const state = snapshot?.state ?? 'pending';
  const sourcesMode = snapshot?.sourcesMode ?? 'none';
  const suggestions = sourcesMode === 'connected' ? (snapshot?.suggestions ?? []).slice(0, 3) : [];
  const intro = snapshot?.intro?.trim() ?? '';
  const showRunning = isActiveState(state) || live === 'optimistic';
  const showFailed = state === 'failed';
  const showNone = state === 'completed' && sourcesMode === 'none';
  const showSuggestions = state === 'completed' && sourcesMode === 'connected';

  // 视觉范本 role-wake-prototype.html 屏一：醒来角色像普通一轮发言——小头像 + 名字、
  // 无填充面板；建议是一排安静的描边按钮，「跳过」淡在最右。颜色全部走主题 token，
  // 亮暗（含高对比）两套都成立，不再用任何随主题翻转后洗成泥灰的固定底色。
  // mt-2：composer 位（RoleDraftNotifications 原位挂卡）与 transcript 底部渐隐区
  // 是零间距贴边（实测 scroller.bottom == card.top），渐隐的半透明残字会贴进卡面
  // 读成「文字透出来」；补 8px 呼吸位把两块视觉分开（banner 位自带 mt-2 包装层）。
  const body = (
    <div
      className="mb-2 mt-2 grid grid-cols-[28px_minmax(0,1fr)] gap-x-3"
      data-testid="role-first-wake-card"
      data-state={state}
      data-sources-mode={sourcesMode}
    >
      <div
        aria-hidden="true"
        className="flex size-7 items-center justify-center rounded-full bg-badge-accent text-sm font-semibold text-badge-accent"
      >
        {displayName.trim().charAt(0) || '·'}
      </div>
      <p className="text-sm font-semibold leading-7 text-text-primary">{displayName}</p>
      <div className="col-start-2 min-w-0">
        {showRunning && (
          <p className="text-base leading-relaxed text-text-tertiary">
            {interpolate(copy.running, { name: displayName })}
          </p>
        )}
        {showFailed && (
          <div className="space-y-1">
            <p className="text-base leading-relaxed text-status-error">{copy.failedTitle}</p>
            {snapshot?.failureReason && (
              <p className="text-sm text-text-tertiary" data-testid="role-first-wake-reason">{snapshot.failureReason}</p>
            )}
          </div>
        )}
        {(showSuggestions || showNone) && (
          <p className="whitespace-pre-wrap text-base leading-relaxed text-text-primary" data-testid="role-first-wake-intro">
            {intro || copy.introFallback}
          </p>
        )}
        {showNone && <p className="mt-1 text-sm text-text-tertiary">{copy.connectHint}</p>}
        {(showSuggestions || showNone || showFailed) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {showSuggestions && suggestions.map((suggestion) => (
              <button
                key={suggestion.prompt}
                type="button"
                disabled={busy}
                className="rounded-lg border border-border-strong bg-void px-3 py-1.5 text-left text-sm font-normal text-text-secondary transition-colors hover:border-border-hover hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => { void handleSuggestion(suggestion.prompt); }}
              >
                {suggestion.title}
              </button>
            ))}
            {showNone && (
              <Button variant="primary" size="sm" onClick={openConnectors}>{copy.connect}</Button>
            )}
            {(showNone || showFailed) && (
              <button
                type="button"
                className="rounded-lg border border-border-strong bg-void px-3 py-1.5 text-sm font-normal text-text-secondary transition-colors hover:border-border-hover hover:bg-surface hover:text-text-primary"
                onClick={openThread}
              >
                {copy.goToThread}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              className="ml-auto rounded-md px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => { void handleSkip(); }}
            >
              {showFailed ? copy.close : copy.skip}
            </button>
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
 */
function resolveBannerRoleId(
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
export const RoleFirstWakeThreadBanner: React.FC = () => {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSession = useSessionStore((state) => (
    state.sessions.find((session) => session.id === state.currentSessionId)
  ));
  const roleId = resolveBannerRoleId(currentSession);
  if (!currentSessionId || !roleId) return null;
  return (
    <>
      <RoleFirstWakeCard roleId={roleId} framed />
      <RoleWakeProposalsCard roleId={roleId} framed />
    </>
  );
};
