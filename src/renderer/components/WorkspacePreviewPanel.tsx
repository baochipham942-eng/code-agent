import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Copy,
  FileText,
  Image,
  LayoutGrid,
  MoreHorizontal,
} from 'lucide-react';
import type { ProjectArtifact, ProjectArtifactKind } from '@shared/contract/project';
import {
  createWorkbenchRecipeMergedContext,
  type WorkbenchPreset,
  type WorkbenchRecipe,
} from '@shared/contract/workbenchPreset';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import { useWorkspacePreviewModel } from '../hooks/useWorkspacePreviewModel';
import { useI18n } from '../hooks/useI18n';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import { useWorkbenchPresetStore } from '../stores/workbenchPresetStore';
import {
  DESIGN_BRIEF_SUBMIT_EVENT,
  type DesignBriefSubmitDetail,
} from './QuestionFormPreview';
import {
  AssetDrawerPanel,
  AssetToolbarButton,
  PromptAppLibrary,
  isGalleryItem,
} from './WorkspaceAssets';
import { useSessionStore } from '../stores/sessionStore';
import ipcService from '../services/ipcService';
import { getProjectArtifacts } from '../services/projectClient';
import { ConfirmDialog } from './composites/ConfirmDialog';
import { DeliverableCardList } from './features/chat/MessageBubble/DeliverableCardList';
import { buildDeliverableCardFromWorkspaceItem } from '../utils/deliverables';
import {
  kindLabel,
  getPreviewItemText,
  downloadPreviewItem,
} from './workspacePreview/helpers';
import {
  KindIcon,
  DesignBriefBadge,
  PreviewListItem,
  RevisionPanel,
  PreviewBody,
} from './workspacePreview/parts';

type WorkspaceAssetDrawer = 'apps' | 'gallery' | 'feedback';

const PROJECT_ARTIFACT_TITLE_LIMIT = 40;
const KIND_TITLE_ARTIFACTS: ReadonlySet<ProjectArtifactKind> = new Set([
  'mermaid',
  'question_form',
]);

function projectArtifactKindLabel(
  kind: ProjectArtifactKind,
  labels: ReturnType<typeof useI18n>['t']['sidebarProject']['artifactKind'],
): string {
  if (kind === 'process-output') return labels.processOutput;
  if (kind === 'process-log') return labels.processLog;
  return labels[kind] ?? kind;
}

export function projectArtifactDisplayTitle(
  artifact: Pick<ProjectArtifact, 'kind' | 'title'>,
  labels: ReturnType<typeof useI18n>['t']['sidebarProject']['artifactKind'],
): string {
  const kindTitle = projectArtifactKindLabel(artifact.kind, labels);
  if (KIND_TITLE_ARTIFACTS.has(artifact.kind)) return kindTitle;
  const title = artifact.title?.trim();
  if (!title) return kindTitle;
  return title.length > PROJECT_ARTIFACT_TITLE_LIMIT
    ? `${title.slice(0, PROJECT_ARTIFACT_TITLE_LIMIT)}…`
    : title;
}

