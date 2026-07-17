import { createElement } from 'react';
import {
  Pin, Pencil, IdCard, Undo2, Archive, Trash2, Wrench, Save, Puzzle, FlaskConical, FileText, ScrollText,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import {
  createWorkbenchRecipeMergedContext,
  getDefaultWorkbenchPresetName,
  type WorkbenchPreset,
  type WorkbenchRecipe,
} from '@shared/contract/workbenchPreset';
import type { SessionWithMeta } from '../../../stores/sessionStore';
import type { ToastType } from '../../../stores/uiStore';
import type { Translations } from '../../../i18n';
import { createLogger } from '../../../utils/logger';
import { copyPathToClipboard } from '../../../utils/platform';
import { getDisplaySessionTitle } from '../../../utils/sessionPresentation';
import {
  canReuseSessionWorkbench,
  formatPresetMenuLabel,
  getReusableWorkbenchDirectory,
} from './sidebarPresentation';
import type { ContextMenuItem } from './SessionContextMenu';

const logger = createLogger('Sidebar');

const SESSION_DIAGNOSTICS_EXPORT_TIMEOUT_MS = 12_000;

function rejectAfter<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** `buildSessionContextMenuItems` 需要的外部依赖（store action / 组件 handler / setter）。 */
export interface SessionContextMenuDeps {
  pinnedSessionIds: ReadonlySet<string>;
  savedWorkbenchPresets: WorkbenchPreset[];
  savedWorkbenchRecipes: WorkbenchRecipe[];
  setWorkingDirectory: (dir: string) => void;
  applyWorkbenchPreset: (preset: WorkbenchPreset) => void;
  applyWorkbenchRecipe: (recipe: WorkbenchRecipe) => void;
  applySessionWorkbenchPreset: (session: SessionWithMeta) => void;
  saveWorkbenchPresetFromSession: (session: SessionWithMeta, options: { name: string }) => void;
  togglePin: (sessionId: string) => void;
  setRenamingId: (sessionId: string) => void;
  setRenameValue: (value: string) => void;
  canOpenSessionReplay: boolean;
  handleOpenSessionReplay: (session: SessionWithMeta) => Promise<void> | void;
  unarchiveSession: (sessionId: string) => void;
  archiveSession: (sessionId: string) => void;
  softDelete: (sessionIds: string[]) => void;
  saveExportToDownloads: (fileName: string, content: string) => Promise<void>;
  showToast: (type: ToastType, message: string, duration?: number) => string;
  openRuntimeLogsFolder: () => Promise<boolean>;
  t: Translations;
}

/**
 * 构建会话右键菜单项。纯数据构造（返回 `ContextMenuItem[]`），从 `Sidebar` 抽出以收敛巨型组件体积。
 * 行为与原 `getContextMenuItems` 完全一致，外部依赖经 `deps` 注入。
 */
export function buildSessionContextMenuItems(
  session: SessionWithMeta,
  deps: SessionContextMenuDeps,
): ContextMenuItem[] {
  const {
    pinnedSessionIds,
    savedWorkbenchPresets,
    savedWorkbenchRecipes,
    setWorkingDirectory,
    applyWorkbenchPreset,
    applyWorkbenchRecipe,
    applySessionWorkbenchPreset,
    saveWorkbenchPresetFromSession,
    togglePin,
    setRenamingId,
    setRenameValue,
    canOpenSessionReplay,
    handleOpenSessionReplay,
    unarchiveSession,
    archiveSession,
    softDelete,
    saveExportToDownloads,
    showToast,
    openRuntimeLogsFolder,
    t,
  } = deps;
  const menu = t.sessionMenu;

  const isPinned = pinnedSessionIds.has(session.id);
  const isArchived = !!session.isArchived;
  const reusableWorkbenchDirectory = getReusableWorkbenchDirectory(session);
  const reusableWorkbench = canReuseSessionWorkbench(session);
  const recentPresetItems: ContextMenuItem[] = savedWorkbenchPresets.slice(0, 3).map((preset: WorkbenchPreset) => ({
    label: menu.applyPreset.replace('{name}', formatPresetMenuLabel(preset.name)),
    icon: createElement(Puzzle, { className: 'h-4 w-4' }),
    onClick: async () => {
      try {
        const presetDirectory = preset.context.workingDirectory?.trim();
        if (presetDirectory) {
          const response = await window.domainAPI?.invoke<string | null>(
            IPC_DOMAINS.WORKSPACE,
            'setCurrent',
            { dir: presetDirectory },
          );
          if (response && !response.success) {
            throw new Error(response.error?.message || 'Failed to sync preset directory');
          }
          setWorkingDirectory(response?.data || presetDirectory);
        }

        applyWorkbenchPreset(preset);
      } catch (error) {
        logger.error('Failed to apply workbench preset', error);
      }
    },
  }));
  const recentRecipeItems: ContextMenuItem[] = savedWorkbenchRecipes.slice(0, 3).map((recipe: WorkbenchRecipe) => ({
    label: menu.applyRecipe.replace('{name}', formatPresetMenuLabel(recipe.name)),
    icon: createElement(FlaskConical, { className: 'h-4 w-4' }),
    onClick: async () => {
      try {
        const recipeContext = createWorkbenchRecipeMergedContext(recipe);
        const recipeDirectory = recipeContext.workingDirectory?.trim();
        if (recipeDirectory) {
          const response = await window.domainAPI?.invoke<string | null>(
            IPC_DOMAINS.WORKSPACE,
            'setCurrent',
            { dir: recipeDirectory },
          );
          if (response && !response.success) {
            throw new Error(response.error?.message || 'Failed to sync recipe directory');
          }
          setWorkingDirectory(response?.data || recipeDirectory);
        }

        applyWorkbenchRecipe(recipe);
      } catch (error) {
        logger.error('Failed to apply workbench recipe', error);
      }
    },
  }));

  return [
    {
      label: isPinned ? menu.unpin : menu.pin,
      icon: createElement(Pin, { className: 'h-4 w-4' }),
      onClick: () => togglePin(session.id),
    },
    {
      label: menu.rename,
      icon: createElement(Pencil, { className: 'h-4 w-4' }),
      onClick: () => {
        setRenamingId(session.id);
        setRenameValue(getDisplaySessionTitle(session.title));
      },
    },
    {
      label: menu.copySessionId,
      icon: createElement(IdCard, { className: 'h-4 w-4' }),
      onClick: async () => {
        try {
          const copied = await copyPathToClipboard(session.id);
          if (!copied) {
            throw new Error('Clipboard copy returned false');
          }
        } catch (error) {
          logger.error('Failed to copy session id', error);
        }
      },
    },
    {
      label: canOpenSessionReplay ? menu.openReplay : menu.replayAdminOnly,
      icon: createElement(Undo2, { className: 'h-4 w-4' }),
      disabled: !canOpenSessionReplay,
      onClick: async () => {
        await handleOpenSessionReplay(session);
      },
    },
    {
      label: isArchived ? menu.unarchive : menu.archive,
      icon: createElement(Archive, { className: 'h-4 w-4' }),
      onClick: () => {
        if (isArchived) {
          unarchiveSession(session.id);
        } else {
          archiveSession(session.id);
        }
      },
    },
    {
      label: menu.delete,
      icon: createElement(Trash2, { className: 'h-4 w-4' }),
      onClick: () => softDelete([session.id]),
      danger: true,
    },
    ...(reusableWorkbench
      ? [
          {
            label: menu.reuseWorkbench,
            icon: createElement(Wrench, { className: 'h-4 w-4' }),
            onClick: async () => {
              try {
                if (reusableWorkbenchDirectory) {
                  const response = await window.domainAPI?.invoke<string | null>(
                    IPC_DOMAINS.WORKSPACE,
                    'setCurrent',
                    { dir: reusableWorkbenchDirectory },
                  );
                  if (response && !response.success) {
                    throw new Error(response.error?.message || 'Failed to sync workbench directory');
                  }
                  setWorkingDirectory(response?.data || reusableWorkbenchDirectory);
                }

                applySessionWorkbenchPreset(session);
              } catch (error) {
                logger.error('Failed to reuse session workbench preset', error);
              }
            },
          },
          {
            label: menu.savePreset,
            icon: createElement(Save, { className: 'h-4 w-4' }),
            onClick: () => {
              const fallbackName = getDefaultWorkbenchPresetName(session);
              const promptedName =
                typeof window !== 'undefined' && typeof window.prompt === 'function'
                  ? window.prompt(menu.presetNamePrompt, fallbackName)
                  : fallbackName;
              if (promptedName === null) {
                return;
              }

              saveWorkbenchPresetFromSession(session, {
                name: promptedName.trim() || fallbackName,
              });
            },
          },
        ] satisfies ContextMenuItem[]
      : []),
    ...recentPresetItems,
    ...recentRecipeItems,
    {
      label: menu.exportMarkdown,
      icon: createElement(FileText, { className: 'h-4 w-4' }),
      onClick: async () => {
        try {
          const response = await window.domainAPI?.invoke<{ markdown: string; suggestedFileName: string }>(
            IPC_DOMAINS.SESSION,
            'exportMarkdown',
            { sessionId: session.id },
          );
          if (!response?.success || !response.data?.markdown) {
            throw new Error(response?.error?.message || 'Failed to export markdown');
          }
          await saveExportToDownloads(
            response.data.suggestedFileName || `session-${session.id}.md`,
            response.data.markdown,
          );
        } catch (error) {
          logger.error('Failed to export session markdown', error);
          showToast('error', menu.exportMarkdownFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
        }
      },
    },
    {
      label: menu.exportSessionLog,
      icon: createElement(ScrollText, { className: 'h-4 w-4' }),
      onClick: async () => {
        try {
          const response = await rejectAfter(
            window.domainAPI?.invoke<{ content: string; suggestedFileName: string }>(
              IPC_DOMAINS.SESSION,
              'exportDiagnostics',
              { sessionId: session.id },
            ) ?? Promise.resolve(undefined),
            SESSION_DIAGNOSTICS_EXPORT_TIMEOUT_MS,
            menu.exportSessionLogTimeout,
          );
          if (!response?.success || !response.data?.content) {
            throw new Error(response?.error?.message || 'Failed to export session diagnostics');
          }
          await saveExportToDownloads(
            response.data.suggestedFileName || `session-log-${session.id}.json`,
            response.data.content,
          );
        } catch (error) {
          logger.error('Failed to export session diagnostics', error);
          const openedLogs = await openRuntimeLogsFolder();
          const recoveryHint = openedLogs ? menu.logsFolderOpenedHint : menu.logsFolderManualHint;
          showToast(
            'error',
            menu.exportSessionLogFailed
              .replace('{message}', error instanceof Error ? error.message : String(error))
              .replace('{hint}', recoveryHint),
          );
        }
      },
    },
  ];
}
