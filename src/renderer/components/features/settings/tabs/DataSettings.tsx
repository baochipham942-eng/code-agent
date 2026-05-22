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

const logger = createLogger('DataSettings');

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

const RETENTION_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: '1 天' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: -1, label: '永久' },
];

export function formatDataSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getRetentionLabel(days: number): string {
  return RETENTION_OPTIONS.find((option) => option.value === days)?.label ?? '1 天';
}

export function buildDataManagementSummary(
  stats: DataStats | null,
  snapshotStats: SnapshotStats | null,
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
    retentionLabel: getRetentionLabel(safeSnapshotStats.retentionDays),
  };
}

export function buildDataManagementRows(stats: DataStats | null): DataManagementRow[] {
  const safeStats = stats ?? EMPTY_DATA_STATS;

  return [
    {
      id: 'sessions',
      title: '会话',
      description: '本地会话索引和历史工作线程。',
      valueLabel: `${safeStats.sessionCount.toLocaleString()} 条`,
      statusLabel: '保留',
      statusTone: 'stable',
      cleanupLabel: '不清理',
      action: 'none',
    },
    {
      id: 'messages',
      title: '消息',
      description: '对话消息与上下文记录。',
      valueLabel: `${safeStats.messageCount.toLocaleString()} 条`,
      statusLabel: '保留',
      statusTone: 'stable',
      cleanupLabel: '不清理',
      action: 'none',
    },
    {
      id: 'tool-executions',
      title: '工具执行缓存',
      description: '工具调用结果的短期缓存，用于复用和排查。',
      valueLabel: `${safeStats.toolExecutionCount.toLocaleString()} 条`,
      statusLabel: safeStats.toolExecutionCount > 0 ? '缓存' : '干净',
      statusTone: 'info',
      cleanupLabel: '随运行缓存',
      action: 'none',
    },
    {
      id: 'knowledge',
      title: '项目知识库',
      description: '工作区知识、索引和可复用材料。',
      valueLabel: `${safeStats.knowledgeCount.toLocaleString()} 条`,
      statusLabel: '保留',
      statusTone: 'info',
      cleanupLabel: '不清理',
      action: 'none',
    },
    {
      id: 'database',
      title: '数据库文件',
      description: '本机应用数据库占用。',
      valueLabel: formatDataSize(safeStats.databaseSize),
      statusLabel: '本地',
      statusTone: 'info',
      cleanupLabel: '只查看',
      action: 'none',
    },
    {
      id: 'cache',
      title: '运行缓存',
      description: '内存工具缓存与持久化工具结果缓存，可在异常时清理后重建。',
      valueLabel: `${safeStats.cacheEntries.toLocaleString()} 条`,
      statusLabel: safeStats.cacheEntries > 0 ? '可清理' : '干净',
      statusTone: safeStats.cacheEntries > 0 ? 'warning' : 'stable',
      cleanupLabel: '清空缓存',
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

function formatLastEventAt(ts: number | null): string {
  if (!ts) return '暂无事件';
  const delta = Date.now() - ts;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleString();
}

export const DataSettings: React.FC = () => {
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
        error: error instanceof Error ? error.message : '未知错误',
      });
    }
  }, [isAdmin]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const dataRows = useMemo(() => buildDataManagementRows(stats), [stats]);
  const summary = useMemo(
    () => buildDataManagementSummary(stats, snapshotStats),
    [snapshotStats, stats],
  );
  const persistenceWarningText = getPersistenceWarningText(persistenceHealth);
  const summaryCards = useMemo(() => {
    const cards = [
      ['会话', summary.sessionCount.toLocaleString(), `${summary.messageCount.toLocaleString()} 条消息`],
      ['数据库', summary.databaseSizeLabel, '本机应用数据'],
      ['运行缓存', summary.cacheEntries.toLocaleString(), '可按需清理'],
    ];
    if (isAdmin) {
      cards.push([
        '调试快照',
        summary.snapshotCount.toLocaleString(),
        `${summary.snapshotSizeLabel} / ${summary.retentionLabel}`,
      ]);
    }
    return cards;
  }, [isAdmin, summary]);

  const handleClearSnapshots = async () => {
    if (!isAdmin) return;
    setIsClearingSnapshots(true);
    setMessage(null);
    try {
      const cleared = await ipcService.invokeDomain<number>(IPC_DOMAINS.DATA, 'clearSnapshots', {});
      setMessage({
        type: 'success',
        text: cleared && cleared > 0 ? `已清空 ${cleared} 条调试快照` : '没有可清理的快照',
      });
      await loadStats();
    } catch {
      setMessage({ type: 'error', text: '清理失败' });
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
        text: cleared === 0 ? '缓存已经是空的' : `已清理 ${cleared} 条本地缓存记录`,
      });
      await loadStats();
    } catch {
      setMessage({ type: 'error', text: '清理失败' });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <SettingsPage
      title="数据与存储"
      description="查看本机数据、运行缓存和调试快照。会话、消息和知识库默认保留。"
    >
      <WebModeBanner />

      {shouldShowPersistenceWarning(persistenceHealth) && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">历史持久化不可用</div>
            <div className="mt-0.5 text-xs text-amber-200/80">
              {persistenceWarningText}
              {persistenceHealth.reason ? ` 原因：${persistenceHealth.reason}` : ''}
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
        title="数据控制面"
        description="日常只看会话、消息、数据库大小和可清理缓存；调试快照放在高级区。"
        actions={(
          <Button
            size="sm"
            variant="secondary"
            onClick={loadStats}
            disabled={isLoading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            刷新
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
                  <th className="px-3 py-2 font-medium">数据对象</th>
                  <th className="px-3 py-2 font-medium">数量 / 占用</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">清理策略</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">
                      <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                      加载中...
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
                              清空
                            </Button>
                          ) : (
                            <span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">
                              -
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
            title="Telemetry 健康"
            description="Agent 内部遥测的采集状态摘要。详细分析请进入「内部评测」面板。"
          >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 px-3 py-3">
          {telemetrySummary.available ? (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {telemetrySummary.enabled ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">
                  <Activity className="h-3.5 w-3.5" />
                  采集运行中
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-300">
                  <Activity className="h-3.5 w-3.5" />
                  采集已暂停
                </span>
              )}
              <span className="text-zinc-300">
                session：{(telemetrySummary.sessionCount ?? 0).toLocaleString()} 条
              </span>
              <span className="text-zinc-300">
                占用：{telemetrySummary.storageBytes !== null ? formatDataSize(telemetrySummary.storageBytes) : '未知'}
              </span>
              <span className="text-zinc-400">
                最近事件：{formatLastEventAt(telemetrySummary.lastEventAt)}
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-400">
                <Activity className="h-3.5 w-3.5" />
                采集状态未知
              </span>
              <span className="text-zinc-500">
                telemetry:health 调用失败（{telemetrySummary.error || '未连接'}）。
              </span>
            </div>
          )}
        </div>
          </SettingsSection>

          <SettingsDetails
            title="调试快照"
            description="用于 debug session 和上下文排查，默认折叠在高级区。清空不会影响会话消息。"
            actions={(
              <span className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
                <Bug className="h-3 w-3" />
                {summary.snapshotCount.toLocaleString()} 条
              </span>
            )}
          >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {[
              ['快照数', String(snapshotStats?.snapshotCount ?? 0), 'turn + compaction'],
              ['覆盖 session', String(snapshotStats?.sessionCount ?? 0), '用于回放排查'],
              ['占用', formatDataSize(snapshotStats?.totalBytes ?? 0), '本机数据库内'],
            ].map(([label, value, caption]) => (
              <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                <div className="mt-1 text-lg font-semibold text-zinc-100">{value}</div>
                <div className="text-[11px] text-zinc-500">{caption}</div>
              </div>
            ))}
          </div>

          <div>
            <label className="mb-2 block text-xs text-zinc-400">保留时长</label>
            <div className="flex flex-wrap gap-2">
              {RETENTION_OPTIONS.map((option) => {
                const active = (snapshotStats?.retentionDays ?? 1) === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleRetentionChange(option.value)}
                    disabled={isWebMode()}
                    className={`rounded border px-3 py-1.5 text-xs transition-colors ${
                      active
                        ? 'border-indigo-500/50 bg-indigo-500/20 text-indigo-200'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-700'
                    } ${isWebMode() ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              启动时自动清理超出保留时长的快照；「永久」表示禁用自动清理。
            </p>
          </div>

          <Button
            disabled={isWebMode()}
            onClick={handleClearSnapshots}
            loading={isClearingSnapshots}
            variant="secondary"
            leftIcon={<Trash2 className="h-4 w-4" />}
          >
            清空调试快照 {(snapshotStats?.snapshotCount || 0) > 0 && `(${snapshotStats?.snapshotCount} 条)`}
          </Button>
        </div>
          </SettingsDetails>
        </>
      )}
    </SettingsPage>
  );
};
