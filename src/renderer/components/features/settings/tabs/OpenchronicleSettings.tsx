// ============================================================================
// OpenchronicleSettings — 「屏幕记忆」设置 tab
// 控制外部 OpenChronicle daemon 的开关 + 隐私黑名单
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { Eye, EyeOff, AlertTriangle, RefreshCw } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { createLogger } from '../../../../utils/logger';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';
import type {
  OpenchronicleSettings as OcSettings,
  OpenchronicleStatus,
} from '../../../../../shared/contract/openchronicle';
import { DEFAULT_OPENCHRONICLE_SETTINGS } from '../../../../../shared/contract/openchronicle';

const logger = createLogger('OpenchronicleSettings');

const STATE_LABEL: Record<OpenchronicleStatus['state'], { dot: string; text: string }> = {
  running:  { dot: 'bg-green-500',  text: '运行中' },
  starting: { dot: 'bg-yellow-500', text: '启动中…' },
  stopping: { dot: 'bg-yellow-500', text: '停止中…' },
  stopped:  { dot: 'bg-zinc-500',   text: '已停止' },
  error:    { dot: 'bg-red-500',    text: '异常' },
};

interface OpenchronicleSettingsProps {
  embedded?: boolean;
}

export const OpenchronicleSettings: React.FC<OpenchronicleSettingsProps> = ({ embedded = false }) => {
  const [settings, setSettings] = useState<OcSettings>(DEFAULT_OPENCHRONICLE_SETTINGS);
  const [status, setStatus] = useState<OpenchronicleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([
        ipcService.invokeDomain<OcSettings>(IPC_DOMAINS.OPENCHRONICLE, 'getSettings'),
        ipcService.invokeDomain<OpenchronicleStatus>(IPC_DOMAINS.OPENCHRONICLE, 'getStatus'),
      ]);
      if (s) setSettings(s);
      if (st) setStatus(st);
    } catch (e) {
      logger.error('refresh failed', e);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleToggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await ipcService.invokeDomain<{ ok: boolean; error?: string }>(
        IPC_DOMAINS.OPENCHRONICLE,
        'setEnabled',
        { enabled: next },
      );
      if (!result?.ok) {
        setError(result?.error ?? '操作失败');
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const updateSettings = async (patch: Partial<OcSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await ipcService.invokeDomain(IPC_DOMAINS.OPENCHRONICLE, 'updateSettings', next);
  };

  if (isWebMode()) {
    return (
      <div className={embedded ? 'space-y-3' : 'p-6'}>
        <WebModeBanner />
        <p className="text-sm text-zinc-400 mt-4">
          屏幕记忆功能仅在 macOS 桌面版可用——它需要本地后台 daemon 监听系统活动。
        </p>
      </div>
    );
  }

  const stateUi = status ? STATE_LABEL[status.state] : STATE_LABEL.stopped;

  return (
    <div className={embedded ? 'space-y-4' : 'p-6 space-y-6 max-w-3xl'}>
      {/* 标题 */}
      {!embedded && (
      <header>
        <h2 className="text-xl font-semibold flex items-center gap-2">
          {settings.enabled ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
          屏幕记忆
        </h2>
        <p className="text-sm text-zinc-400 mt-1">
          通过外部 <code className="text-xs bg-zinc-800 px-1 rounded">OpenChronicle</code> daemon
          抓取你的跨 app 工作活动（macOS AX Tree），让 code-agent 在新对话开始时知道你刚才在干啥。
        </p>
        <p className="text-xs text-amber-400 mt-2 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          开启后 OpenChronicle 会 7×24 在后台运行（即使关闭 code-agent），直到你在这里关掉它。
        </p>
      </header>
      )}

      {/* 主开关 */}
      <section className="border border-zinc-700 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">启用屏幕记忆</div>
            <div className="text-xs text-zinc-400 mt-0.5">
              ON：启动 OC daemon + 注册 MCP server · OFF：彻底退出 daemon
            </div>
          </div>
          <button
            onClick={() => handleToggle(!settings.enabled)}
            disabled={busy}
            className={`relative w-12 h-6 rounded-full transition-colors ${
              settings.enabled ? 'bg-green-500' : 'bg-zinc-600'
            } ${busy ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                settings.enabled ? 'translate-x-6' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <div className="mt-4 pt-4 border-t border-zinc-700 grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-zinc-400">Daemon 状态</div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`w-2 h-2 rounded-full ${stateUi.dot}`} />
              <span>{stateUi.text}</span>
              {status?.pid && <span className="text-zinc-500">pid {status.pid}</span>}
            </div>
          </div>
          <div>
            <div className="text-zinc-400">MCP 端点</div>
            <div className="mt-1">
              <span className={status?.mcpHealthy ? 'text-green-400' : 'text-zinc-500'}>
                {status?.mcpHealthy ? '✓ 已连通' : '— 未连接'}
              </span>
            </div>
          </div>
          <div>
            <div className="text-zinc-400">Buffer</div>
            <div className="mt-1">{status?.bufferFiles ?? 0} captures</div>
          </div>
          <div>
            <div className="text-zinc-400">Memory</div>
            <div className="mt-1">{status?.memoryEntries ?? 0} entries</div>
          </div>
        </div>

        {(error || status?.lastError) && (
          <div className="mt-3 p-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-200">
            {error || status?.lastError}
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <button
            onClick={refresh}
            className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" /> 刷新
          </button>
          <span className="text-xs text-zinc-500">
            数据目录: <code className="bg-zinc-800 px-1 rounded">~/.openchronicle/memory/</code>
          </span>
        </div>
      </section>

      {/* 上下文注入开关 */}
      <section className="border border-zinc-700 rounded-lg p-4">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <div className="font-medium">自动注入上下文到对话</div>
            <div className="text-xs text-zinc-400 mt-0.5">
              新会话第一轮时把"你刚才在哪个 app 看什么"作为 system message 注入（限 500 tokens）
            </div>
          </div>
          <input
            type="checkbox"
            checked={settings.autoInjectContext}
            onChange={(e) => updateSettings({ autoInjectContext: e.target.checked })}
            disabled={!settings.enabled}
            className="w-4 h-4"
          />
        </label>
      </section>

      {/* 黑名单（Phase 3 真正实现，先给 UI 占位） */}
      <section className="border border-zinc-700 rounded-lg p-4">
        <div className="font-medium mb-2">隐私黑名单</div>
        <div className="text-xs text-zinc-400 mb-3">
          命中黑名单的 app 或 URL 不会被注入到对话上下文（OC daemon 仍会捕获，但 code-agent 端过滤）
        </div>

        <div className="space-y-3">
          <div>
            <div className="text-xs text-zinc-300 mb-1">黑名单 App（每行一个）</div>
            <textarea
              value={settings.blacklistApps.join('\n')}
              onChange={(e) =>
                updateSettings({ blacklistApps: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
              }
              disabled={!settings.enabled}
              rows={4}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs font-mono"
              placeholder="1Password&#10;Bitwarden&#10;微信"
            />
          </div>
          <div>
            <div className="text-xs text-zinc-300 mb-1">黑名单 URL pattern（glob，每行一个）</div>
            <textarea
              value={settings.blacklistUrlPatterns.join('\n')}
              onChange={(e) =>
                updateSettings({ blacklistUrlPatterns: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
              }
              disabled={!settings.enabled}
              rows={4}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs font-mono"
              placeholder="*.bank.com&#10;accounts.google.com/signin*"
            />
          </div>
        </div>
      </section>
    </div>
  );
};
