// ============================================================================
// WorkspaceSettings 呈现辅助 — 从 WorkspaceSettings.tsx 纯结构性拆出（零行为改动）
// 选项表 / 最近目录行构造 / 配置域瓦片与状态样式、label 文案等纯函数
// ============================================================================
import type React from 'react';
import { Database, FolderGit2, LockKeyhole, UserRound } from 'lucide-react';
import type { AppSettings } from '@shared/contract';
import type {
  ConfigSafetyScanSummary,
  ConfigSafetySeverity,
  ConfigScopeItem,
  ConfigScopeItemStatus,
  ConfigScopeLayerId,
  ConfigScopeSummary,
  ConfigWriteRecommendation,
} from '@shared/contract/configScope';
import type { BrowserSessionMode } from '@shared/contract/conversationEnvelope';
import type { BrowserWorkbenchStatusTone } from '../../../../utils/workbenchPresentation';
import { zh } from '../../../../i18n/zh';

export type WorkspaceSettingsText = typeof zh.settings.workspace;

export const BROWSER_OPTIONS: Array<{ value: BrowserSessionMode }> = [
  { value: 'none' },
  { value: 'managed' },
  { value: 'desktop' },
];

export type DefaultOpenTarget = NonNullable<AppSettings['workspace']['defaultOpenTarget']>;

export const DEFAULT_OPEN_OPTIONS: Array<{ value: DefaultOpenTarget }> = [
  { value: 'lastDirectory' },
  { value: 'fixedDirectory' },
  { value: 'askEachTime' },
];

export function describeOpenTarget(
  target: DefaultOpenTarget | undefined,
  labels: WorkspaceSettingsText['openTargets'] = zh.settings.workspace.openTargets,
): string {
  switch (target ?? 'lastDirectory') {
    case 'fixedDirectory':
      return labels.fixedDirectory.label;
    case 'askEachTime':
      return labels.askEachTime.label;
    case 'lastDirectory':
    default:
      return labels.lastDirectory.label;
  }
}

export interface RecentDirRow {
  path: string;
  label: string;
  active: boolean;
}

export interface ConfigScopeTile {
  id: ConfigScopeLayerId;
  label: string;
  value: string;
  caption: string;
  warningCount: number;
}

export function browserStatusToneClass(tone?: BrowserWorkbenchStatusTone): string {
  if (tone === 'ready') return 'text-badge-success';
  if (tone === 'blocked') return 'text-badge-warning';
  return 'text-zinc-300';
}

export function buildRecentRows(currentDir: string | null, recent: string[]): RecentDirRow[] {
  const dedup = new Map<string, RecentDirRow>();
  if (currentDir) {
    dedup.set(currentDir, {
      path: currentDir,
      label: currentDir.split('/').filter(Boolean).pop() || currentDir,
      active: true,
    });
  }
  for (const dir of recent) {
    if (dedup.has(dir)) continue;
    dedup.set(dir, {
      path: dir,
      label: dir.split('/').filter(Boolean).pop() || dir,
      active: false,
    });
  }
  return Array.from(dedup.values());
}

export function buildConfigScopeTiles(summary: ConfigScopeSummary | null): ConfigScopeTile[] {
  if (!summary) return [];
  return summary.layers.map((layer) => ({
    id: layer.id,
    label: layer.label,
    value: `${layer.activeCount}/${layer.items.length}`,
    caption: layer.pathLabel,
    warningCount: layer.warningCount,
  }));
}

export function scopeStatusClass(status: ConfigScopeItemStatus): string {
  if (status === 'active') return 'border-badge-success/30 bg-emerald-500/10 text-badge-success';
  if (status === 'warning') return 'border-badge-warning/30 bg-amber-500/10 text-badge-warning';
  if (status === 'present') return 'border-badge-info/30 bg-blue-500/10 text-badge-info';
  return 'border-zinc-700 bg-zinc-900 text-zinc-500';
}

export function scopeStatusLabel(
  item: ConfigScopeItem,
  labels: WorkspaceSettingsText['scopeStatus'] = zh.settings.workspace.scopeStatus,
): string {
  if (item.status === 'warning') return labels.warning;
  if (item.status === 'active') return labels.active;
  if (item.status === 'present') return item.active ? labels.active : labels.presentOnly;
  return labels.missing;
}

export function scopeIcon(layerId: ConfigScopeLayerId): React.ReactNode {
  if (layerId === 'user') return <UserRound className="h-4 w-4" />;
  if (layerId === 'project') return <FolderGit2 className="h-4 w-4" />;
  if (layerId === 'local') return <LockKeyhole className="h-4 w-4" />;
  return <Database className="h-4 w-4" />;
}

export function scopeLayerLabel(
  layerId: ConfigScopeLayerId,
  labels: WorkspaceSettingsText['scopeLayers'] = zh.settings.workspace.scopeLayers,
): string {
  if (layerId === 'user') return labels.user;
  if (layerId === 'project') return labels.project;
  if (layerId === 'local') return labels.local;
  return labels.runtime;
}

export function scopeLayerClass(layerId: ConfigScopeLayerId): string {
  if (layerId === 'user') return 'border-badge-info/30 bg-blue-500/10 text-badge-info';
  if (layerId === 'project') return 'border-badge-success/30 bg-emerald-500/10 text-badge-success';
  if (layerId === 'local') return 'border-badge-warning/30 bg-amber-500/10 text-badge-warning';
  return 'border-zinc-600 bg-zinc-800 text-zinc-300';
}

export function shareabilityLabel(
  recommendation: ConfigWriteRecommendation,
  labels: WorkspaceSettingsText['shareability'] = zh.settings.workspace.shareability,
): string {
  if (recommendation.shareability === 'team-shareable') return labels.teamShareable;
  if (recommendation.shareability === 'local-only') return labels.localOnly;
  if (recommendation.shareability === 'runtime-private') return labels.runtimePrivate;
  return labels.personalPrivate;
}

export function safetySeverityClass(severity: ConfigSafetySeverity): string {
  if (severity === 'critical') return 'border-red-500/30 bg-red-500/10 text-badge-danger';
  if (severity === 'warning') return 'border-badge-warning/30 bg-amber-500/10 text-badge-warning';
  return 'border-badge-info/30 bg-blue-500/10 text-badge-info';
}

export function safetySeverityLabel(
  severity: ConfigSafetySeverity,
  labels: WorkspaceSettingsText['safetySeverity'] = zh.settings.workspace.safetySeverity,
): string {
  if (severity === 'critical') return labels.critical;
  if (severity === 'warning') return labels.warning;
  return labels.info;
}

export function safetyStatusText(
  scan: ConfigSafetyScanSummary,
  labels: WorkspaceSettingsText['safetyStatus'] = zh.settings.workspace.safetyStatus,
): string {
  if (scan.status === 'no_workspace') return labels.noWorkspace;
  if (scan.totalFindings === 0) return labels.noFindings;
  if (scan.criticalCount > 0) return labels.needsAction;
  return labels.needsReview;
}
