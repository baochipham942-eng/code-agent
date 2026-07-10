// ============================================================================
// PermissionToggle - 会话内权限档切换器（B1 第 4 档收口）
// default / readOnly / acceptEdits / bypassPermissions 四档，与设置页并列。
// 档位真源在 host PermissionModeManager：本组件只读取 + 调用 + 订阅广播，
// 不持有任何本地持久化档位状态（maka #573 双 state 漂移教训）。
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Shield, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import ipcService, { invokeDomain } from '../../../../services/ipcService';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useI18n } from '../../../../hooks/useI18n';

type SessionPermissionMode = 'default' | 'readOnly' | 'acceptEdits' | 'bypassPermissions';

const TIERS: SessionPermissionMode[] = ['default', 'readOnly', 'acceptEdits', 'bypassPermissions'];

const TIER_ICONS: Record<SessionPermissionMode, React.ReactNode> = {
  default: <Shield className="w-3 h-3" />,
  readOnly: <ShieldCheck className="w-3 h-3" />,
  acceptEdits: <ShieldAlert className="w-3 h-3" />,
  bypassPermissions: <ShieldOff className="w-3 h-3" />,
};

const TIER_BUTTON_CLASS: Record<SessionPermissionMode, string> = {
  default: 'text-zinc-500 hover:text-zinc-400 hover:bg-white/[0.04]',
  readOnly: 'bg-emerald-500/15 text-emerald-400',
  acceptEdits: 'bg-amber-500/15 text-amber-400',
  bypassPermissions: 'bg-red-500/20 text-red-400',
};

function isSessionPermissionMode(value: unknown): value is SessionPermissionMode {
  return typeof value === 'string' && (TIERS as string[]).includes(value);
}

interface PermissionToggleProps {
  disabled?: boolean;
}

export const PermissionToggle: React.FC<PermissionToggleProps> = ({ disabled }) => {
  const { t } = useI18n();
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const [mode, setMode] = useState<SessionPermissionMode>('default');
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmBypass, setConfirmBypass] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const modeTexts = t.settings.general.permissions.permissionModes;

  const refresh = useCallback(async () => {
    try {
      const data = await invokeDomain<{ mode?: string }>(IPC_DOMAINS.AGENT, 'getSessionPermissionMode', {
        sessionId: currentSessionId ?? undefined,
      });
      if (isSessionPermissionMode(data?.mode)) {
        setMode(data.mode);
      }
    } catch {
      // agent 未初始化时保持当前显示，等广播同步
    }
  }, [currentSessionId]);

  // 会话切换时取该会话的档位；档位变更广播到达时重新取真源
  useEffect(() => {
    refresh();
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.PERMISSION_MODE_CHANGED,
      () => { refresh(); },
    );
    return () => { unsubscribe?.(); };
  }, [refresh]);

  // 点击组件外关闭菜单
  useEffect(() => {
    if (!menuOpen && !confirmBypass) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
        setConfirmBypass(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [menuOpen, confirmBypass]);

  const applyMode = useCallback(async (next: SessionPermissionMode) => {
    if (!currentSessionId) return;
    try {
      const data = await invokeDomain<{ changed?: boolean; mode?: string }>(IPC_DOMAINS.AGENT, 'setSessionPermissionMode', {
        sessionId: currentSessionId,
        mode: next,
        approved: next === 'bypassPermissions',
      });
      if (isSessionPermissionMode(data?.mode)) {
        setMode(data.mode);
      }
    } catch {
      // 设置失败：保持真源状态（下次 refresh 纠正），不做乐观更新
    }
    setMenuOpen(false);
    setConfirmBypass(false);
  }, [currentSessionId]);

  const handleSelect = useCallback((next: SessionPermissionMode) => {
    if (next === 'bypassPermissions') {
      setConfirmBypass(true);
      return;
    }
    void applyMode(next);
  }, [applyMode]);

  const interactive = !disabled && !!currentSessionId;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => { setConfirmBypass(false); setMenuOpen((open) => !open); }}
        disabled={!interactive}
        title={t.permissionTier.buttonTitle}
        className={`
          flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium
          transition-all duration-150
          ${TIER_BUTTON_CLASS[mode]}
          ${!interactive ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
      >
        {TIER_ICONS[mode]}
        <span className="whitespace-nowrap">{modeTexts[mode].title}</span>
      </button>

      {menuOpen && !confirmBypass && (
        <div className="absolute bottom-full left-0 mb-2 w-64 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-50 p-1.5">
          <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-zinc-500">
            {t.permissionTier.menuTitle}
          </div>
          {TIERS.map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => handleSelect(tier)}
              className={`
                w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left
                ${tier === mode ? 'bg-white/[0.08]' : 'hover:bg-white/[0.05]'}
              `}
            >
              <span className="mt-0.5 shrink-0 text-zinc-300">{TIER_ICONS[tier]}</span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-zinc-200">{modeTexts[tier].title}</span>
                <span className="block text-[11px] leading-snug text-zinc-500">{modeTexts[tier].operationScope}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {confirmBypass && (
        <div className="absolute bottom-full left-0 mb-2 w-56 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-50 p-3">
          <p className="text-xs text-zinc-300 mb-3">{t.permissionTier.bypassConfirmText}</p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmBypass(false)}
              className="px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
            >
              {t.common.cancel}
            </button>
            <button
              type="button"
              onClick={() => void applyMode('bypassPermissions')}
              className="px-2.5 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-md transition-colors"
            >
              {t.permissionTier.enable}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
