// ============================================================================
// DataSettings - Data Management Tab
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowUpRight,
  Bug,
  CheckCircle,
  Clock,
  Database,
  FileText,
  Loader2,
  MessageSquare,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { TELEMETRY_CHANNELS } from '@shared/ipc/channels';
import { Button } from '../../../primitives';
import { createLogger } from '../../../../utils/logger';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import { useAppStore } from '../../../../stores/appStore';
import { useAuthStore } from '../../../../stores/authStore';
import ipcService from '../../../../services/ipcService';
import type { PersistenceHealth } from '@shared/contract';
import {
  fetchWebPersistenceHealth,
  getPersistenceWarningText,
  shouldShowPersistenceWarning,
} from '../../../../services/persistenceHealth';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';

const logger = createLogger('DataSettings');
type DataSettingsText = typeof zh.settings.data;
const DEFAULT_DATA_SETTINGS_TEXT = zh.settings.data;

export interface DataStats {
  sessionCount: number;
  messageCount: number;
  toolExecutionCount: number;
  knowledgeCount: number;
  databaseSize: number;
  cacheEntries: number;
}

export interface SnapshotStats {
  snapshotCount: number;
  sessionCount: number;
  totalBytes: number;
  retentionDays: number;
}

export interface DataManagementSummary {
  sessionCount: number;
  messageCount: number;
  databaseSizeLabel: string;
  cacheEntries: number;
  snapshotCount: number;
  snapshotSizeLabel: string;
  retentionLabel: string;
}

export interface DataManagementRow {
  id: 'sessions' | 'messages' | 'tool-executions' | 'knowledge' | 'database' | 'cache';
  title: string;
  description: string;
  valueLabel: string;
  statusLabel: string;
  statusTone: 'stable' | 'info' | 'warning';
  cleanupLabel: string;
  action: 'none' | 'clear-cache';
}

const EMPTY_DATA_STATS: DataStats = {
  sessionCount: 0,
  messageCount: 0,
  toolExecutionCount: 0,
  knowledgeCount: 0,
  databaseSize: 0,
  cacheEntries: 0,
};

const EMPTY_SNAPSHOT_STATS: SnapshotStats = {
  snapshotCount: 0,
  sessionCount: 0,
  totalBytes: 0,
  retentionDays: 1,
};

const RETENTION_OPTIONS = [1, 7, 30, -1] as const;
type RetentionOptionValue = typeof RETENTION_OPTIONS[number];

function getRetentionOptionLabel(
  value: RetentionOptionValue,
  text: DataSettingsText['retentionOptions'] = DEFAULT_DATA_SETTINGS_TEXT.retentionOptions,
): string {
  if (value === 7) return text.sevenDays;
  if (value === 30) return text.thirtyDays;
  if (value === -1) return text.forever;
  return text.oneDay;
}

export function formatDataSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getRetentionLabel(
  days: number,
  text: DataSettingsText['retentionOptions'] = DEFAULT_DATA_SETTINGS_TEXT.retentionOptions,
): string {
  return RETENTION_OPTIONS.includes(days as RetentionOptionValue)
    ? getRetentionOptionLabel(days as RetentionOptionValue, text)
    : text.oneDay;
}

export function buildDataManagementSummary(
  stats: DataStats | null,
  snapshotStats: SnapshotStats | null,
  text: DataSettingsText = DEFAULT_DATA_SETTINGS_TEXT,
): DataManagementSummary {
  const safeStats = stats ?? EMPTY_DATA_STATS;
  const safeSnapshotStats = snapshotStats ?? EMPTY_SNAPSHOT_STATS;

  return {
    sessionCount: safeStats.sessionCount,
    messageCount: safeStats.messageCount,
    databaseSizeLabel: formatDataSize(safeStats.databaseSize),
    cacheEntries: safeStats.cacheEntries,
    snapshotCount: safeSnapshotStats.snapshotCount,
    snapshotSizeLabel: formatDataSize(safeSnapshotStats.totalBytes),
    retentionLabel: getRetentionLabel(safeSnapshotStats.retentionDays, text.retentionOptions),
  };
}

