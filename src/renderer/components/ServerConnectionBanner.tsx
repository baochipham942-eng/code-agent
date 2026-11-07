// ============================================================================
// ServerConnectionBanner — 后台服务死亡期间的顶部「重连中」横幅
// ============================================================================
// N-WEBSERVER-DEATH-SUPERVISE-BANNER。壳在自动重启挂掉的 webServer，这期间用户
// 不该看到聊天里的红色 `Load failed`：一条细横幅说清「正在重连、无需操作」。
// recovering 是状态展示（不打断输入）；unavailable 才给「重试」按钮——它重新探测
// 一次，不谎报恢复。状态真源在 utils/serverConnectionMonitor.ts，这里只呈现。
// ============================================================================

import React from 'react';
import { useI18n } from '../hooks/useI18n';
import { useServerConnectionStore } from '../stores/serverConnectionStore';
import { retryNow } from '../utils/serverConnectionMonitor';
import { isTauriMode } from '../utils/platform';
import { Button } from './primitives';

/** 顶部细条；ok 态整条不渲染。视觉范式对齐 ModelSetupPendingBanner（琥珀=降级非致命）。 */
export const ServerConnectionBanner: React.FC = () => {
  const status = useServerConnectionStore((state) => state.status);
  const { t } = useI18n();
  if (status === 'ok') return null;

  const text = t.serverConnection;
  const unavailable = status === 'unavailable';

  return (
    <div
      role="status"
      data-testid="server-connection-banner"
      className={`flex items-center gap-2 border-b px-3 py-1.5 text-xs text-zinc-300 ${
        unavailable ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/30 bg-amber-500/10'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">
        {unavailable ? text.unavailable : text.recovering}
      </span>
      {unavailable && (
        <>
          {/* Tauri 模式页面未必能自愈（服务由壳拉起），恢复动作指向弹窗/重开应用；
              web 模式刷新页面即可。 */}
          <span className="hidden truncate sm:inline">
            {isTauriMode() ? text.unavailableHintTauri : text.unavailableHintWeb}
          </span>
          <Button size="sm" variant="secondary" onClick={retryNow}>
            {text.retry}
          </Button>
        </>
      )}
    </div>
  );
};
