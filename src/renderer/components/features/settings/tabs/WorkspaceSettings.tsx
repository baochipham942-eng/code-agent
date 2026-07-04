// ============================================================================
// WorkspaceSettings - 工作区与本地桥设置 tab
// ============================================================================
//
// P1 IA：把"当前工作区 / 最近目录 / 本地桥 / Browser 默认模式"集中到一个 tab。
// Browser 模式从 ConversationSettings 迁移过来，复用 composerStore.browserSessionMode。
// 最近目录通过 workspace:listRecent IPC 拉取，切换/选择目录时会回写
// settings.workspace.recentDirectories（main 侧 setCurrent/selectDirectory 走
// configService.addRecentDirectory），表格行的"移除"调用 removeRecent。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Clock,
  Database,
  ExternalLink,
  Folder,
  FolderGit2,
  FolderOpen,
  Globe,
  Info,
  LockKeyhole,
  Monitor,
  Plug,
  RefreshCw,
  UserRound,
  X,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import type {
  ConfigSafetyScanSummary,
  ConfigSafetySeverity,
  ConfigScopeItem,
  ConfigScopeItemStatus,
  ConfigScopeLayer,
  ConfigScopeLayerId,
  ConfigScopeSummary,
  ConfigWriteRecommendation,
} from '@shared/contract/configScope';
import type { BrowserSessionMode } from '@shared/contract/conversationEnvelope';
import { Button } from '../../../primitives';
import { useComposerStore } from '../../../../stores/composerStore';
import { useWorkbenchBrowserSession } from '../../../../hooks/useWorkbenchBrowserSession';
import {
  buildBrowserWorkbenchStatusRows,
  getBrowserWorkbenchOperationalHint,
  type BrowserWorkbenchStatusTone,
} from '../../../../utils/workbenchPresentation';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';
import { getDesktopShellLabel, isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import { createLogger } from '../../../../utils/logger';
import ipcService from '../../../../services/ipcService';

const logger = createLogger('WorkspaceSettings');

type WorkspaceSettingsText = typeof zh.settings.workspace;

const BROWSER_OPTIONS: Array<{ value: BrowserSessionMode }> = [
  { value: 'none' },
  { value: 'managed' },
  { value: 'desktop' },
];

type DefaultOpenTarget = NonNullable<AppSettings['workspace']['defaultOpenTarget']>;

const DEFAULT_OPEN_OPTIONS: Array<{ value: DefaultOpenTarget }> = [
  { value: 'lastDirectory' },
  { value: 'fixedDirectory' },
  { value: 'askEachTime' },
];

function describeOpenTarget(
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

interface RecentDirRow {
  path: string;
  label: string;
  active: boolean;
}

interface ConfigScopeTile {
  id: ConfigScopeLayerId;
  label: string;
  value: string;
  caption: string;
  warningCount: number;
}

function browserStatusToneClass(tone?: BrowserWorkbenchStatusTone): string {
  if (tone === 'ready') return 'text-emerald-300';
  if (tone === 'blocked') return 'text-amber-300';
  return 'text-zinc-300';
}

function buildRecentRows(currentDir: string | null, recent: string[]): RecentDirRow[] {
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

function scopeStatusClass(status: ConfigScopeItemStatus): string {
  if (status === 'active') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (status === 'warning') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  if (status === 'present') return 'border-blue-500/30 bg-blue-500/10 text-blue-300';
  return 'border-zinc-700 bg-zinc-900 text-zinc-500';
}

function scopeStatusLabel(
  item: ConfigScopeItem,
  labels: WorkspaceSettingsText['scopeStatus'] = zh.settings.workspace.scopeStatus,
): string {
  if (item.status === 'warning') return labels.warning;
  if (item.status === 'active') return labels.active;
  if (item.status === 'present') return item.active ? labels.active : labels.presentOnly;
  return labels.missing;
}

function scopeIcon(layerId: ConfigScopeLayerId): React.ReactNode {
  if (layerId === 'user') return <UserRound className="h-4 w-4" />;
  if (layerId === 'project') return <FolderGit2 className="h-4 w-4" />;
  if (layerId === 'local') return <LockKeyhole className="h-4 w-4" />;
  return <Database className="h-4 w-4" />;
}

function scopeLayerLabel(
  layerId: ConfigScopeLayerId,
  labels: WorkspaceSettingsText['scopeLayers'] = zh.settings.workspace.scopeLayers,
): string {
  if (layerId === 'user') return labels.user;
  if (layerId === 'project') return labels.project;
  if (layerId === 'local') return labels.local;
  return labels.runtime;
}

function scopeLayerClass(layerId: ConfigScopeLayerId): string {
  if (layerId === 'user') return 'border-blue-500/30 bg-blue-500/10 text-blue-300';
  if (layerId === 'project') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (layerId === 'local') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-zinc-600 bg-zinc-800 text-zinc-300';
}

function shareabilityLabel(
  recommendation: ConfigWriteRecommendation,
  labels: WorkspaceSettingsText['shareability'] = zh.settings.workspace.shareability,
): string {
  if (recommendation.shareability === 'team-shareable') return labels.teamShareable;
  if (recommendation.shareability === 'local-only') return labels.localOnly;
  if (recommendation.shareability === 'runtime-private') return labels.runtimePrivate;
  return labels.personalPrivate;
}

function safetySeverityClass(severity: ConfigSafetySeverity): string {
  if (severity === 'critical') return 'border-red-500/30 bg-red-500/10 text-red-300';
  if (severity === 'warning') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-blue-500/30 bg-blue-500/10 text-blue-300';
}

function safetySeverityLabel(
  severity: ConfigSafetySeverity,
  labels: WorkspaceSettingsText['safetySeverity'] = zh.settings.workspace.safetySeverity,
): string {
  if (severity === 'critical') return labels.critical;
  if (severity === 'warning') return labels.warning;
  return labels.info;
}

function safetyStatusText(
  scan: ConfigSafetyScanSummary,
  labels: WorkspaceSettingsText['safetyStatus'] = zh.settings.workspace.safetyStatus,
): string {
  if (scan.status === 'no_workspace') return labels.noWorkspace;
  if (scan.totalFindings === 0) return labels.noFindings;
  if (scan.criticalCount > 0) return labels.needsAction;
  return labels.needsReview;
}

export const WorkspaceSettings: React.FC = () => {
  const { t } = useI18n();
  const workspaceText = t.settings.workspace;
  const browserSessionMode = useComposerStore((s) => s.browserSessionMode);
  const setBrowserSessionMode = useComposerStore((s) => s.setBrowserSessionMode);
  const browserSession = useWorkbenchBrowserSession();

  const [currentDir, setCurrentDir] = useState<string | null>(null);
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDetail, setSelectedDetail] = useState<RecentDirRow | null>(null);
  const [defaultOpenTarget, setDefaultOpenTargetState] = useState<DefaultOpenTarget>('lastDirectory');
  const [pinnedDirectory, setPinnedDirectoryState] = useState<string | null>(null);
  const [savingPreference, setSavingPreference] = useState(false);
  const [configScope, setConfigScope] = useState<ConfigScopeSummary | null>(null);

  const browserStatusRows = useMemo(
    () => buildBrowserWorkbenchStatusRows({ mode: browserSessionMode, browserSession }),
    [browserSession, browserSessionMode],
  );
  const browserOperationalHint = useMemo(
    () => getBrowserWorkbenchOperationalHint({ mode: browserSessionMode, browserSession }),
    [browserSession, browserSessionMode],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dir, recent, settings, scope] = await Promise.all([
        ipcService.invokeDomain<string | null>(IPC_DOMAINS.WORKSPACE, 'getCurrent'),
        ipcService.invokeDomain<string[]>(IPC_DOMAINS.WORKSPACE, 'listRecent'),
        ipcService.invokeDomain<AppSettings | undefined>(IPC_DOMAINS.SETTINGS, 'get'),
        ipcService.invokeDomain<ConfigScopeSummary>(IPC_DOMAINS.WORKSPACE, 'getConfigScope'),
      ]);
      setCurrentDir(dir ?? null);
      setRecentDirs(Array.isArray(recent) ? recent : []);
      setDefaultOpenTargetState(settings?.workspace?.defaultOpenTarget ?? 'lastDirectory');
      setPinnedDirectoryState(settings?.workspace?.pinnedDirectory ?? null);
      setConfigScope(scope ?? null);
    } catch (error) {
      logger.error('Failed to load workspace settings', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => buildRecentRows(currentDir, recentDirs), [currentDir, recentDirs]);
  const configScopeTiles = useMemo(() => buildConfigScopeTiles(configScope), [configScope]);
  const browserOptions = useMemo(
    () => BROWSER_OPTIONS.map((option) => ({
      ...option,
      label: workspaceText.browserOptions[option.value].label,
      hint: workspaceText.browserOptions[option.value].hint,
    })),
    [workspaceText],
  );
  const defaultOpenOptions = useMemo(
    () => DEFAULT_OPEN_OPTIONS.map((option) => ({
      ...option,
      label: workspaceText.openTargets[option.value].label,
      hint: workspaceText.openTargets[option.value].hint,
    })),
    [workspaceText],
  );

  const handleReveal = useCallback(async (path: string) => {
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.WORKSPACE, 'showItemInFolder', { filePath: path });
    } catch (error) {
      logger.error('Failed to reveal in Finder', error);
    }
  }, []);

  const handlePickDirectory = useCallback(async () => {
    try {
      const next = await ipcService.invokeDomain<string | null>(IPC_DOMAINS.WORKSPACE, 'selectDirectory');
      if (next) {
        setCurrentDir(next);
        await load();
      }
    } catch (error) {
      logger.error('Failed to pick directory', error);
    }
  }, [load]);

  const handleSwitchTo = useCallback(async (path: string) => {
    try {
      await ipcService.invokeDomain<string | null>(IPC_DOMAINS.WORKSPACE, 'setCurrent', { dir: path });
      await load();
    } catch (error) {
      logger.error('Failed to switch workspace', error);
    }
  }, [load]);

  const handleRemoveRecent = useCallback(async (path: string) => {
    try {
      const next = await ipcService.invokeDomain<string[]>(IPC_DOMAINS.WORKSPACE, 'removeRecent', { dir: path });
      setRecentDirs(Array.isArray(next) ? next : []);
    } catch (error) {
      logger.error('Failed to remove recent directory', error);
    }
  }, []);

  const persistWorkspacePreference = useCallback(async (patch: {
    defaultOpenTarget?: DefaultOpenTarget;
    pinnedDirectory?: string | null;
  }) => {
    setSavingPreference(true);
    try {
      const current = await ipcService.invokeDomain<AppSettings | undefined>(IPC_DOMAINS.SETTINGS, 'get');
      const nextWorkspace = {
        ...(current?.workspace ?? { recentDirectories: [] }),
        ...(patch.defaultOpenTarget !== undefined ? { defaultOpenTarget: patch.defaultOpenTarget } : {}),
        ...(patch.pinnedDirectory !== undefined
          ? patch.pinnedDirectory
            ? { pinnedDirectory: patch.pinnedDirectory }
            : { pinnedDirectory: undefined }
          : {}),
      };
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', { workspace: nextWorkspace });
    } catch (error) {
      logger.error('Failed to persist workspace preference', error);
    } finally {
      setSavingPreference(false);
    }
  }, []);

  const handleSelectOpenTarget = useCallback(async (value: DefaultOpenTarget) => {
    setDefaultOpenTargetState(value);
    await persistWorkspacePreference({ defaultOpenTarget: value });
  }, [persistWorkspacePreference]);

  const handlePickPinnedDirectory = useCallback(async () => {
    try {
      const next = await ipcService.invokeDomain<string | null>(IPC_DOMAINS.WORKSPACE, 'selectDirectory');
      if (next) {
        setPinnedDirectoryState(next);
        await persistWorkspacePreference({ pinnedDirectory: next });
      }
    } catch (error) {
      logger.error('Failed to pick pinned directory', error);
    }
  }, [persistWorkspacePreference]);

  const handleClearPinnedDirectory = useCallback(async () => {
    setPinnedDirectoryState(null);
    await persistWorkspacePreference({ pinnedDirectory: null });
  }, [persistWorkspacePreference]);

  return (
    <SettingsPage
      title={t.settings.tabs.workspace}
      description={workspaceText.description}
    >
      <WebModeBanner />

      <SettingsSection
        title={workspaceText.currentWorkspace.title}
        description={workspaceText.currentWorkspace.description}
        actions={(
          <Button
            size="sm"
            variant="secondary"
            disabled={isWebMode()}
            onClick={handlePickDirectory}
            leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
          >
            {workspaceText.actions.chooseDirectory}
          </Button>
        )}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 lg:grid-cols-4">
            {[
              [workspaceText.summary.currentCwd, currentDir ?? workspaceText.values.notSet, workspaceText.summary.currentCwdCaption],
              [workspaceText.summary.defaultOpenTarget, describeOpenTarget(defaultOpenTarget, workspaceText.openTargets), workspaceText.summary.defaultOpenTargetCaption],
              [workspaceText.summary.localBridge, getDesktopShellLabel(), isWebMode() ? workspaceText.summary.localBridgeWebCaption : workspaceText.summary.localBridgeIpcCaption],
              [workspaceText.summary.recentCount, String(rows.length), workspaceText.summary.recentCountCaption],
            ].map(([label, value, caption]) => (
              <div key={label} className="bg-zinc-900/80 px-3 py-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                <div className="mt-1 truncate text-sm font-semibold text-zinc-100" title={value}>{value}</div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-500">{caption}</div>
              </div>
            ))}
          </div>
          {currentDir && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-400">
              <Folder className="h-3.5 w-3.5 text-zinc-500" />
              <span className="flex-1 truncate font-mono" title={currentDir}>{currentDir}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={isWebMode()}
                onClick={() => handleReveal(currentDir)}
                leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
              >
                {workspaceText.actions.revealInFinder}
              </Button>
            </div>
          )}

          <div className="border-t border-zinc-700/60 px-3 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">
                  {workspaceText.defaultOpenTarget.title}
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-500">
                  {workspaceText.defaultOpenTarget.description}
                </div>
              </div>
              {savingPreference && <span className="text-[11px] text-zinc-500">{workspaceText.saving}</span>}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {defaultOpenOptions.map((opt) => {
                const selected = defaultOpenTarget === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSelectOpenTarget(opt.value)}
                    disabled={isWebMode() || savingPreference}
                    className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                      selected
                        ? 'border-zinc-500 bg-zinc-800/70 text-zinc-100'
                        : 'border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/[0.16] hover:bg-white/[0.04]'
                    } ${isWebMode() ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    <span className="text-sm font-medium">{opt.label}</span>
                    <span className="text-[11px] leading-relaxed text-zinc-500">{opt.hint}</span>
                  </button>
                );
              })}
            </div>
            {defaultOpenTarget === 'fixedDirectory' && (
              <div className="mt-3 flex items-center gap-2 rounded border border-zinc-700/60 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300">
                <Folder className="h-3.5 w-3.5 text-zinc-500" />
                <span className="flex-1 truncate font-mono" title={pinnedDirectory ?? ''}>
                  {pinnedDirectory || workspaceText.values.noPinnedDirectory}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isWebMode() || savingPreference}
                  onClick={handlePickPinnedDirectory}
                  leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
                >
                  {pinnedDirectory ? workspaceText.actions.change : workspaceText.actions.chooseDirectory}
                </Button>
                {pinnedDirectory && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isWebMode() || savingPreference}
                    onClick={handleClearPinnedDirectory}
                    leftIcon={<X className="h-3.5 w-3.5" />}
                  >
                    {workspaceText.actions.clear}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={workspaceText.configScope.title}
        description={workspaceText.configScope.description}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 lg:grid-cols-4">
            {configScopeTiles.length > 0 ? configScopeTiles.map((tile) => (
              <div key={tile.id} className="bg-zinc-900/80 px-3 py-3">
                <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">
                  {scopeIcon(tile.id)}
                  {tile.label}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-100">{tile.value}</span>
                  {tile.warningCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                      <AlertTriangle className="h-3 w-3" />
                      {tile.warningCount}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-500" title={tile.caption}>
                  {tile.caption}
                </div>
              </div>
            )) : (
              <div className="col-span-full bg-zinc-900/80 px-3 py-4 text-xs text-zinc-500">
                {loading ? workspaceText.configScope.loading : workspaceText.configScope.empty}
              </div>
            )}
          </div>

          {configScope && (
            <div className="divide-y divide-zinc-800">
              <ConfigScopeGuidance
                recommendations={configScope.writeRecommendations}
                safetyScan={configScope.safetyScan}
                labels={workspaceText}
              />
              {configScope.layers.map((layer) => (
                <ConfigScopeLayerBlock
                  key={layer.id}
                  layer={layer}
                  onReveal={handleReveal}
                  labels={workspaceText}
                />
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title={workspaceText.browser.title}
        description={workspaceText.browser.description}
      >
        <div className="flex items-center gap-2 mb-3">
          <Globe className="w-4 h-4 text-zinc-400" />
          <span className="text-xs text-zinc-500">{workspaceText.browser.statusHint}</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {browserOptions.map((opt) => {
            const selected = browserSessionMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setBrowserSessionMode(opt.value)}
                className={`flex flex-col items-start gap-1 px-3 py-2 rounded-lg border transition-colors text-left ${
                  selected
                    ? 'border-zinc-500 bg-zinc-800/70 text-zinc-100'
                    : 'border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/[0.16] hover:bg-white/[0.04]'
                }`}
              >
                <span className="text-sm font-medium">{opt.label}</span>
                <span className="text-[11px] text-zinc-500 leading-relaxed">{opt.hint}</span>
              </button>
            );
          })}
        </div>

        {browserSessionMode !== 'none' && (
          <div className="mt-3 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Monitor className="h-4 w-4 flex-shrink-0 text-zinc-400" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-200">Session Inspector</div>
                  <div className="text-[11px] text-zinc-500">
                    {browserSessionMode === 'managed'
                      ? workspaceText.browser.managedSummary
                      : workspaceText.browser.desktopSummary}
                  </div>
                </div>
              </div>
              <span className={`text-xs ${browserSession.blocked ? 'text-amber-300' : 'text-emerald-300'}`}>
                {browserSession.blocked ? 'Blocked' : 'Ready'}
              </span>
            </div>

            {browserStatusRows.length > 0 ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {browserStatusRows.map((row) => (
                  <div
                    key={row.label}
                    className="grid min-w-0 grid-cols-[72px,minmax(0,1fr)] gap-2 text-[11px]"
                  >
                    <span className="text-zinc-500">{row.label}</span>
                    <span
                      className={`truncate ${browserStatusToneClass(row.tone)}`}
                      title={row.title || row.value}
                    >
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-zinc-500">{workspaceText.browser.noSessionStatus}</div>
            )}

            {browserOperationalHint && (
              <div className={`mt-2 text-[11px] leading-relaxed ${browserSession.blocked ? 'text-amber-300' : 'text-zinc-500'}`}>
                {browserOperationalHint}
              </div>
            )}

            {browserSession.repairActions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 border-t border-white/[0.06] pt-2">
                {browserSession.repairActions.map((action) => {
                  const busy = browserSession.busyActionKind === action.kind;
                  return (
                    <button
                      key={action.kind}
                      type="button"
                      onClick={() => void browserSession.runRepairAction(action)}
                      disabled={busy}
                      className="rounded-md border border-white/[0.08] bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-white/[0.16] hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busy ? workspaceText.actions.processing : action.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title={workspaceText.recentDirectories.title}
        description={workspaceText.recentDirectories.description}
        actions={(
          <Button
            size="sm"
            variant="secondary"
            onClick={load}
            disabled={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {workspaceText.actions.refresh}
          </Button>
        )}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="border-b border-zinc-700/60 bg-zinc-900/80 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">{workspaceText.recentDirectories.columns.directory}</th>
                  <th className="px-3 py-2 font-medium">{workspaceText.recentDirectories.columns.status}</th>
                  <th className="px-3 py-2 text-right font-medium">{workspaceText.recentDirectories.columns.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {loading ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-6 text-center text-zinc-500">{workspaceText.loading}</td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-6 text-center text-zinc-500">
                      <div className="flex flex-col items-center gap-1">
                        <Clock className="h-5 w-5 text-zinc-600" />
                        <div>{workspaceText.recentDirectories.emptyTitle}</div>
                        <div className="text-[11px] text-zinc-600">
                          {workspaceText.recentDirectories.emptyDescription}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={row.path}
                      className={row.active ? 'bg-zinc-800/70' : 'bg-zinc-900/40 hover:bg-zinc-800/60'}
                    >
                      <td className="px-3 py-3 align-middle">
                        <button
                          type="button"
                          onClick={() => setSelectedDetail(row)}
                          className="flex w-full min-w-0 items-start gap-2 text-left"
                        >
                          <span className="rounded border border-zinc-700 bg-zinc-800 p-1.5 text-zinc-300">
                            <Folder className="h-4 w-4" />
                          </span>
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-zinc-200">{row.label}</div>
                            <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500" title={row.path}>
                              {row.path}
                            </div>
                          </div>
                        </button>
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <span
                          className={`inline-flex rounded border px-2 py-1 ${
                            row.active
                              ? 'border-zinc-500 bg-zinc-800 text-zinc-200'
                              : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {row.active ? workspaceText.recentDirectories.current : workspaceText.recentDirectories.recent}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={isWebMode()}
                            onClick={() => handleReveal(row.path)}
                            leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
                          >
                            {workspaceText.actions.open}
                          </Button>
                          {!row.active && (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isWebMode()}
                                onClick={() => handleSwitchTo(row.path)}
                              >
                                {workspaceText.actions.switch}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={isWebMode()}
                                onClick={() => handleRemoveRecent(row.path)}
                                leftIcon={<X className="h-3.5 w-3.5" />}
                              >
                                {workspaceText.actions.remove}
                              </Button>
                            </>
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

      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-zinc-800/40 border border-white/[0.06]">
        <Info className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0 mt-0.5" />
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          {workspaceText.localBridgeNotice}
        </p>
      </div>

      {selectedDetail && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/40"
          onClick={() => setSelectedDetail(null)}
        >
          <aside
            className="h-full w-[400px] overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-zinc-100">{selectedDetail.label}</div>
                <div className="mt-1 break-all font-mono text-[11px] text-zinc-500">{selectedDetail.path}</div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedDetail(null)}
                className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                aria-label={workspaceText.actions.closeDetails}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 text-xs text-zinc-300">
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                  {workspaceText.recentDirectories.columns.status}
                </div>
                <div className="mt-1">
                  {selectedDetail.active ? workspaceText.details.currentWorkspace : workspaceText.details.recentVisit}
                </div>
              </div>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                  {workspaceText.recentDirectories.columns.actions}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isWebMode()}
                    onClick={() => handleReveal(selectedDetail.path)}
                    leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
                  >
                    {workspaceText.actions.revealInFinder}
                  </Button>
                  {!selectedDetail.active && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={isWebMode()}
                      onClick={async () => {
                        await handleSwitchTo(selectedDetail.path);
                        setSelectedDetail(null);
                      }}
                      leftIcon={<Plug className="h-3.5 w-3.5" />}
                    >
                      {workspaceText.actions.switchToWorkspace}
                    </Button>
                  )}
                </div>
              </div>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3 text-[11px] text-zinc-500">
                {workspaceText.details.todo}
              </div>
            </div>
          </aside>
        </div>
      )}
    </SettingsPage>
  );
};

const ConfigScopeGuidance: React.FC<{
  recommendations: ConfigWriteRecommendation[];
  safetyScan: ConfigSafetyScanSummary;
  labels: WorkspaceSettingsText;
}> = ({ recommendations, safetyScan, labels }) => {
  const scannedFileCount = safetyScan.targets.reduce((sum, target) => sum + target.scannedFiles, 0);

  return (
    <div className="px-3 py-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="min-w-0 rounded-md border border-zinc-800 bg-zinc-950/25 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium text-zinc-200">{labels.guidance.recommendedLayerTitle}</div>
              <div className="text-[11px] text-zinc-500">
                {labels.guidance.recommendedLayerDescription}
              </div>
            </div>
            <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-400">
              {labels.guidance.readonlyBadge}
            </span>
          </div>
          <div className="space-y-2">
            {recommendations.map((item) => (
              <div key={item.id} className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-zinc-200">{item.label}</span>
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] ${scopeLayerClass(item.recommendedLayer)}`}>
                    {scopeLayerLabel(item.recommendedLayer, labels.scopeLayers)}
                  </span>
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] ${
                    item.teamShareable
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-400'
                  }`}
                  >
                    {shareabilityLabel(item, labels.shareability)}
                  </span>
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">{item.description}</div>
                <div className="mt-1 text-[11px] leading-relaxed text-zinc-300">{item.guidance}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="min-w-0 rounded-md border border-zinc-800 bg-zinc-950/25 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium text-zinc-200">{labels.safety.title}</div>
              <div className="text-[11px] text-zinc-500">
                {labels.safety.description}
              </div>
            </div>
            <span className={`rounded border px-2 py-1 text-[10px] ${
              safetyScan.totalFindings > 0
                ? safetySeverityClass(safetyScan.criticalCount > 0 ? 'critical' : 'warning')
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
            }`}
            >
              {safetyStatusText(safetyScan, labels.safetyStatus)}
            </span>
          </div>

          <div className="grid grid-cols-4 gap-px overflow-hidden rounded border border-zinc-800 bg-zinc-800 text-center">
            {[
              [labels.safety.scannedFiles, String(scannedFileCount)],
              [labels.safety.findings, String(safetyScan.totalFindings)],
              [labels.safetySeverity.critical, String(safetyScan.criticalCount)],
              [labels.safetySeverity.warning, String(safetyScan.warningCount)],
            ].map(([label, value]) => (
              <div key={label} className="bg-zinc-900/80 px-2 py-2">
                <div className="text-sm font-semibold text-zinc-100">{value}</div>
                <div className="text-[10px] text-zinc-500">{label}</div>
              </div>
            ))}
          </div>

          {safetyScan.findings.length === 0 ? (
            <div className="mt-3 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
              {labels.safety.noFindingsDescription}
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {safetyScan.findings.slice(0, 6).map((finding) => (
                <div key={finding.id} className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] ${safetySeverityClass(finding.severity)}`}>
                      {safetySeverityLabel(finding.severity, labels.safetySeverity)}
                    </span>
                    <span className="text-xs font-medium text-zinc-200">{finding.label}</span>
                    <span className="truncate font-mono text-[10px] text-zinc-500" title={finding.target}>
                      {finding.target}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">{finding.detail}</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-zinc-300">{finding.recommendation}</div>
                  {finding.locations.length > 0 && (
                    <div className="mt-1 truncate font-mono text-[10px] text-zinc-600" title={finding.locations.join(', ')}>
                      {finding.locations.join(', ')}
                    </div>
                  )}
                </div>
              ))}
              {safetyScan.findings.length > 6 && (
                <div className="text-[11px] text-zinc-500">
                  {labels.safety.hiddenPrefix}{safetyScan.findings.length - 6}{labels.safety.hiddenSuffix}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ConfigScopeLayerBlock: React.FC<{
  layer: ConfigScopeLayer;
  onReveal: (path: string) => void;
  labels: WorkspaceSettingsText;
}> = ({ layer, onReveal, labels }) => (
  <div className="px-3 py-3">
    <div className="mb-2 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="rounded-md border border-zinc-700 bg-zinc-800 p-1 text-zinc-300">
          {scopeIcon(layer.id)}
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-200">{layer.label}</div>
          <div className="truncate text-[11px] text-zinc-500" title={layer.description}>
            {layer.description}
          </div>
        </div>
      </div>
      <div className="shrink-0 text-[11px] text-zinc-500">
        {layer.presentCount}{labels.configScope.presentCountMiddle}{layer.items.length}{labels.configScope.presentCountSuffix}
      </div>
    </div>
    {layer.items.length === 0 ? (
      <div className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-500">
        {labels.configScope.noWorkspacePrefix}{layer.label}{labels.configScope.noWorkspaceSuffix}
      </div>
    ) : (
      <div className="overflow-hidden rounded border border-zinc-800">
        <table className="w-full table-fixed text-left text-xs">
          <tbody className="divide-y divide-zinc-800">
            {layer.items.map((item) => {
              const canReveal = item.exists && item.kind !== 'runtime' && !isWebMode();
              return (
                <tr key={item.id} className="bg-zinc-950/25">
                  <td className="w-[28%] px-3 py-2 align-top">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-zinc-200">{item.label}</span>
                      {item.private && (
                        <span className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400">
                          {labels.configScope.privateBadge}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                      {item.description}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <code className="block truncate text-[11px] text-zinc-300" title={item.path}>
                      {item.path}
                    </code>
                    {item.detail && (
                      <div className="mt-1 text-[11px] text-zinc-500">{item.detail}</div>
                    )}
                    {item.warning && (
                      <div className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-300">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{item.warning}</span>
                      </div>
                    )}
                  </td>
                  <td className="w-[160px] px-3 py-2 align-top">
                    <div className="flex items-center justify-end gap-2">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] ${scopeStatusClass(item.status)}`}>
                        {scopeStatusLabel(item, labels.scopeStatus)}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canReveal}
                        onClick={() => onReveal(item.path)}
                        leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
                      >
                        {labels.actions.locate}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )}
  </div>
);