export function dedupeProjectArtifacts(
  artifacts: ProjectArtifact[],
  labels: ReturnType<typeof useI18n>['t']['sidebarProject']['artifactKind'],
): Array<ProjectArtifact & { displayTitle: string }> {
  const seen = new Set<string>();
  const result: Array<ProjectArtifact & { displayTitle: string }> = [];
  for (const artifact of artifacts) {
    const displayTitle = projectArtifactDisplayTitle(artifact, labels);
    const key = `${artifact.kind}:${displayTitle.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...artifact, displayTitle });
  }
  return result;
}

function OverflowAction({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="shrink-0 text-zinc-400">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

export const WorkspacePreviewPanel: React.FC = () => {
  const { t } = useI18n();
  const wp = t.previewWorkspace.workspacePreview;
  const items = useWorkspacePreviewModel();
  const selectedId = useAppStore((state) => state.selectedWorkspacePreviewId);
  const setSelectedId = useAppStore((state) => state.setSelectedWorkspacePreviewId);
  const setWorkingDirectory = useAppStore((state) => state.setWorkingDirectory);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const currentProjectId = useMemo(
    () => sessions.find((session) => session.id === currentSessionId)?.projectId ?? null,
    [currentSessionId, sessions],
  );
  const projectSessionCount = useMemo(
    () => currentProjectId
      ? sessions.filter((session) => session.projectId === currentProjectId).length
      : 0,
    [currentProjectId, sessions],
  );
  const presets = useWorkbenchPresetStore((state) => state.presets);
  const recipes = useWorkbenchPresetStore((state) => state.recipes);
  const applyWorkbenchPreset = useComposerStore((state) => state.applyWorkbenchPreset);
  const applyWorkbenchRecipe = useComposerStore((state) => state.applyWorkbenchRecipe);
  const [activeDrawer, setActiveDrawer] = useState<WorkspaceAssetDrawer | null>(null);
  const [copied, setCopied] = useState(false);
  const [assetActionError, setAssetActionError] = useState<string | null>(null);
  const [isRestoreConfirmationOpen, setIsRestoreConfirmationOpen] = useState(false);
  const [isRestoringRevision, setIsRestoringRevision] = useState(false);
  const [revisionActionError, setRevisionActionError] = useState<string | null>(null);
  const [revisionActionMessage, setRevisionActionMessage] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [projectArtifactsExpanded, setProjectArtifactsExpanded] = useState(false);
  const [projectArtifacts, setProjectArtifacts] = useState<ProjectArtifact[]>([]);
  const [projectArtifactsLoading, setProjectArtifactsLoading] = useState(false);
  const [projectArtifactsError, setProjectArtifactsError] = useState<string | null>(null);
  const galleryItems = useMemo(() => items.filter(isGalleryItem), [items]);
  const visibleProjectArtifacts = useMemo(
    () => dedupeProjectArtifacts(projectArtifacts, t.sidebarProject.artifactKind),
    [projectArtifacts, t.sidebarProject.artifactKind],
  );
  const appAssetCount = presets.length + recipes.length;

  // 监听 question-form 提交事件，把 brief 锁定到当前 session 运行时 state（不进 DB）。
  // 下一轮 sendMessage 会从 sessionStore 读这条 brief，prepend 到 IPC content 注入 LLM。
  useEffect(() => {
    function onBriefSubmit(e: Event) {
      const detail = (e as CustomEvent<DesignBriefSubmitDetail>).detail;
      if (!detail) return;
      const sessionId = useSessionStore.getState().currentSessionId;
      if (!sessionId) return;
      useSessionStore.getState().setSessionDesignBrief(sessionId, detail.brief);
    }
    window.addEventListener(DESIGN_BRIEF_SUBMIT_EVENT, onBriefSubmit);
    return () => window.removeEventListener(DESIGN_BRIEF_SUBMIT_EVENT, onBriefSubmit);
  }, []);

  const selected = useMemo(() => (
    items.find((item) => item.id === selectedId) || items[0] || null
  ), [items, selectedId]);
  useEffect(() => {
    if (!selected && selectedId) {
      setSelectedId(null);
      return;
    }
    if (selected && selected.id !== selectedId) {
      setSelectedId(selected.id);
    }
  }, [selected, selectedId, setSelectedId]);

  // 预览/复制/归档/删除四个动作挂在 deliverable 卡上，只为「当前产物」构造一张。
  const selectedDeliverableCard = useMemo(
    () => (selected?.file?.path ? buildDeliverableCardFromWorkspaceItem(selected) : null),
    [selected],
  );

  useEffect(() => {
    setIsRestoreConfirmationOpen(false);
    setRevisionActionError(null);
    setRevisionActionMessage(null);
  }, [selected?.id]);

  useEffect(() => {
    setProjectArtifactsExpanded(false);
    setProjectArtifacts([]);
    setProjectArtifactsError(null);
  }, [currentProjectId]);

  useEffect(() => {
    if (!projectArtifactsExpanded || !currentProjectId) return undefined;
    let cancelled = false;
    setProjectArtifactsLoading(true);
    setProjectArtifactsError(null);
    void getProjectArtifacts(currentProjectId)
      .then((next) => {
        if (!cancelled) setProjectArtifacts(next);
      })
      .catch((error) => {
        if (!cancelled) {
          setProjectArtifactsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setProjectArtifactsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentProjectId, projectArtifactsExpanded]);

  const requestRestoreSelectedCheckpoint = useCallback(() => {
    if (!selected?.source.messageId || !currentSessionId || isRestoringRevision) return;
    setIsRestoreConfirmationOpen(true);
  }, [currentSessionId, isRestoringRevision, selected?.source.messageId]);

  const handleRestoreSelectedCheckpoint = useCallback(async () => {
    if (!selected?.source.messageId || !currentSessionId || isRestoringRevision) return;
    setIsRestoringRevision(true);
    setRevisionActionError(null);
    setRevisionActionMessage(null);
    try {
      const result = await ipcService.invoke(
        IPC_CHANNELS.CHECKPOINT_REWIND,
        currentSessionId,
        selected.source.messageId,
      ) as { success: boolean; filesRestored: number; error?: string } | undefined;
      if (!result?.success) {
        throw new Error(result?.error || 'Checkpoint restore failed');
      }
      setRevisionActionMessage(wp.restoredFiles.replace('{count}', String(result.filesRestored)));
    } catch (error) {
      setRevisionActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRestoringRevision(false);
    }
  }, [currentSessionId, isRestoringRevision, selected?.source.messageId]);

  const syncWorkspaceDirectory = useCallback(async (dir?: string | null) => {
    const trimmed = dir?.trim();
    if (!trimmed) return;
    const response = await window.domainAPI?.invoke<string | null>(
      IPC_DOMAINS.WORKSPACE,
      'setCurrent',
      { dir: trimmed },
    );
    if (response && !response.success) {
      throw new Error(response.error?.message || 'Failed to sync workspace directory');
    }
    setWorkingDirectory(response?.data || trimmed);
  }, [setWorkingDirectory]);

  const handleUsePreset = useCallback((preset: WorkbenchPreset) => {
    setAssetActionError(null);
    void (async () => {
      await syncWorkspaceDirectory(preset.context.workingDirectory);
      applyWorkbenchPreset(preset);
    })().catch((error) => {
      setAssetActionError(error instanceof Error ? error.message : String(error));
    });
  }, [applyWorkbenchPreset, syncWorkspaceDirectory]);

  const handleUseRecipe = useCallback((recipe: WorkbenchRecipe) => {
    setAssetActionError(null);
    void (async () => {
      const context = createWorkbenchRecipeMergedContext(recipe);
      await syncWorkspaceDirectory(context.workingDirectory);
      applyWorkbenchRecipe(recipe);
    })().catch((error) => {
      setAssetActionError(error instanceof Error ? error.message : String(error));
    });
  }, [applyWorkbenchRecipe, syncWorkspaceDirectory]);

  const copySelected = useCallback(async () => {
    if (!selected) return;
    await navigator.clipboard.writeText(getPreviewItemText(selected));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [selected]);

  const exportSelected = useCallback(() => {
    if (!selected) return;
    downloadPreviewItem(selected);
  }, [selected]);

  const selectByOffset = useCallback((offset: number) => {
    if (items.length === 0) return;
    const selectedIndex = selected ? items.findIndex((item) => item.id === selected.id) : -1;
    const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const nextIndex = (currentIndex + offset + items.length) % items.length;
    setSelectedId(items[nextIndex].id);
  }, [items, selected, setSelectedId]);

  useEffect(() => {
    const handleArtifactShortcut = (event: Event) => {
      switch (event.type) {
        case 'app:artifacts.copy':
          void copySelected();
          break;
        case 'app:artifacts.export':
          exportSelected();
          break;
        case 'app:artifacts.previousVersion':
          selectByOffset(-1);
          break;
        case 'app:artifacts.nextVersion':
          selectByOffset(1);
          break;
        default:
          break;
      }
    };

    const events = [
      'app:artifacts.copy',
      'app:artifacts.export',
      'app:artifacts.previousVersion',
      'app:artifacts.nextVersion',
      'app:artifacts.open',
      'app:artifacts.preview',
    ];
    for (const eventName of events) {
      window.addEventListener(eventName, handleArtifactShortcut);
    }
    return () => {
      for (const eventName of events) {
        window.removeEventListener(eventName, handleArtifactShortcut);
      }
    };
  }, [copySelected, exportSelected, selectByOffset]);

  const exportSelectedBundle = async () => {
    if (!selected?.file?.path) return;
    setAssetActionError(null);
    try {
      const response = await window.domainAPI?.invoke<{ filePath: string }>(
        IPC_DOMAINS.WORKSPACE,
        'exportBundle',
        {
          bundleName: `${selected.title || selected.file.name || 'deliverable'}-bundle.zip`,
          files: [{
            path: selected.file.path,
            name: selected.file.name || selected.title,
            role: 'primary',
            mimeType: selected.file.mimeType,
            sha256: selected.file.sha256,
          }],
          manifest: {
            source: 'workspace-preview',
            itemId: selected.id,
            title: selected.title,
            kind: selected.kind,
            status: selected.status,
            previewSource: selected.source,
            revision: selected.revision,
            quality: selected.quality,
          },
        },
      );
      if (response && !response.success) {
        throw new Error(response.error?.message || 'Export bundle failed');
      }
      const bundlePath = response?.data?.filePath;
      if (!bundlePath) return;
      await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'showItemInFolder', { filePath: bundlePath });
    } catch (error) {
      setAssetActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const openProjectArtifact = useCallback((artifact: ProjectArtifact) => {
    if (artifact.path) {
      useAppStore.getState().openPreview(artifact.path);
      return;
    }
    if (artifact.sessionId === currentSessionId && artifact.previewItemId) {
      useAppStore.getState().openWorkspacePreview(artifact.previewItemId);
    }
  }, [currentSessionId]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-zinc-900">
      {/* 右栏是产物本身，不是「关于产物的清单」。之前一屏里：会话产物折叠头 + 计数、
          统计行 + 4 个工具栏按钮、文件小标题 + 同一个计数、常驻文件列表、选中项元数据、
          版本区——十几个可点元素挤在内容上面，真正的内容拿剩下那点高度。
          现在：一条 slim header（图标 + 产物名 + 切换 + ⋯），下面全是内容；
          元数据与版本收进底部「详情与版本」，动作全进 ⋯。 */}
      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div>
            <Clipboard className="mx-auto h-8 w-8 text-zinc-600" />
            <div className="mt-3 text-sm text-zinc-300">{wp.noPreviewableFiles}</div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-500">{wp.noArtifactsYet}</div>
          </div>
        </div>
      ) : (
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
            {selected && <KindIcon kind={selected.kind} />}
            <span
              className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100"
              title={selected ? `${selected.title}\n${kindLabel(selected.kind)}${selected.source.label ? ` · ${selected.source.label}` : ''}` : undefined}
            >
              {selected?.title}
            </span>
            {/* 单产物时不给切换器：它是唯一那个，下拉里也只有它自己 */}
            {items.length > 1 && (
              <button
                type="button"
                data-testid="workspace-artifact-switcher"
                aria-expanded={switcherOpen}
                aria-label={wp.switchArtifact}
                onClick={() => { setOverflowOpen(false); setSwitcherOpen((current) => !current); }}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
              >
                <span className="tabular-nums">{wp.artifactCount.replace('{count}', String(items.length))}</span>
                {switcherOpen
                  ? <ChevronDown className="h-3 w-3" />
                  : <ChevronRight className="h-3 w-3" />}
              </button>
            )}
            <AssetToolbarButton
              label={wp.moreActions}
              icon={<MoreHorizontal className="h-4 w-4" />}
              active={overflowOpen}
              onClick={() => { setSwitcherOpen(false); setOverflowOpen((current) => !current); }}
            />
          </div>

          {switcherOpen && (
            <div className="max-h-56 shrink-0 space-y-2 overflow-y-auto border-b border-white/[0.06] p-3">
              {items.map((item) => (
                <PreviewListItem
                  key={item.id}
                  item={item}
                  active={item.id === selected?.id}
                  onSelect={() => { setSelectedId(item.id); setSwitcherOpen(false); }}
                />
              ))}
            </div>
          )}

          {overflowOpen && (
            <div
              data-testid="workspace-preview-overflow"
              className="shrink-0 border-b border-white/[0.06] p-2"
            >
              <OverflowAction
                label={copied ? wp.copied : wp.copyPreview}
                icon={copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
                disabled={!selected}
                onClick={() => { void copySelected(); }}
              />
              <OverflowAction
                label={wp.exportBundle}
                icon={<Archive className="h-3.5 w-3.5" />}
                disabled={!selected?.file?.path}
                onClick={() => { void exportSelectedBundle(); }}
              />
              <OverflowAction
                label={wp.promptAppsButton.replace('{count}', String(appAssetCount))}
                icon={<LayoutGrid className="h-3.5 w-3.5" />}
                onClick={() => { setOverflowOpen(false); setActiveDrawer('apps'); }}
              />
              <OverflowAction
                label={wp.galleryButton.replace('{count}', String(galleryItems.length))}
                icon={<Image className="h-3.5 w-3.5" />}
                onClick={() => { setOverflowOpen(false); setActiveDrawer('gallery'); }}
              />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {selected && <PreviewBody item={selected} />}
          </div>

          {selected && (
            <div className="shrink-0 border-t border-white/[0.06]">
              <button
                type="button"
                data-testid="workspace-preview-details-toggle"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((current) => !current)}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-zinc-500 hover:text-zinc-300"
              >
                {detailsOpen
                  ? <ChevronDown className="h-3 w-3" />
                  : <ChevronRight className="h-3 w-3" />}
                {wp.detailsAndVersions}
              </button>
              {detailsOpen && (
                <div className="max-h-[45%] space-y-3 overflow-y-auto px-3 pb-3">
                  {/* 当前产物的元数据与四个动作（预览/复制/归档/删除）——之前每个文件行都常驻一份，
                      现在只对当前那个、且要点开才出现。产物只有一个时这里也照样有，不依赖切换器。 */}
                  {selectedDeliverableCard && (
                    <DeliverableCardList cards={[selectedDeliverableCard]} className="" />
                  )}
                  {selected.designBrief && (
                    <div>
                      <DesignBriefBadge brief={selected.designBrief} />
                      {selected.designBrief.references?.length ? (
                        <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-zinc-400">
                          {selected.designBrief.references.map((reference) => (
                            <div key={reference} className="rounded border border-white/[0.06] bg-white/[0.025] px-2 py-1">
                              {reference}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}
                  <RevisionPanel
                    items={items}
                    selected={selected}
                    currentSessionId={currentSessionId}
                    isRestoring={isRestoringRevision}
                    actionError={revisionActionError}
                    actionMessage={revisionActionMessage}
                    onSelect={setSelectedId}
                    onRestore={requestRestoreSelectedCheckpoint}
                  />
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {currentProjectId && (
        <section className="shrink-0 border-t border-white/[0.08]">
          <button
            type="button"
            aria-expanded={projectArtifactsExpanded}
            onClick={() => setProjectArtifactsExpanded((current) => !current)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left"
          >
            {projectArtifactsExpanded
              ? <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
              : <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />}
            <FileText className="h-4 w-4 text-violet-300" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-300">
              {wp.projectArtifacts.replace('{sessions}', String(projectSessionCount))}
            </span>
            {projectArtifactsExpanded && !projectArtifactsLoading && (
              <span className="text-xs tabular-nums text-zinc-500">{visibleProjectArtifacts.length}</span>
            )}
          </button>
          {projectArtifactsExpanded && (
            <div className="max-h-56 overflow-y-auto border-t border-white/[0.06] px-3 py-2">
              {projectArtifactsLoading ? (
                <div className="py-3 text-center text-xs text-zinc-500">{wp.loadingProjectArtifacts}</div>
              ) : projectArtifactsError ? (
                <div className="py-3 text-center text-xs text-rose-300">{wp.projectArtifactsLoadFailed}</div>
              ) : visibleProjectArtifacts.length === 0 ? (
                <div className="py-3 text-center text-xs text-zinc-500">{wp.noProjectArtifacts}</div>
              ) : (
                <div className="space-y-1">
                  {visibleProjectArtifacts.map((artifact) => {
                    const canOpen = Boolean(
                      artifact.path
                      || (artifact.sessionId === currentSessionId && artifact.previewItemId),
                    );
                    const content = (
                      <>
                        <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                        <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                          {artifact.displayTitle}
                        </span>
                        <span className="max-w-[120px] shrink-0 truncate text-[10px] text-zinc-600">
                          {projectArtifactKindLabel(artifact.kind, t.sidebarProject.artifactKind)}
                          {artifact.sessionTitle ? ` · ${artifact.sessionTitle}` : ''}
                        </span>
                      </>
                    );
                    return canOpen ? (
                      <button
                        key={artifact.id}
                        type="button"
                        onClick={() => openProjectArtifact(artifact)}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/[0.04]"
                      >
                        {content}
                      </button>
                    ) : (
                      <div key={artifact.id} className="flex items-center gap-2 rounded px-2 py-1.5">
                        {content}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {activeDrawer && (
        <button
          type="button"
          aria-label={wp.closeAssetPanel}
          className="absolute inset-0 z-20 cursor-default bg-black/20"
          onClick={() => setActiveDrawer(null)}
        />
      )}

      {activeDrawer === 'apps' && (
        <AssetDrawerPanel
          title={wp.promptAppsTitle}
          subtitle={wp.savedCount.replace('{count}', String(appAssetCount))}
          onClose={() => setActiveDrawer(null)}
        >
          <div className="flex min-h-full flex-col">
            {assetActionError && (
              <div className="mx-4 mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                {assetActionError}
              </div>
            )}
            <PromptAppLibrary
              presets={presets}
              recipes={recipes}
              onUsePreset={handleUsePreset}
              onUseRecipe={handleUseRecipe}
            />
          </div>
        </AssetDrawerPanel>
      )}

      {activeDrawer === 'gallery' && (
        <AssetDrawerPanel
          title={wp.galleryTitle}
          subtitle={wp.visualAssets.replace('{count}', String(galleryItems.length))}
          onClose={() => setActiveDrawer(null)}
        >
          {galleryItems.length === 0 ? (
            <div className="flex min-h-full items-center justify-center px-6 text-center">
              <div>
                <Image className="mx-auto h-8 w-8 text-zinc-600" />
                <div className="mt-3 text-sm text-zinc-300">{wp.noGalleryAssets}</div>
              </div>
            </div>
          ) : (
            <div className="space-y-2 p-3">
              {galleryItems.map((item) => (
                <PreviewListItem
                  key={item.id}
                  item={item}
                  active={item.id === selected?.id}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
            </div>
          )}
        </AssetDrawerPanel>
      )}

      <ConfirmDialog
        isOpen={isRestoreConfirmationOpen}
        title={wp.restoreConfirmTitle}
        message={wp.restoreConfirmMessage}
        variant="warning"
        confirmText={wp.restoreConfirmAction}
        cancelText={wp.cancel}
        onConfirm={() => {
          setIsRestoreConfirmationOpen(false);
          void handleRestoreSelectedCheckpoint();
        }}
        onCancel={() => setIsRestoreConfirmationOpen(false)}
      />

    </div>
  );
};

export default WorkspacePreviewPanel;
