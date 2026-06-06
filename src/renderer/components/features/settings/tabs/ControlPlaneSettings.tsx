// ============================================================================
// ControlPlaneSettings - admin release/audit ledger
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type {
  AdminControlPlaneAuditEventItem,
  AdminControlPlaneAuditEventListResult,
  AdminControlPlaneRolloutSummaryItem,
  AdminControlPlaneRolloutSummaryResult,
} from '@shared/contract';
import { Button } from '../../../primitives';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import ipcService from '../../../../services/ipcService';

const ARTIFACT_LABELS: Record<AdminControlPlaneAuditEventItem['artifactKind'], string> = {
  cloud_config: '云配置',
  capability_registry: '能力注册表',
  agent_engine_model_catalog: 'Agent Engine 模型目录',
  prompt_registry: '提示词注册表',
  update_manifest: '更新清单',
  runtime_assets_manifest: '运行时资产清单',
  renderer_bundle: '前端热更包',
  renderer_bundle_rollout: '前端热更灰度策略',
};

const OUTCOME_CLASSES: Record<AdminControlPlaneAuditEventItem['outcome'], string> = {
  served: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  not_modified: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  head: 'border-zinc-600 bg-zinc-800 text-zinc-300',
  error: 'border-red-500/30 bg-red-500/10 text-red-300',
};

function formatDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function shortHash(value?: string): string {
  if (!value) return '-';
  return value.length > 22 ? `${value.slice(0, 18)}...${value.slice(-6)}` : value;
}

function releaseLabel(item: Pick<AdminControlPlaneAuditEventItem, 'payloadVersion' | 'releaseChannel'>): string {
  const parts = [item.payloadVersion, item.releaseChannel].filter(Boolean);
  return parts.length ? parts.join(' / ') : '-';
}

const SummaryTile: React.FC<{
  item: AdminControlPlaneRolloutSummaryItem;
}> = ({ item }) => (
  <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm font-medium text-zinc-100">{ARTIFACT_LABELS[item.artifactKind]}</div>
      <span className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300">
        {item.releaseChannel || 'n/a'}
      </span>
    </div>
    <div className="mt-2 font-mono text-xs text-zinc-400">{item.payloadVersion || '-'}</div>
    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
      <div>
        <div className="text-zinc-500">成功</div>
        <div className="mt-1 text-base font-semibold text-emerald-300">{item.servedCount}</div>
      </div>
      <div>
        <div className="text-zinc-500">错误</div>
        <div className="mt-1 text-base font-semibold text-red-300">{item.errorCount}</div>
      </div>
    </div>
    <div className="mt-3 truncate font-mono text-[11px] text-zinc-500" title={item.contentHash}>
      {shortHash(item.contentHash)}
    </div>
  </div>
);

export const ControlPlaneSettings: React.FC = () => {
  const [events, setEvents] = useState<AdminControlPlaneAuditEventItem[]>([]);
  const [summary, setSummary] = useState<AdminControlPlaneRolloutSummaryItem[]>([]);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [eventResult, summaryResult] = await Promise.all([
        ipcService.invokeDomain<AdminControlPlaneAuditEventListResult>(
          IPC_DOMAINS.ADMIN,
          'listControlPlaneAuditEvents',
          { limit: 80 },
        ),
        ipcService.invokeDomain<AdminControlPlaneRolloutSummaryResult>(
          IPC_DOMAINS.ADMIN,
          'listControlPlaneRolloutSummary',
        ),
      ]);
      setEvents(eventResult.events);
      setSummary(summaryResult.items);
      setUnavailableReason(eventResult.unavailableReason || summaryResult.unavailableReason || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const latestVersion = useMemo(() => {
    return events.find((event) => event.payloadVersion)?.payloadVersion || '-';
  }, [events]);

  return (
    <SettingsPage
      title="控制平面"
      description="线上签名配置、能力 registry 和发布审计留痕。"
    >
      <SettingsSection
        title="发布状态"
        actions={(
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={loadData}
            loading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            刷新
          </Button>
        )}
      >
        <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <ShieldCheck className="h-4 w-4 text-emerald-300" />
          <div>
            <div className="text-sm font-medium text-zinc-100">最新版本 {latestVersion}</div>
            <div className="mt-1 text-xs text-zinc-500">审计数据来自 Supabase admin RPC，production env 缺省时页面显示为空。</div>
          </div>
        </div>

        {unavailableReason && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{unavailableReason}</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-3">
          {summary.slice(0, 6).map((item) => (
            <SummaryTile
              key={`${item.artifactKind}:${item.payloadVersion || ''}:${item.contentHash || ''}`}
              item={item}
            />
          ))}
          {summary.length === 0 && (
            <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50 px-4 py-8 text-center text-xs text-zinc-500 md:col-span-3">
              暂无 control-plane 审计事件
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="最近事件">
        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-xs">
              <thead className="bg-zinc-900/80 text-zinc-500">
                <tr>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">时间</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Artifact</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">版本</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Key</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Hash</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">结果</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Subject</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Entitlement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 bg-zinc-950/40 text-zinc-300">
                {events.map((event) => (
                  <tr key={event.id} className="hover:bg-zinc-900/60">
                    <td className="whitespace-nowrap px-3 py-3 text-zinc-400">{formatDate(event.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-3 font-medium text-zinc-100">
                      {ARTIFACT_LABELS[event.artifactKind]}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 font-mono text-zinc-400">{releaseLabel(event)}</td>
                    <td className="whitespace-nowrap px-3 py-3 font-mono text-zinc-500">{event.keyId || '-'}</td>
                    <td className="whitespace-nowrap px-3 py-3 font-mono text-zinc-500" title={event.contentHash}>
                      {shortHash(event.contentHash)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className={`inline-block whitespace-nowrap rounded-md border px-2 py-1 text-[11px] ${OUTCOME_CLASSES[event.outcome]}`}>
                        {event.outcome} · {event.statusCode}
                      </span>
                    </td>
                    <td className="px-3 py-3 font-mono text-zinc-500">
                      <div
                        className="max-w-[220px] truncate"
                        title={`${event.subjectId || '-'}${event.subjectSource ? ` (${event.subjectSource})` : ''}`}
                      >
                        {event.subjectId || '-'}
                        {event.subjectSource ? <span className="ml-1 text-zinc-600">({event.subjectSource})</span> : null}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-zinc-400">
                      {event.entitlementStatus || '-'}
                      {event.entitlementPlan ? <span className="ml-1 text-zinc-600">/ {event.entitlementPlan}</span> : null}
                      {event.entitlementReason ? (
                        <div className="mt-1 max-w-[200px] truncate text-[11px] text-zinc-600" title={event.entitlementReason}>
                          {event.entitlementReason}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {events.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-zinc-500">
                      暂无事件
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SettingsSection>
    </SettingsPage>
  );
};
