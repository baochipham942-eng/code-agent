// ============================================================================
// NativeConnectorsSection - 原生连接器（macOS Calendar/Mail/Reminders）开关
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plug, RefreshCw, Trash2, Unplug, Wrench } from 'lucide-react';
import {
  IPC_DOMAINS,
  type ConnectorLifecycleAction,
  type ConnectorStatusSummary,
  type NativeConnectorInventoryItem,
} from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('NativeConnectorsSection');

type NativeConnectorUiAction = 'probe' | ConnectorLifecycleAction;
type RuntimeConnectorUiAction = 'retry' | 'probe';

export interface NativeConnectorRow extends NativeConnectorInventoryItem {
  status?: ConnectorStatusSummary;
}

export type RuntimeConnectorRow = ConnectorStatusSummary;

interface NativeConnectorActionConfig {
  label: string;
  busyLabel: string;
  ipcAction: 'retry' | 'probe' | 'repairPermission' | 'disconnect' | 'remove';
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
}

const ACTION_CONFIG: Record<NativeConnectorUiAction, NativeConnectorActionConfig> = {
  probe: {
    label: '检查',
    busyLabel: '检查中',
    ipcAction: 'probe',
    icon: RefreshCw,
  },
  repair_permissions: {
    label: '修复权限',
    busyLabel: '修复中',
    ipcAction: 'repairPermission',
    icon: Wrench,
  },
  disconnect: {
    label: '断开',
    busyLabel: '断开中',
    ipcAction: 'disconnect',
    icon: Unplug,
  },
  remove: {
    label: '移除',
    busyLabel: '移除中',
    ipcAction: 'remove',
    icon: Trash2,
    danger: true,
  },
};

const ACTION_ORDER: NativeConnectorUiAction[] = [
  'probe',
  'repair_permissions',
  'disconnect',
  'remove',
];

const FALLBACK_ENABLED_ACTIONS: ConnectorLifecycleAction[] = ['disconnect', 'remove'];

const RUNTIME_ACTION_CONFIG: Record<RuntimeConnectorUiAction, NativeConnectorActionConfig> = {
  retry: {
    label: '重试',
    busyLabel: '重试中',
    ipcAction: 'retry',
    icon: RefreshCw,
  },
  probe: {
    label: '检查',
    busyLabel: '检查中',
    ipcAction: 'probe',
    icon: Plug,
  },
};

const RUNTIME_ACTION_ORDER: RuntimeConnectorUiAction[] = ['retry', 'probe'];

export function buildNativeConnectorRows(
  items: NativeConnectorInventoryItem[],
  statuses: ConnectorStatusSummary[],
): NativeConnectorRow[] {
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  return items.map((item) => ({
    ...item,
    status: statusById.get(item.id),
  }));
}

export function buildRuntimeConnectorRows(
  items: NativeConnectorInventoryItem[],
  statuses: ConnectorStatusSummary[],
): RuntimeConnectorRow[] {
  const nativeIds = new Set(items.map((item) => item.id));
  return statuses.filter((status) => !nativeIds.has(status.id));
}

export function getNativeConnectorReadiness(row: NativeConnectorRow): {
  label: string;
  className: string;
} {
  if (!row.enabled) {
    return {
      label: '已停用',
      className: 'bg-zinc-700 text-zinc-300',
    };
  }

  switch (row.status?.readiness) {
    case 'ready':
      return {
        label: '可用',
        className: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25',
      };
    case 'failed':
      return {
        label: '检查失败',
        className: 'bg-red-500/15 text-red-300 border border-red-500/25',
      };
    case 'unavailable':
      return {
        label: '不可用',
        className: 'bg-amber-500/15 text-amber-300 border border-amber-500/25',
      };
    case 'unchecked':
      return {
        label: '未检查',
        className: 'bg-sky-500/15 text-sky-300 border border-sky-500/25',
      };
    default:
      return {
        label: '状态未返回',
        className: 'bg-zinc-700 text-zinc-300',
      };
  }
}

