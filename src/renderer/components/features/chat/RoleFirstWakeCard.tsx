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

  const body = (
    <div
      className="mb-2 rounded-lg border border-badge-info/60 bg-sky-950/30 px-3 py-2"
      data-testid="role-first-wake-card"
      data-state={state}
      data-sources-mode={sourcesMode}
    >
      {showRunning && (
        <p className="text-xs text-zinc-200">{interpolate(copy.running, { name: displayName })}</p>
      )}
      {showFailed && (
        <div className="space-y-1">
          <p className="text-xs text-zinc-100">{copy.failedTitle}</p>
          {snapshot?.failureReason && (
            <p className="text-xs text-zinc-400" data-testid="role-first-wake-reason">{snapshot.failureReason}</p>
          )}
        </div>
      )}
      {(showSuggestions || showNone) && (
        <p className="whitespace-pre-wrap text-xs text-zinc-200" data-testid="role-first-wake-intro">
          {intro || copy.introFallback}
        </p>
      )}
      {showNone && <p className="mt-1 text-xs text-zinc-400">{copy.connectHint}</p>}
      {showSuggestions && suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion.prompt}
              variant="secondary"
              size="sm"
              disabled={busy}
              className="h-auto whitespace-normal text-left"
              onClick={() => { void handleSuggestion(suggestion.prompt); }}
            >
              {suggestion.title}
            </Button>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {showNone && (
          <Button variant="primary" size="sm" onClick={openConnectors}>{copy.connect}</Button>
        )}
        {(showNone || showFailed) && (
          <Button variant="secondary" size="sm" onClick={openThread}>{copy.goToThread}</Button>
        )}
        {showFailed ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void handleSkip(); }}>{copy.close}</Button>
        ) : (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void handleSkip(); }}>{copy.skip}</Button>
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

/** 当前会话是某专家的主 thread 时，把同一张卡放在对话顶部。 */
export const RoleFirstWakeThreadBanner: React.FC = () => {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const metadata = useSessionStore((state) => (
    state.sessions.find((session) => session.id === state.currentSessionId)?.metadata
  ));
  const roleId = readPersistedExpertThread(metadata)?.roleId;
  if (!currentSessionId || !roleId) return null;
  return <RoleFirstWakeCard roleId={roleId} framed />;
};
