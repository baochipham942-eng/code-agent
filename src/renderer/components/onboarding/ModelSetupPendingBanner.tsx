import React, { useEffect } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { invokeDomain } from '../../services/ipcService';
import { useI18n } from '../../hooks/useI18n';

/**
 * 首启引导被「跳过」后的降级提示条（N-FIRSTRUN-SKIP）：跳过 = 用户要先进主界面，
 * 不再把设置页糊在脸上；「稍后配置」的入口降成聊天列顶部一条可关闭的提示。
 * 用户去设置里接好模型再关掉设置页时复查一次，接好了就自己撤下。
 */
export const ModelSetupPendingBanner: React.FC<{
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onDismiss: () => void;
  onConfigured: () => void;
}> = ({ settingsOpen, onOpenSettings, onDismiss, onConfigured }) => {
  const { t } = useI18n();

  useEffect(() => {
    if (settingsOpen) return;
    let cancelled = false;
    invokeDomain<boolean>(IPC_DOMAINS.SETTINGS, 'checkApiKeyConfigured')
      .then((configured) => {
        if (!cancelled && configured) onConfigured();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, onConfigured]);

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-zinc-300"
    >
      <span className="min-w-0 flex-1 truncate">{t.onboarding.pendingBanner}</span>
      <button
        type="button"
        className="rounded px-2 py-0.5 text-badge-warning hover:bg-amber-500/20"
        onClick={onOpenSettings}
      >
        {t.onboarding.pendingBannerAction}
      </button>
      <button
        type="button"
        aria-label={t.onboarding.pendingBannerDismiss}
        className="px-1 text-zinc-500 hover:text-zinc-300"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
};
