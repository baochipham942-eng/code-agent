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
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';

const logger = createLogger('NativeConnectorsSection');

type NativeConnectorUiAction = 'probe' | ConnectorLifecycleAction;
type RuntimeConnectorUiAction = 'retry' | 'probe';

export interface NativeConnectorRow extends NativeConnectorInventoryItem {
  status?: ConnectorStatusSummary;
}

export type RuntimeConnectorRow = ConnectorStatusSummary;

interface NativeConnectorActionConfig {
  ipcAction: 'retry' | 'probe' | 'repairPermission' | 'disconnect' | 'remove';
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
}

type NativeConnectorsText = ReturnType<typeof useI18n>['t']['settings']['nativeConnectors'];

// zh 默认值只服务测试兼容（既定模式），组件真实路径由父级传 t 派生值
const DEFAULT_NATIVE_CONNECTORS_TEXT: NativeConnectorsText = zh.settings.nativeConnectors;

const ACTION_CONFIG: Record<NativeConnectorUiAction, NativeConnectorActionConfig> = {
  probe: {
    ipcAction: 'probe',
    icon: RefreshCw,
  },
  repair_permissions: {
    ipcAction: 'repairPermission',
    icon: Wrench,
  },
  disconnect: {
    ipcAction: 'disconnect',
    icon: Unplug,
  },
  remove: {
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
    ipcAction: 'retry',
    icon: RefreshCw,
  },
  probe: {
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

export function getNativeConnectorReadiness(
  row: NativeConnectorRow,
  labels: NativeConnectorsText['readiness'] = DEFAULT_NATIVE_CONNECTORS_TEXT.readiness,
): {
  label: string;
  className: string;
} {
  if (!row.enabled) {
    return {
      label: labels.disabled,
      className: 'bg-zinc-700 text-zinc-300',
    };
  }

  switch (row.status?.readiness) {
    case 'ready':
      return {
        label: labels.ready,
        className: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25',
      };
    case 'failed':
      return {
        label: labels.failed,
        className: 'bg-red-500/15 text-red-300 border border-red-500/25',
      };
    case 'unavailable':
      return {
        label: labels.unavailable,
        className: 'bg-amber-500/15 text-amber-300 border border-amber-500/25',
      };
    case 'unchecked':
      return {
        label: labels.unchecked,
        className: 'bg-sky-500/15 text-sky-300 border border-sky-500/25',
      };
    default:
      return {
        label: labels.unknown,
        className: 'bg-zinc-700 text-zinc-300',
      };
  }
}

export function getRuntimeConnectorReadiness(
  row: RuntimeConnectorRow,
  labels: NativeConnectorsText['readiness'] = DEFAULT_NATIVE_CONNECTORS_TEXT.readiness,
): {
  label: string;
  className: string;
} {
  switch (row.readiness) {
    case 'ready':
      return {
        label: labels.ready,
        className: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25',
      };
    case 'failed':
      return {
        label: labels.failed,
        className: 'bg-red-500/15 text-red-300 border border-red-500/25',
      };
    case 'unavailable':
      return {
        label: labels.unavailable,
        className: 'bg-amber-500/15 text-amber-300 border border-amber-500/25',
      };
    case 'unchecked':
      return {
        label: labels.unchecked,
        className: 'bg-sky-500/15 text-sky-300 border border-sky-500/25',
      };
    default:
      return {
        label: labels.unknown,
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

function formatActionLabels(actions: NativeConnectorUiAction[], text: NativeConnectorsText): string {
  if (actions.length === 0) return text.empty;
  return actions.map((action) => text.actions[action].label).join(text.separator);
}

function formatRuntimeActionLabels(actions: RuntimeConnectorUiAction[], text: NativeConnectorsText): string {
  if (actions.length === 0) return text.empty;
  return actions.map((action) => text.actions[action].label).join(text.separator);
}

function formatCapabilities(capabilities: string[], text: NativeConnectorsText): string {
  if (capabilities.length === 0) return text.empty;
  return capabilities.join(text.separator);
}

interface NativeConnectorItemsProps {
  rows: NativeConnectorRow[];
  busyKey: string | null;
  text?: NativeConnectorsText;
  onToggle: (id: string, enabled: boolean) => void;
  onLifecycleAction: (id: string, action: NativeConnectorUiAction) => void;
}

export const NativeConnectorItems: React.FC<NativeConnectorItemsProps> = ({
  rows,
  busyKey,
  text = DEFAULT_NATIVE_CONNECTORS_TEXT,
  onToggle,
  onLifecycleAction,
}) => (
  <div className="space-y-2">
    {rows.map((row) => {
      const readiness = getNativeConnectorReadiness(row, text.readiness);
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
                    {text.connected}
                  </span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">id: {row.id}</div>
              <div className="mt-1 text-[11px] text-zinc-500">
                {text.availableActionsPrefix}{formatActionLabels(lifecycleActions, text)}
                {checkedAt ? `${text.lastCheckedPrefix}${checkedAt}` : ''}
              </div>
              {detail && (
                <div className={`mt-1 text-xs ${row.status?.error ? 'text-red-300' : 'text-zinc-400'}`}>
                  {detail}
                </div>
              )}
            </div>

            <label className="inline-flex items-center gap-2 text-xs text-zinc-400">
              <span>{row.enabled ? text.enabled : text.disabled}</span>
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
                const actionText = text.actions[action];
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
                    title={`${row.label} ${actionText.label}`}
                  >
                    {actionBusy ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Icon className="w-3 h-3" />
                    )}
                    <span>{actionBusy ? actionText.busyLabel : actionText.label}</span>
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
  text?: NativeConnectorsText;
  onLifecycleAction: (id: string, action: RuntimeConnectorUiAction) => void;
}

export const RuntimeConnectorItems: React.FC<RuntimeConnectorItemsProps> = ({
  rows,
  busyKey,
  text = DEFAULT_NATIVE_CONNECTORS_TEXT,
  onLifecycleAction,
}) => (
  <div className="space-y-2">
    {rows.map((row) => {
      const readiness = getRuntimeConnectorReadiness(row, text.readiness);
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
                  {text.connected}
                </span>
              )}
            </div>
            <div className="mt-1 text-[11px] text-zinc-500">id: {row.id}</div>
            <div className="mt-1 text-[11px] text-zinc-500">
              {text.capabilitiesPrefix}{formatCapabilities(row.capabilities, text)}
              {checkedAt ? `${text.lastCheckedPrefix}${checkedAt}` : ''}
            </div>
            <div className="mt-1 text-[11px] text-zinc-500">
              {text.availableActionsPrefix}{formatRuntimeActionLabels(lifecycleActions, text)}
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
                const actionText = text.actions[action];
                const Icon = config.icon;
                const actionBusy = busyKey === `${row.id}:${action}`;
                return (
                  <button
                    key={action}
                    type="button"
                    disabled={rowBusy}
                    onClick={() => onLifecycleAction(row.id, action)}
                    className="inline-flex items-center gap-1.5 rounded border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                    title={`${row.label} ${actionText.label}`}
                  >
                    {actionBusy ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Icon className="w-3 h-3" />
                    )}
                    <span>{actionBusy ? actionText.busyLabel : actionText.label}</span>
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
  const { t } = useI18n();
  const connectorText = t.settings.nativeConnectors;
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
        <h4 className="text-sm font-medium text-zinc-200">{connectorText.title}</h4>
        <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-600 text-zinc-400">macOS</span>
      </div>
      <p className="text-xs text-zinc-400 mb-3">
        {connectorText.description}
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>{connectorText.loading}</span>
        </div>
      ) : (
        <>
          <NativeConnectorItems
            rows={rows}
            busyKey={busyKey}
            text={connectorText}
            onToggle={(id, enabled) => void toggle(id, enabled)}
            onLifecycleAction={(id, action) => void runLifecycleAction(id, action)}
          />

          {runtimeRows.length > 0 && (
            <div className="mt-4 border-t border-zinc-700 pt-3">
              <div className="mb-2 text-xs font-medium text-zinc-300">{connectorText.otherConnectors}</div>
              <RuntimeConnectorItems
                rows={runtimeRows}
                busyKey={busyKey}
                text={connectorText}
                onLifecycleAction={(id, action) => void runRuntimeLifecycleAction(id, action)}
              />
            </div>
          )}
        </>
      )}

      {error && (
        <div className="mt-3 text-xs text-red-400">{connectorText.operationFailedPrefix}{error}</div>
      )}
    </div>
  );
};