export function buildDataManagementRows(
  stats: DataStats | null,
  text: DataSettingsText = DEFAULT_DATA_SETTINGS_TEXT,
): DataManagementRow[] {
  const safeStats = stats ?? EMPTY_DATA_STATS;
  const rowsText = text.dataRows;

  return [
    {
      id: 'sessions',
      title: rowsText.sessions.title,
      description: rowsText.sessions.description,
      valueLabel: `${safeStats.sessionCount.toLocaleString()}${text.units.itemSuffix}`,
      statusLabel: rowsText.sessions.status,
      statusTone: 'stable',
      cleanupLabel: rowsText.sessions.cleanup,
      action: 'none',
    },
    {
      id: 'messages',
      title: rowsText.messages.title,
      description: rowsText.messages.description,
      valueLabel: `${safeStats.messageCount.toLocaleString()}${text.units.itemSuffix}`,
      statusLabel: rowsText.messages.status,
      statusTone: 'stable',
      cleanupLabel: rowsText.messages.cleanup,
      action: 'none',
    },
    {
      id: 'tool-executions',
      title: rowsText.toolExecutions.title,
      description: rowsText.toolExecutions.description,
      valueLabel: `${safeStats.toolExecutionCount.toLocaleString()}${text.units.itemSuffix}`,
      statusLabel: safeStats.toolExecutionCount > 0 ? rowsText.toolExecutions.statusCached : rowsText.toolExecutions.statusClean,
      statusTone: 'info',
      cleanupLabel: rowsText.toolExecutions.cleanup,
      action: 'none',
    },
    {
      id: 'knowledge',
      title: rowsText.knowledge.title,
      description: rowsText.knowledge.description,
      valueLabel: `${safeStats.knowledgeCount.toLocaleString()}${text.units.itemSuffix}`,
      statusLabel: rowsText.knowledge.status,
      statusTone: 'info',
      cleanupLabel: rowsText.knowledge.cleanup,
      action: 'none',
    },
    {
      id: 'database',
      title: rowsText.database.title,
      description: rowsText.database.description,
      valueLabel: formatDataSize(safeStats.databaseSize),
      statusLabel: rowsText.database.status,
      statusTone: 'info',
      cleanupLabel: rowsText.database.cleanup,
      action: 'none',
    },
    {
      id: 'cache',
      title: rowsText.cache.title,
      description: rowsText.cache.description,
      valueLabel: `${safeStats.cacheEntries.toLocaleString()}${text.units.itemSuffix}`,
      statusLabel: safeStats.cacheEntries > 0 ? rowsText.cache.statusClearable : rowsText.cache.statusClean,
      statusTone: safeStats.cacheEntries > 0 ? 'warning' : 'stable',
      cleanupLabel: rowsText.cache.cleanup,
      action: 'clear-cache',
    },
  ];
}

function getRowIcon(rowId: DataManagementRow['id']): React.ReactNode {
  if (rowId === 'messages') return <MessageSquare className="h-4 w-4" />;
  if (rowId === 'tool-executions') return <Clock className="h-4 w-4" />;
  if (rowId === 'knowledge') return <Archive className="h-4 w-4" />;
  if (rowId === 'database') return <Database className="h-4 w-4" />;
  if (rowId === 'cache') return <RefreshCw className="h-4 w-4" />;
  return <FileText className="h-4 w-4" />;
}

function getStatusClass(tone: DataManagementRow['statusTone']): string {
  if (tone === 'warning') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  if (tone === 'info') return 'border-blue-500/30 bg-blue-500/10 text-blue-300';
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
}

interface TelemetryHealthSummary {
  /** IPC 是否成功（true 表示 telemetry:health 返回了数据） */
  available: boolean;
  /** 后端是否在采集（DB 可达即视为在跑） */
  enabled: boolean;
  sessionCount: number | null;
  /** telemetry 表占用（字节）；null 表示未拿到 */
  storageBytes: number | null;
  /** 最近事件时间戳（ms）；null 表示无数据 */
  lastEventAt: number | null;
  error?: string;
}

function formatLastEventAt(
  ts: number | null,
  text: DataSettingsText['telemetry']['time'] = DEFAULT_DATA_SETTINGS_TEXT.telemetry.time,
): string {
  if (!ts) return text.noEvents;
  const delta = Date.now() - ts;
  if (delta < 60_000) return text.justNow;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}${text.minuteSuffix}`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}${text.hourSuffix}`;
  return new Date(ts).toLocaleString();
}