export function getRuntimeConnectorReadiness(row: RuntimeConnectorRow): {
  label: string;
  className: string;
} {
  switch (row.readiness) {
    case 'ready':
      return {
        label: '可用',
        className: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25',
      };
    case 'failed':
      return {
        label: '检查失败',
        className: 'bg-red-500/15 text-red-300 border border-red-500/25',
      };
    case 'unavailable':
      return {
        label: '不可用',
        className: 'bg-amber-500/15 text-amber-300 border border-amber-500/25',
      };
    case 'unchecked':
      return {
        label: '未检查',
        className: 'bg-sky-500/15 text-sky-300 border border-sky-500/25',
      };
    default:
      return {
        label: '状态未返回',
        className: 'bg-zinc-700 text-zinc-300',
      };
  }
}

export function getNativeConnectorLifecycleActions(row: NativeConnectorRow): NativeConnectorUiAction[] {
  if (!row.enabled) return [];

  const statusActions = row.status?.actions && row.status.actions.length > 0
    ? row.status.actions
    : FALLBACK_ENABLED_ACTIONS;
  const actions = new Set<NativeConnectorUiAction>(['probe', ...statusActions]);
  return ACTION_ORDER.filter((action) => actions.has(action));
}

export function getRuntimeConnectorLifecycleActions(row: RuntimeConnectorRow): RuntimeConnectorUiAction[] {
  const hasRuntimeSignal = Boolean(
    (row.actions && row.actions.length > 0)
      || row.connected
      || row.readiness === 'failed'
      || row.readiness === 'unchecked',
  );

  if (!hasRuntimeSignal) return [];
  return RUNTIME_ACTION_ORDER;
}

export function getNativeConnectorLifecycleRequest(
  connectorId: string,
  action: NativeConnectorUiAction,
): {
  ipcAction: NativeConnectorActionConfig['ipcAction'];
  payload: { connectorId: string };
} {
  return {
    ipcAction: ACTION_CONFIG[action].ipcAction,
    payload: { connectorId },
  };
}

export function getRuntimeConnectorLifecycleRequest(
  connectorId: string,
  action: RuntimeConnectorUiAction,
): {
  ipcAction: NativeConnectorActionConfig['ipcAction'];
  payload: { connectorId: string };
} {
  return {
    ipcAction: RUNTIME_ACTION_CONFIG[action].ipcAction,
    payload: { connectorId },
  };
}

