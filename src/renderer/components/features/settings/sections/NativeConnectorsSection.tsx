// ============================================================================
// NativeConnectorsSection - 原生连接器（macOS Calendar/Mail/Reminders）开关
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { Plug, Loader2 } from 'lucide-react';
import { IPC_DOMAINS, type NativeConnectorInventoryItem } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('NativeConnectorsSection');

export const NativeConnectorsSection: React.FC = () => {
  const [items, setItems] = useState<NativeConnectorInventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await ipcService.invokeDomain<NativeConnectorInventoryItem[]>(
        IPC_DOMAINS.CONNECTOR,
        'listNativeInventory',
      );
      setItems(Array.isArray(next) ? next : []);
      setError(null);
    } catch (err) {
      logger.error('Failed to load native connector inventory', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(async (id: string, enabled: boolean) => {
    setBusyId(id);
    setError(null);
    try {
      await ipcService.invokeDomain(
        IPC_DOMAINS.CONNECTOR,
        'setNativeEnabled',
        { id, enabled },
      );
      await refresh();
    } catch (err) {
      logger.error('Failed to toggle native connector', { id, enabled, err });
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, [refresh]);

  return (
    <div className="bg-zinc-800 rounded-lg p-4 border border-zinc-700">
      <div className="flex items-center gap-2 mb-3">
        <Plug className="w-4 h-4 text-sky-400" />
        <h4 className="text-sm font-medium text-zinc-200">原生连接器</h4>
        <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-600 text-zinc-400">macOS</span>
      </div>
      <p className="text-xs text-zinc-400 mb-3">
        按需启用 macOS 原生应用的连接器；默认全部关闭，启用后会在会话面板中出现。
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>加载中…</span>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <label
              key={item.id}
              className="flex items-center justify-between rounded-md border border-zinc-700 bg-zinc-900/40 px-3 py-2 cursor-pointer hover:border-zinc-600 transition-colors"
            >
              <div className="flex flex-col">
                <span className="text-sm text-zinc-200">{item.label}</span>
                <span className="text-[11px] text-zinc-500">id: {item.id}</span>
              </div>
              <input
                type="checkbox"
                checked={item.enabled}
                disabled={busyId === item.id}
                onChange={(e) => void toggle(item.id, e.target.checked)}
                className="w-4 h-4 accent-sky-500 cursor-pointer disabled:opacity-60"
              />
            </label>
          ))}
        </div>
      )}

      {error && (
        <div className="mt-3 text-xs text-red-400">启用/关闭失败: {error}</div>
      )}
    </div>
  );
};
