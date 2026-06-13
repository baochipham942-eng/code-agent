import React, { useCallback, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  AlmaRegistryAuditRefreshResult,
  AlmaRegistryDriftReport,
} from '@shared/constants/almaRegistryAudit';
import ipcService from '../../../../services/ipcService';
import { Button } from '../../../primitives';

type AuditRefreshResult = {
  success: boolean;
  data?: AlmaRegistryAuditRefreshResult;
  error?: string;
};

function formatDrift(report: AlmaRegistryDriftReport): string {
  if (report.status === 'unchanged') {
    return '无漂移';
  }
  const parts: string[] = [];
  if (report.addedFeaturedIds.length) {
    parts.push(`新增 featured: ${report.addedFeaturedIds.join(', ')}`);
  }
  if (report.removedFeaturedIds.length) {
    parts.push(`移除 featured: ${report.removedFeaturedIds.join(', ')}`);
  }
  if (report.defaultFlagMatches.length) {
    parts.push(`发现 default/builtin 标记: ${report.defaultFlagMatches.join(', ')}`);
  }
  return parts.length ? parts.join(' · ') : `字段变化: ${report.changedFields.join(', ')}`;
}

function getDriftTone(report: AlmaRegistryDriftReport): string {
  return report.status === 'unchanged'
    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
    : 'border-amber-500/20 bg-amber-500/10 text-amber-200';
}

export const AlmaRegistryAuditPanel: React.FC = () => {
  const [result, setResult] = useState<AlmaRegistryAuditRefreshResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await ipcService.invoke(IPC_CHANNELS.ALMA_REGISTRY_AUDIT_REFRESH) as AuditRefreshResult;
      if (!response?.success || !response.data) {
        throw new Error(response?.error || '刷新 Alma registry audit 失败');
      }
      setResult(response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const mcpDrift = result?.mcp.drift;
  const pluginDrift = result?.plugin.drift;
  const driftRows = result && mcpDrift && pluginDrift
    ? [
        { label: 'MCP', featuredCount: result.mcp.current.featuredIds.length, drift: mcpDrift },
        { label: 'Plugin', featuredCount: result.plugin.current.featuredIds.length, drift: pluginDrift },
      ]
    : [];

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-medium text-zinc-200">Alma registry 审计</div>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            手动拉取官方 MCP / Plugin registry，只生成漂移报告，不自动更新推荐或安装配置。
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void refresh()}
          loading={loading}
          leftIcon={!loading ? <RefreshCw className="h-3.5 w-3.5" /> : undefined}
        >
          刷新审计
        </Button>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && mcpDrift && pluginDrift && (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {driftRows.map(({ label, featuredCount, drift }) => (
            <div key={label} className={`rounded-md border px-3 py-2 text-xs ${getDriftTone(drift)}`}>
              <div className="flex items-center gap-1.5 font-medium">
                {drift.status === 'unchanged'
                  ? <CheckCircle2 className="h-3.5 w-3.5" />
                  : <AlertTriangle className="h-3.5 w-3.5" />}
                {label} · featured {featuredCount}
              </div>
              <div className="mt-1 leading-5">{formatDrift(drift)}</div>
            </div>
          ))}
          <div className="md:col-span-2 text-[11px] text-zinc-600">
            fetchedAt {result.fetchedAt}
          </div>
        </div>
      )}
    </div>
  );
};
