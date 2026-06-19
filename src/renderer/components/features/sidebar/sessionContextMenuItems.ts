import { IPC_DOMAINS } from '@shared/ipc';
import {
  createWorkbenchRecipeMergedContext,
  getDefaultWorkbenchPresetName,
  type WorkbenchPreset,
  type WorkbenchRecipe,
} from '@shared/contract/workbenchPreset';
import type { SessionWithMeta } from '../../../stores/sessionStore';
import type { ToastType } from '../../../stores/uiStore';
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

function rejectAfter<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs);
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
  } = deps;

  const isPinned = pinnedSessionIds.has(session.id);
  const isArchived = !!session.isArchived;
  const reusableWorkbenchDirectory = getReusableWorkbenchDirectory(session);
  const reusableWorkbench = canReuseSessionWorkbench(session);
  const recentPresetItems: ContextMenuItem[] = savedWorkbenchPresets.slice(0, 3).map((preset: WorkbenchPreset) => ({
    label: `应用 Preset: ${formatPresetMenuLabel(preset.name)}`,
    icon: '🧩',
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
    label: `应用 Recipe: ${formatPresetMenuLabel(recipe.name)}`,
    icon: '🧪',
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
      label: isPinned ? '取消置顶' : '置顶',
      icon: '📌',
      onClick: () => togglePin(session.id),
    },
    {
      label: '重命名',
      icon: '✏️',
      onClick: () => {
        setRenamingId(session.id);
        setRenameValue(getDisplaySessionTitle(session.title));
      },
    },
    {
      label: '复制会话 ID',
      icon: '🆔',
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
      label: canOpenSessionReplay ? '打开 Replay' : 'Replay 仅管理员可用',
      icon: '↩',
      disabled: !canOpenSessionReplay,
      onClick: async () => {
        await handleOpenSessionReplay(session);
      },
    },
    {
      label: isArchived ? '取消归档' : '归档',
      icon: '📦',
      onClick: () => {
        if (isArchived) {
          unarchiveSession(session.id);
        } else {
          archiveSession(session.id);
        }
      },
    },
    {
      label: '删除',
      icon: '🗑',
      onClick: () => softDelete([session.id]),
      danger: true,
    },
    ...(reusableWorkbench
      ? [
          {
            label: '在当前会话复用工作台',
            icon: '🧰',
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
            label: '保存工作台为 Preset',
            icon: '💾',
            onClick: () => {
              const fallbackName = getDefaultWorkbenchPresetName(session);
              const promptedName =
                typeof window !== 'undefined' && typeof window.prompt === 'function'
                  ? window.prompt('Preset 名称', fallbackName)
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
      label: '导出 Markdown',
      icon: '📝',
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
          showToast('error', `导出 Markdown 失败：${error instanceof Error ? error.message : String(error)}`);
        }
      },
    },
    {
      label: '导出会话日志',
      icon: '🧾',
      onClick: async () => {
        try {
          const response = await rejectAfter(
            window.domainAPI?.invoke<{ content: string; suggestedFileName: string }>(
              IPC_DOMAINS.SESSION,
              'exportDiagnostics',
              { sessionId: session.id },
            ) ?? Promise.resolve(undefined),
            SESSION_DIAGNOSTICS_EXPORT_TIMEOUT_MS,
            '导出会话日志',
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
          const recoveryHint = openedLogs
            ? '已打开日志目录，请发送当天 code-agent 日志。'
            : '请发送 ~/.code-agent/logs 里的当天 code-agent 日志。';
          showToast('error', `导出会话日志失败：${error instanceof Error ? error.message : String(error)}。${recoveryHint}`);
        }
      },
    },
  ];
}