export const DataSettings: React.FC = () => {
  const { t } = useI18n();
  const dataText = t.settings.data;
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const isAdmin = useAuthStore((s) => s.user?.isAdmin === true);
  const [stats, setStats] = useState<DataStats | null>(null);
  const [snapshotStats, setSnapshotStats] = useState<SnapshotStats | null>(null);
  const [telemetrySummary, setTelemetrySummary] = useState<TelemetryHealthSummary>({
    available: false,
    enabled: false,
    sessionCount: null,
    storageBytes: null,
    lastEventAt: null,
  });
  const [persistenceHealth, setPersistenceHealth] = useState<PersistenceHealth | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);
  const [isClearingSnapshots, setIsClearingSnapshots] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadStats = useCallback(async () => {
    fetchWebPersistenceHealth()
      .then(setPersistenceHealth)
      .catch(() => setPersistenceHealth(null));

    try {
      const [dataStats, snapStats] = await Promise.all([
        ipcService.invokeDomain<DataStats>(IPC_DOMAINS.DATA, 'getStats'),
        isAdmin
          ? ipcService.invokeDomain<SnapshotStats>(IPC_DOMAINS.DATA, 'getSnapshotStats')
          : Promise.resolve(null),
      ]);
      if (dataStats) setStats(dataStats);
      setSnapshotStats(snapStats ?? null);
    } catch (error) {
      logger.error('Failed to load data stats', error);
    } finally {
      setIsLoading(false);
    }

    if (!isAdmin) {
      setTelemetrySummary({
        available: false,
        enabled: false,
        sessionCount: null,
        storageBytes: null,
        lastEventAt: null,
      });
      return;
    }

    // Telemetry 健康摘要：直接调用 telemetry:health 拿 enabled / sessionCount /
    // storageBytes / lastEventAt 四个字段（main 侧 telemetry.ipc.ts 注册）。
    try {
      const health = await ipcService.invoke(TELEMETRY_CHANNELS.HEALTH);
      setTelemetrySummary({
        available: true,
        enabled: !!health?.enabled,
        sessionCount: typeof health?.sessionCount === 'number' ? health.sessionCount : 0,
        storageBytes: typeof health?.storageBytes === 'number' ? health.storageBytes : 0,
        lastEventAt: typeof health?.lastEventAt === 'number' ? health.lastEventAt : null,
      });
    } catch (error) {
      setTelemetrySummary({
        available: false,
        enabled: false,
        sessionCount: null,
        storageBytes: null,
        lastEventAt: null,
        error: error instanceof Error ? error.message : dataText.unknownError,
      });
    }
  }, [dataText, isAdmin]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const dataRows = useMemo(() => buildDataManagementRows(stats, dataText), [dataText, stats]);
  const summary = useMemo(
    () => buildDataManagementSummary(stats, snapshotStats, dataText),
    [dataText, snapshotStats, stats],
  );
  const persistenceWarningText = getPersistenceWarningText(persistenceHealth);
  const summaryCards = useMemo(() => {
    const cards = [
      [
        dataText.controlPlane.summaryCards.sessions,
        summary.sessionCount.toLocaleString(),
        `${summary.messageCount.toLocaleString()}${dataText.units.messageSuffix}`,
      ],
      [
        dataText.controlPlane.summaryCards.database,
        summary.databaseSizeLabel,
        dataText.controlPlane.summaryCards.localAppData,
      ],
      [
        dataText.controlPlane.summaryCards.cache,
        summary.cacheEntries.toLocaleString(),
        dataText.controlPlane.summaryCards.clearAsNeeded,
      ],
    ];
    if (isAdmin) {
      cards.push([
        dataText.controlPlane.summaryCards.snapshots,
        summary.snapshotCount.toLocaleString(),
        `${summary.snapshotSizeLabel} / ${summary.retentionLabel}`,
      ]);
    }
    return cards;
  }, [dataText, isAdmin, summary]);

  const handleClearSnapshots = async () => {
    if (!isAdmin) return;
    setIsClearingSnapshots(true);
    setMessage(null);
    try {
      const cleared = await ipcService.invokeDomain<number>(IPC_DOMAINS.DATA, 'clearSnapshots', {});
      setMessage({
        type: 'success',
        text: cleared && cleared > 0
          ? `${dataText.messages.snapshotsClearedPrefix}${cleared}${dataText.messages.snapshotsClearedSuffix}`
          : dataText.messages.noSnapshotsToClear,
      });
      await loadStats();
    } catch {
      setMessage({ type: 'error', text: dataText.messages.clearFailed });
    } finally {
      setIsClearingSnapshots(false);
    }
  };

  const handleRetentionChange = async (days: number) => {
    if (!isAdmin) return;
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.DATA, 'setSnapshotRetention', { days });
      await loadStats();
    } catch (error) {
      logger.error('Failed to set retention', error);
    }
  };

  const handleClearToolCache = async () => {
    setIsClearing(true);
    setMessage(null);
    try {
      const cleared = await ipcService.invokeDomain<number>(IPC_DOMAINS.DATA, 'clearToolCache');
      setMessage({
        type: 'success',
        text: cleared === 0
          ? dataText.messages.cacheAlreadyEmpty
          : `${dataText.messages.cacheClearedPrefix}${cleared}${dataText.messages.cacheClearedSuffix}`,
      });
      await loadStats();
    } catch {
      setMessage({ type: 'error', text: dataText.messages.clearFailed });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <SettingsPage
      title={dataText.title}
      description={dataText.description}
    >
      <WebModeBanner />

      {shouldShowPersistenceWarning(persistenceHealth) && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">{dataText.persistence.title}</div>
            <div className="mt-0.5 text-xs text-amber-200/80">
              {persistenceWarningText}
              {persistenceHealth.reason ? `${dataText.persistence.reasonPrefix}${persistenceHealth.reason}` : ''}
            </div>
          </div>
        </div>
      )}

      {message && (
        <div className={`flex items-center gap-2 rounded-lg p-3 ${
          message.type === 'success' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
        }`}
        >
          {message.type === 'success' ? <CheckCircle className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          <span className="text-sm">{message.text}</span>
        </div>
      )}

      <SettingsSection
        title={dataText.controlPlane.title}
        description={dataText.controlPlane.description}
        actions={(
          <Button
            size="sm"
            variant="secondary"
            onClick={loadStats}
            disabled={isLoading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {dataText.actions.refresh}
          </Button>
        )}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className={`grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 ${isAdmin ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
            {summaryCards.map(([label, value, caption]) => (
              <div key={label} className="bg-zinc-900/80 px-3 py-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                <div className="mt-1 truncate text-lg font-semibold text-zinc-100">{value}</div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-500">{caption}</div>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="border-b border-zinc-700/60 bg-zinc-900/80 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">{dataText.controlPlane.columns.dataObject}</th>
                  <th className="px-3 py-2 font-medium">{dataText.controlPlane.columns.quantity}</th>
                  <th className="px-3 py-2 font-medium">{dataText.controlPlane.columns.status}</th>
                  <th className="px-3 py-2 font-medium">{dataText.controlPlane.columns.cleanupPolicy}</th>
                  <th className="px-3 py-2 text-right font-medium">{dataText.controlPlane.columns.action}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">
                      <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                      {dataText.controlPlane.loading}
                    </td>
                  </tr>
                ) : (
                  dataRows.map((row) => (
                    <tr key={row.id} className="bg-zinc-900/40 hover:bg-zinc-800/60">
                      <td className="px-3 py-3 align-middle">
                        <div className="flex items-start gap-2">
                          <span className="rounded border border-zinc-700 bg-zinc-800 p-1.5 text-zinc-300">
                            {getRowIcon(row.id)}
                          </span>
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-zinc-200">{row.title}</div>
                            <div className="mt-1 max-w-[360px] text-zinc-500">{row.description}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-middle text-zinc-300">{row.valueLabel}</td>
                      <td className="px-3 py-3 align-middle">
                        <span className={`inline-flex rounded border px-2 py-1 ${getStatusClass(row.statusTone)}`}>
                          {row.statusLabel}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-middle text-zinc-400">{row.cleanupLabel}</td>
                      <td className="px-3 py-3 align-middle">
                        <div className="flex justify-end">
                          {row.action === 'clear-cache' ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={isWebMode()}
                              loading={isClearing}
                              onClick={handleClearToolCache}
                              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                            >
                              {dataText.actions.clear}
                            </Button>
                          ) : (
                            <span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">
                              {dataText.actions.noAction}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SettingsSection>

      {isAdmin && (
        <>
          <SettingsSection
            title={dataText.telemetry.title}
            description={dataText.telemetry.description}
          >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 px-3 py-3">
          {telemetrySummary.available ? (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {telemetrySummary.enabled ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">
                  <Activity className="h-3.5 w-3.5" />
                  {dataText.telemetry.running}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-300">
                  <Activity className="h-3.5 w-3.5" />
                  {dataText.telemetry.paused}
                </span>
              )}
              <span className="text-zinc-300">
                {dataText.telemetry.sessionPrefix}
                {(telemetrySummary.sessionCount ?? 0).toLocaleString()}
                {dataText.units.itemSuffix}
              </span>
              <span className="text-zinc-300">
                {dataText.telemetry.storagePrefix}
                {telemetrySummary.storageBytes !== null ? formatDataSize(telemetrySummary.storageBytes) : dataText.telemetry.unknown}
              </span>
              <span className="text-zinc-400">
                {dataText.telemetry.recentPrefix}
                {formatLastEventAt(telemetrySummary.lastEventAt, dataText.telemetry.time)}
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-400">
                <Activity className="h-3.5 w-3.5" />
                {dataText.telemetry.statusUnknown}
              </span>
              <span className="text-zinc-500">
                {dataText.telemetry.callFailedPrefix}
                {telemetrySummary.error || dataText.telemetry.notConnected}
                {dataText.telemetry.callFailedSuffix}
              </span>
            </div>
          )}
        </div>
          </SettingsSection>

          <SettingsDetails
            title={dataText.snapshots.title}
            description={dataText.snapshots.description}
            actions={(
              <span className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
                <Bug className="h-3 w-3" />
                {summary.snapshotCount.toLocaleString()}
                {dataText.units.itemSuffix}
              </span>
            )}
          >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {[
              [dataText.snapshots.countCard, String(snapshotStats?.snapshotCount ?? 0), dataText.snapshots.countCaption],
              [dataText.snapshots.sessionsCard, String(snapshotStats?.sessionCount ?? 0), dataText.snapshots.sessionsCaption],
              [dataText.snapshots.sizeCard, formatDataSize(snapshotStats?.totalBytes ?? 0), dataText.snapshots.sizeCaption],
            ].map(([label, value, caption]) => (
              <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                <div className="mt-1 text-lg font-semibold text-zinc-100">{value}</div>
                <div className="text-[11px] text-zinc-500">{caption}</div>
              </div>
            ))}
          </div>

          <div>
            <label className="mb-2 block text-xs text-zinc-400">{dataText.snapshots.retentionLabel}</label>
            <div className="flex flex-wrap gap-2">
              {RETENTION_OPTIONS.map((option) => {
                const active = (snapshotStats?.retentionDays ?? 1) === option;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => handleRetentionChange(option)}
                    disabled={isWebMode()}
                    className={`rounded border px-3 py-1.5 text-xs transition-colors ${
                      active
                        ? 'border-indigo-500/50 bg-indigo-500/20 text-indigo-200'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-700'
                    } ${isWebMode() ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    {getRetentionOptionLabel(option, dataText.retentionOptions)}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              {dataText.snapshots.retentionHint}
            </p>
          </div>

          <Button
            disabled={isWebMode()}
            onClick={handleClearSnapshots}
            loading={isClearingSnapshots}
            variant="secondary"
            leftIcon={<Trash2 className="h-4 w-4" />}
          >
            {dataText.snapshots.clearButtonPrefix}
            {(snapshotStats?.snapshotCount || 0) > 0 && `(${snapshotStats?.snapshotCount}${dataText.units.itemSuffix})`}
          </Button>
        </div>
          </SettingsDetails>
        </>
      )}
    </SettingsPage>
  );
};