function formatCheckedAt(checkedAt?: number): string | null {
  if (!checkedAt) return null;
  return new Date(checkedAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatActionLabels(actions: NativeConnectorUiAction[]): string {
  if (actions.length === 0) return '无';
  return actions.map((action) => ACTION_CONFIG[action].label).join('、');
}

function formatRuntimeActionLabels(actions: RuntimeConnectorUiAction[]): string {
  if (actions.length === 0) return '无';
  return actions.map((action) => RUNTIME_ACTION_CONFIG[action].label).join('、');
}

function formatCapabilities(capabilities: string[]): string {
  if (capabilities.length === 0) return '无';
  return capabilities.join('、');
}

interface NativeConnectorItemsProps {
  rows: NativeConnectorRow[];
  busyKey: string | null;
  onToggle: (id: string, enabled: boolean) => void;
  onLifecycleAction: (id: string, action: NativeConnectorUiAction) => void;
}

export const NativeConnectorItems: React.FC<NativeConnectorItemsProps> = ({
  rows,
  busyKey,
  onToggle,
  onLifecycleAction,
}) => (
  <div className="space-y-2">
    {rows.map((row) => {
      const readiness = getNativeConnectorReadiness(row);
      const lifecycleActions = getNativeConnectorLifecycleActions(row);
      const rowBusy = Boolean(busyKey?.startsWith(`${row.id}:`));
      const checkedAt = formatCheckedAt(row.status?.checkedAt);
      const detail = row.status?.error || row.status?.detail;

      return (
        <div
          key={row.id}
          className="rounded-md border border-zinc-700 bg-zinc-900/40 px-3 py-2 hover:border-zinc-600 transition-colors"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-zinc-200">{row.label}</span>
                <span className={`text-[11px] px-1.5 py-0.5 rounded ${readiness.className}`}>
                  {readiness.label}
                </span>
                {row.status?.connected && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300">
                    已连接
                  </span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">id: {row.id}</div>
              <div className="mt-1 text-[11px] text-zinc-500">
                可用动作: {formatActionLabels(lifecycleActions)}
                {checkedAt ? ` · 上次检查: ${checkedAt}` : ''}
              </div>
              {detail && (
                <div className={`mt-1 text-xs ${row.status?.error ? 'text-red-300' : 'text-zinc-400'}`}>
                  {detail}
                </div>
              )}
            </div>

            <label className="inline-flex items-center gap-2 text-xs text-zinc-400">
              <span>{row.enabled ? '启用' : '停用'}</span>
              <input
                type="checkbox"
                checked={row.enabled}
                disabled={rowBusy}
                onChange={(e) => onToggle(row.id, e.target.checked)}
                className="w-4 h-4 accent-sky-500 cursor-pointer disabled:opacity-60"
              />
            </label>
          </div>

          {lifecycleActions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {lifecycleActions.map((action) => {
                const config = ACTION_CONFIG[action];
                const Icon = config.icon;
                const actionBusy = busyKey === `${row.id}:${action}`;
                return (
                  <button
                    key={action}
                    type="button"
                    disabled={rowBusy}
                    onClick={() => onLifecycleAction(row.id, action)}
                    className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      config.danger
                        ? 'border-red-500/25 text-red-300 hover:bg-red-500/10'
                        : 'border-zinc-600 text-zinc-300 hover:bg-zinc-800'
                    }`}
                    title={`${row.label} ${config.label}`}
                  >
                    {actionBusy ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Icon className="w-3 h-3" />
                    )}
                    <span>{actionBusy ? config.busyLabel : config.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      );
    })}
  </div>
);

interface RuntimeConnectorItemsProps {
  rows: RuntimeConnectorRow[];
  busyKey: string | null;
  onLifecycleAction: (id: string, action: RuntimeConnectorUiAction) => void;
}

export const RuntimeConnectorItems: React.FC<RuntimeConnectorItemsProps> = ({
  rows,
  busyKey,
  onLifecycleAction,
}) => (
  <div className="space-y-2">
    {rows.map((row) => {
      const readiness = getRuntimeConnectorReadiness(row);
      const lifecycleActions = getRuntimeConnectorLifecycleActions(row);
      const rowBusy = Boolean(busyKey?.startsWith(`${row.id}:`));
      const checkedAt = formatCheckedAt(row.checkedAt);
      const detail = row.error || row.detail;

      return (
        <div
          key={row.id}
          className="rounded-md border border-zinc-700 bg-zinc-900/40 px-3 py-2 hover:border-zinc-600 transition-colors"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-zinc-200">{row.label}</span>
              <span className={`text-[11px] px-1.5 py-0.5 rounded ${readiness.className}`}>
                {readiness.label}
              </span>
              {row.connected && (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300">
                  已连接
                </span>
              )}
            </div>
            <div className="mt-1 text-[11px] text-zinc-500">id: {row.id}</div>
            <div className="mt-1 text-[11px] text-zinc-500">
              能力: {formatCapabilities(row.capabilities)}
              {checkedAt ? ` · 上次检查: ${checkedAt}` : ''}
            </div>
            <div className="mt-1 text-[11px] text-zinc-500">
              可用动作: {formatRuntimeActionLabels(lifecycleActions)}
            </div>
            {detail && (
              <div className={`mt-1 text-xs ${row.error ? 'text-red-300' : 'text-zinc-400'}`}>
                {detail}
              </div>
            )}
          </div>

          {lifecycleActions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {lifecycleActions.map((action) => {
                const config = RUNTIME_ACTION_CONFIG[action];
                const Icon = config.icon;
                const actionBusy = busyKey === `${row.id}:${action}`;
                return (
                  <button
                    key={action}
                    type="button"
                    disabled={rowBusy}
                    onClick={() => onLifecycleAction(row.id, action)}
                    className="inline-flex items-center gap-1.5 rounded border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                    title={`${row.label} ${config.label}`}
                  >
                    {actionBusy ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Icon className="w-3 h-3" />
                    )}
                    <span>{actionBusy ? config.busyLabel : config.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      );
    })}
  </div>
);

export const NativeConnectorsSection: React.FC = () => {
  const [items, setItems] = useState<NativeConnectorInventoryItem[]>([]);
  const [statuses, setStatuses] = useState<ConnectorStatusSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextItems, nextStatuses] = await Promise.all([
        ipcService.invokeDomain<NativeConnectorInventoryItem[]>(
          IPC_DOMAINS.CONNECTOR,
          'listNativeInventory',
        ),
        ipcService.invokeDomain<ConnectorStatusSummary[]>(
          IPC_DOMAINS.CONNECTOR,
          'listStatuses',
        ),
      ]);
      setItems(Array.isArray(nextItems) ? nextItems : []);
      setStatuses(Array.isArray(nextStatuses) ? nextStatuses : []);
      setError(null);
    } catch (err) {
      logger.error('Failed to load native connector inventory/statuses', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(async (id: string, enabled: boolean) => {
    setBusyKey(`${id}:toggle`);
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
      setBusyKey(null);
    }
  }, [refresh]);

  const runLifecycleAction = useCallback(async (id: string, action: NativeConnectorUiAction) => {
    setBusyKey(`${id}:${action}`);
    setError(null);
    const request = getNativeConnectorLifecycleRequest(id, action);
    try {
      await ipcService.invokeDomain(
        IPC_DOMAINS.CONNECTOR,
        request.ipcAction,
        request.payload,
      );
      await refresh();
    } catch (err) {
      logger.error('Failed to run native connector lifecycle action', { id, action, err });
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  const rows = useMemo(
    () => buildNativeConnectorRows(items, statuses),
    [items, statuses],
  );
  const runtimeRows = useMemo(
    () => buildRuntimeConnectorRows(items, statuses),
    [items, statuses],
  );

  const runRuntimeLifecycleAction = useCallback(async (id: string, action: RuntimeConnectorUiAction) => {
    setBusyKey(`${id}:${action}`);
    setError(null);
    const request = getRuntimeConnectorLifecycleRequest(id, action);
    try {
      await ipcService.invokeDomain(
        IPC_DOMAINS.CONNECTOR,
        request.ipcAction,
        request.payload,
      );
      await refresh();
    } catch (err) {
      logger.error('Failed to run runtime connector lifecycle action', { id, action, err });
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
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
        按需启用 macOS 原生应用的连接器；启用后可在这里检查授权、修复权限、断开或移除。
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>加载中…</span>
        </div>
      ) : (
        <>
          <NativeConnectorItems
            rows={rows}
            busyKey={busyKey}
            onToggle={(id, enabled) => void toggle(id, enabled)}
            onLifecycleAction={(id, action) => void runLifecycleAction(id, action)}
          />

          {runtimeRows.length > 0 && (
            <div className="mt-4 border-t border-zinc-700 pt-3">
              <div className="mb-2 text-xs font-medium text-zinc-300">其他连接器</div>
              <RuntimeConnectorItems
                rows={runtimeRows}
                busyKey={busyKey}
                onLifecycleAction={(id, action) => void runRuntimeLifecycleAction(id, action)}
              />
            </div>
          )}
        </>
      )}

      {error && (
        <div className="mt-3 text-xs text-red-400">连接器操作失败: {error}</div>
      )}
    </div>
  );
};
