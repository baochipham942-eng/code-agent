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
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';
import type {
  OpenchronicleSettings as OcSettings,
  OpenchronicleStatus,
} from '../../../../../shared/contract/openchronicle';
import { DEFAULT_OPENCHRONICLE_SETTINGS } from '../../../../../shared/contract/openchronicle';
import { Toggle } from '../../../primitives/Toggle';

const logger = createLogger('OpenchronicleSettings');

type OpenchronicleSettingsText = typeof zh.settings.openchronicle;

const STATE_DOT: Record<OpenchronicleStatus['state'], string> = {
  running: 'bg-green-500',
  starting: 'bg-yellow-500',
  stopping: 'bg-yellow-500',
  stopped: 'bg-zinc-500',
  error: 'bg-red-500',
};

function getOpenchronicleStateLabel(
  state: OpenchronicleStatus['state'],
  labels: OpenchronicleSettingsText['stateLabels'] = zh.settings.openchronicle.stateLabels,
): { dot: string; text: string } {
  return {
    dot: STATE_DOT[state],
    text: labels[state],
  };
}

interface OpenchronicleSettingsProps {
  embedded?: boolean;
}

interface OpenchronicleToggleSwitchProps {
  checked: boolean;
  busy?: boolean;
  onToggle: () => void;
}

export const OpenchronicleToggleSwitch: React.FC<OpenchronicleToggleSwitchProps> = ({
  checked,
  busy = false,
  onToggle,
}) => {
  const { t } = useI18n();
  return (
    <Toggle
      size="md"
      checked={checked}
      disabled={busy}
      onChange={() => onToggle()}
      aria-label={t.settings.openchronicle.control.enableScreenMemory}
    />
  );
};

export const OpenchronicleSettings: React.FC<OpenchronicleSettingsProps> = ({ embedded = false }) => {
  const { t } = useI18n();
  const openchronicleText = t.settings.openchronicle;
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
        setError(result?.error ?? openchronicleText.operationFailed);
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
          {openchronicleText.webUnavailable}
        </p>
      </div>
    );
  }

  const stateUi = getOpenchronicleStateLabel(status?.state ?? 'stopped', openchronicleText.stateLabels);

  return (
    <div className={embedded ? 'space-y-4' : 'p-6 space-y-6 max-w-3xl'}>
      {/* 标题 */}
      {!embedded && (
      <header>
        <h2 className="text-xl font-semibold flex items-center gap-2">
          {settings.enabled ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
          {t.settings.tabs.openchronicle}
        </h2>
        <p className="text-sm text-zinc-400 mt-1">
          {openchronicleText.header.introPrefix}<code className="text-xs bg-zinc-800 px-1 rounded">OpenChronicle</code>{openchronicleText.header.introMiddle}
          {openchronicleText.header.introSuffix}
        </p>
        <p className="text-xs text-amber-400 mt-2 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          {openchronicleText.header.warning}
        </p>
      </header>
      )}

      {/* 主开关 */}
      <section className="border border-zinc-700 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">{openchronicleText.control.enableScreenMemory}</div>
            <div className="text-xs text-zinc-400 mt-0.5">
              {openchronicleText.control.description}
            </div>
          </div>
          <OpenchronicleToggleSwitch
            checked={settings.enabled}
            busy={busy}
            onToggle={() => handleToggle(!settings.enabled)}
          />
        </div>

        <div className="mt-4 pt-4 border-t border-zinc-700 grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-zinc-400">{openchronicleText.status.daemon}</div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`w-2 h-2 rounded-full ${stateUi.dot}`} />
              <span>{stateUi.text}</span>
              {status?.pid && <span className="text-zinc-500">pid {status.pid}</span>}
            </div>
          </div>
          <div>
            <div className="text-zinc-400">{openchronicleText.status.mcpEndpoint}</div>
            <div className="mt-1">
              <span className={status?.mcpHealthy ? 'text-green-400' : 'text-zinc-500'}>
                {status?.mcpHealthy ? openchronicleText.status.connected : openchronicleText.status.disconnected}
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
            <RefreshCw className="w-3 h-3" /> {openchronicleText.refresh}
          </button>
          <span className="text-xs text-zinc-500">
            {openchronicleText.status.dataDirPrefix}<code className="bg-zinc-800 px-1 rounded">~/.openchronicle/memory/</code>
          </span>
        </div>
      </section>

      {/* 上下文注入开关 */}
      <section className="border border-zinc-700 rounded-lg p-4">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <div className="font-medium">{openchronicleText.autoInject.title}</div>
            <div className="text-xs text-zinc-400 mt-0.5">
              {openchronicleText.autoInject.description}
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
        <div className="font-medium mb-2">{openchronicleText.blacklist.title}</div>
        <div className="text-xs text-zinc-400 mb-3">
          {openchronicleText.blacklist.description}
        </div>

        <div className="space-y-3">
          <div>
            <div className="text-xs text-zinc-300 mb-1">{openchronicleText.blacklist.appsLabel}</div>
            <textarea
              value={settings.blacklistApps.join('\n')}
              onChange={(e) =>
                updateSettings({ blacklistApps: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
              }
              disabled={!settings.enabled}
              rows={4}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs font-mono"
              placeholder={openchronicleText.blacklist.appsPlaceholder}
            />
          </div>
          <div>
            <div className="text-xs text-zinc-300 mb-1">{openchronicleText.blacklist.urlPatternsLabel}</div>
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
