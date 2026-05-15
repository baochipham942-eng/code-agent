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
  Clock,
  ExternalLink,
  Folder,
  FolderOpen,
  Globe,
  Info,
  Monitor,
  Plug,
  RefreshCw,
  X,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import type { BrowserSessionMode } from '@shared/contract/conversationEnvelope';
import { Button } from '../../../primitives';
import { useComposerStore } from '../../../../stores/composerStore';
import { useWorkbenchBrowserSession } from '../../../../hooks/useWorkbenchBrowserSession';
import {
  buildBrowserWorkbenchStatusRows,
  getBrowserWorkbenchOperationalHint,
  type BrowserWorkbenchStatusTone,
} from '../../../../utils/workbenchPresentation';
import { getDesktopShellLabel, isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import { createLogger } from '../../../../utils/logger';
import ipcService from '../../../../services/ipcService';

const logger = createLogger('WorkspaceSettings');

const BROWSER_OPTIONS: Array<{ value: BrowserSessionMode; label: string; hint: string }> = [
  { value: 'none', label: 'Off', hint: '禁用浏览器工具（默认）' },
  { value: 'managed', label: 'Managed', hint: '使用 in-app managed browser；默认 System Chrome via CDP，应用隔离 profile' },
  { value: 'desktop', label: 'Desktop', hint: '读取当前桌面/前台浏览器上下文 + Computer Surface；前台动作需人工确认' },
];

type DefaultOpenTarget = NonNullable<AppSettings['workspace']['defaultOpenTarget']>;

const DEFAULT_OPEN_OPTIONS: Array<{ value: DefaultOpenTarget; label: string; hint: string }> = [
  { value: 'lastDirectory', label: '上次目录', hint: '默认沿用最近一次进入的工作区' },
  { value: 'fixedDirectory', label: '固定目录', hint: '总是进入下面指定的目录' },
  { value: 'askEachTime', label: '每次询问', hint: '启动时让我选，不预设 cwd' },
];

function describeOpenTarget(target: DefaultOpenTarget | undefined): string {
  switch (target ?? 'lastDirectory') {
    case 'fixedDirectory':
      return '固定目录';
    case 'askEachTime':
      return '每次询问';
    case 'lastDirectory':
    default:
      return '上次目录';
  }
}

interface RecentDirRow {
  path: string;
  label: string;
  active: boolean;
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

export const WorkspaceSettings: React.FC = () => {
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
      const [dir, recent, settings] = await Promise.all([
        ipcService.invokeDomain<string | null>(IPC_DOMAINS.WORKSPACE, 'getCurrent'),
        ipcService.invokeDomain<string[]>(IPC_DOMAINS.WORKSPACE, 'listRecent'),
        ipcService.invokeDomain<AppSettings | undefined>(IPC_DOMAINS.SETTINGS, 'get'),
      ]);
      setCurrentDir(dir ?? null);
      setRecentDirs(Array.isArray(recent) ? recent : []);
      setDefaultOpenTargetState(settings?.workspace?.defaultOpenTarget ?? 'lastDirectory');
      setPinnedDirectoryState(settings?.workspace?.pinnedDirectory ?? null);
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
      title="工作区"
      description="管理当前工作目录、最近打开的目录、本地桥状态，以及浏览器工具的默认行为。"
    >
      <WebModeBanner />

      <SettingsSection
        title="当前工作区"
        description="Agent 默认在这个目录下读取/写入文件，可以随时切换。"
        actions={(
          <Button
            size="sm"
            variant="secondary"
            disabled={isWebMode()}
            onClick={handlePickDirectory}
            leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
          >
            选择目录
          </Button>
        )}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 lg:grid-cols-4">
            {[
              ['当前 cwd', currentDir ?? '未设置', '所有 agent 操作的默认根目录'],
              ['默认打开目标', describeOpenTarget(defaultOpenTarget), '启动时如何挑选 working dir'],
              ['本地桥', getDesktopShellLabel(), isWebMode() ? 'Web 模式：通过 HTTP API 连后端' : '应用内 IPC 通道（renderer ↔ main）'],
              ['最近目录数', String(rows.length), '含当前 cwd'],
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
                在 Finder 打开
              </Button>
            </div>
          )}

          <div className="border-t border-zinc-700/60 px-3 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">默认打开目标</div>
                <div className="mt-0.5 text-[11px] text-zinc-500">
                  启动时 agent 选哪个目录当 working dir。
                </div>
              </div>
              {savingPreference && <span className="text-[11px] text-zinc-500">保存中…</span>}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {DEFAULT_OPEN_OPTIONS.map((opt) => {
                const selected = defaultOpenTarget === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSelectOpenTarget(opt.value)}
                    disabled={isWebMode() || savingPreference}
                    className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                      selected
                        ? 'border-primary-500/40 bg-primary-500/15 text-primary-200'
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
                  {pinnedDirectory || '尚未指定固定目录'}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isWebMode() || savingPreference}
                  onClick={handlePickPinnedDirectory}
                  leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
                >
                  {pinnedDirectory ? '更换' : '选择目录'}
                </Button>
                {pinnedDirectory && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isWebMode() || savingPreference}
                    onClick={handleClearPinnedDirectory}
                    leftIcon={<X className="h-3.5 w-3.5" />}
                  >
                    清除
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Browser 默认模式"
        description="决定 agent 默认怎么操作浏览器。原本在「对话」tab，迁到这里和工作区一起管。"
      >
        <div className="flex items-center gap-2 mb-3">
          <Globe className="w-4 h-4 text-zinc-400" />
          <span className="text-xs text-zinc-500">运行状态在任务面板和顶栏呈现</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {BROWSER_OPTIONS.map((opt) => {
            const selected = browserSessionMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setBrowserSessionMode(opt.value)}
                className={`flex flex-col items-start gap-1 px-3 py-2 rounded-lg border transition-colors text-left ${
                  selected
                    ? 'border-primary-500/40 bg-primary-500/15 text-primary-200'
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
                      ? 'Managed browser 状态摘要'
                      : 'Desktop / Computer Surface 状态摘要'}
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
              <div className="text-[11px] text-zinc-500">还没有 browser session 状态。</div>
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
                      {busy ? '处理中...' : action.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="最近目录"
        description="过去打开过的工作区，点击直接切换；保留行为由 settings.workspace 决定。"
        actions={(
          <Button
            size="sm"
            variant="secondary"
            onClick={load}
            disabled={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            刷新
          </Button>
        )}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="border-b border-zinc-700/60 bg-zinc-900/80 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">目录</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {loading ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-6 text-center text-zinc-500">加载中...</td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-6 text-center text-zinc-500">
                      <div className="flex flex-col items-center gap-1">
                        <Clock className="h-5 w-5 text-zinc-600" />
                        <div>暂无最近目录</div>
                        <div className="text-[11px] text-zinc-600">
                          切换或选择一个目录后会自动出现在这里。
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={row.path}
                      className={row.active ? 'bg-emerald-500/10' : 'bg-zinc-900/40 hover:bg-zinc-800/60'}
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
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                              : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {row.active ? '当前' : '最近'}
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
                            打开
                          </Button>
                          {!row.active && (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isWebMode()}
                                onClick={() => handleSwitchTo(row.path)}
                              >
                                切换
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={isWebMode()}
                                onClick={() => handleRemoveRecent(row.path)}
                                leftIcon={<X className="h-3.5 w-3.5" />}
                              >
                                移除
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
          本地桥的健康状态与可视化目前由 IPC 服务承载，后续会把"重启桥""桥协议版本"等运维入口暴露到这里。
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
                aria-label="关闭详情"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 text-xs text-zinc-300">
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">状态</div>
                <div className="mt-1">{selectedDetail.active ? '当前工作区' : '最近访问'}</div>
              </div>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">操作</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isWebMode()}
                    onClick={() => handleReveal(selectedDetail.path)}
                    leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
                  >
                    在 Finder 打开
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
                      切到此工作区
                    </Button>
                  )}
                </div>
              </div>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3 text-[11px] text-zinc-500">
                TODO：补充该目录的最近 session 数、index 健康、git 状态等摘要。
              </div>
            </div>
          </aside>
        </div>
      )}
    </SettingsPage>
  );
};
