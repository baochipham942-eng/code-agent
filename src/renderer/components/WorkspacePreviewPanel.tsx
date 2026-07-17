import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Check,
  Clipboard,
  Copy,
  Image,
  LayoutGrid,
} from 'lucide-react';
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
import ProjectHeaderBar from './ProjectHeaderBar';
import { ConfirmDialog } from './composites/ConfirmDialog';
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

export const WorkspacePreviewPanel: React.FC = () => {
  const { t } = useI18n();
  const wp = t.previewWorkspace.workspacePreview;
  const items = useWorkspacePreviewModel();
  const selectedId = useAppStore((state) => state.selectedWorkspacePreviewId);
  const setSelectedId = useAppStore((state) => state.setSelectedWorkspacePreviewId);
  const setWorkingDirectory = useAppStore((state) => state.setWorkingDirectory);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessions = useSessionStore((state) => state.sessions);
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
  const galleryItems = useMemo(() => items.filter(isGalleryItem), [items]);
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
  const currentSessionTitle = useMemo(() => {
    if (!currentSessionId) return undefined;
    return sessions.find((session) => session.id === currentSessionId)?.title;
  }, [currentSessionId, sessions]);
  useEffect(() => {
    if (!selected && selectedId) {
      setSelectedId(null);
      return;
    }
    if (selected && selected.id !== selectedId) {
      setSelectedId(selected.id);
    }
  }, [selected, selectedId, setSelectedId]);

  useEffect(() => {
    setIsRestoreConfirmationOpen(false);
    setRevisionActionError(null);
    setRevisionActionMessage(null);
  }, [selected?.id]);

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
      setRevisionActionMessage(`Restored ${result.filesRestored} file${result.filesRestored === 1 ? '' : 's'}.`);
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

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-zinc-900">
      {/* P0-2 项目空间 header：项目维度的目标/状态/入驻角色/跨 session 聚合产物 */}
      <ProjectHeaderBar />
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-3 py-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Clipboard className="h-4 w-4 shrink-0 text-cyan-300" />
            <div className="truncate text-sm font-semibold text-zinc-100">Preview</div>
          </div>
          <div className="mt-0.5 truncate text-xs text-zinc-500">
            {items.length} files · {galleryItems.length} visuals · {appAssetCount} apps
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <AssetToolbarButton
            label={`Prompt Apps (${appAssetCount})`}
            icon={<LayoutGrid className="h-4 w-4" />}
            count={appAssetCount}
            active={activeDrawer === 'apps'}
            onClick={() => setActiveDrawer((current) => (current === 'apps' ? null : 'apps'))}
          />
          <AssetToolbarButton
            label={`Gallery (${galleryItems.length})`}
            icon={<Image className="h-4 w-4" />}
            count={galleryItems.length}
            active={activeDrawer === 'gallery'}
            onClick={() => setActiveDrawer((current) => (current === 'gallery' ? null : 'gallery'))}
          />
          <div className="mx-1 h-5 w-px bg-white/[0.08]" />
          <AssetToolbarButton
            label={copied ? 'Copied' : 'Copy preview'}
            icon={copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
            disabled={!selected}
            onClick={copySelected}
          />
          <AssetToolbarButton
            label="Export bundle"
            icon={<Archive className="h-4 w-4" />}
            disabled={!selected?.file?.path}
            onClick={exportSelectedBundle}
          />
        </div>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div>
            <Clipboard className="mx-auto h-8 w-8 text-zinc-600" />
            <div className="mt-3 text-sm text-zinc-300">{wp.noPreviewableFiles}</div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-500">{wp.noArtifactsYet}</div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-white/[0.06] p-3">
            <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
              <span>Files</span>
              <span>{items.length}</span>
            </div>
            <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
              {items.map((item) => (
                <PreviewListItem
                  key={item.id}
                  item={item}
                  active={item.id === selected?.id}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {selected && (
              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  <KindIcon kind={selected.kind} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-zinc-100">{selected.title}</div>
                    <div className="mt-0.5 truncate text-xs text-zinc-500">
                      {kindLabel(selected.kind)}
                      {selected.source.label ? ` · ${selected.source.label}` : ''}
                    </div>
                    {selected.designBrief && (
                      <>
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
                      </>
                    )}
                  </div>
                </div>
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
                <PreviewBody item={selected} />
              </div>
            )}
          </div>
        </div>
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
          title="Prompt Apps"
          subtitle={`${appAssetCount} saved`}
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
          title="Gallery"
          subtitle={`${galleryItems.length} visual assets`}
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
