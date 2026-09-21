import { createElement } from 'react';
import {
  Pin, Pencil, IdCard, Undo2, Archive, Trash2, Wrench, Save, Puzzle, FlaskConical, FileText, ScrollText, Mic2, GitFork,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { SessionExportEnvelopeV2, ImportSessionForkResponse } from '@shared/contract/sessionForkPortability';
import {
  createWorkbenchRecipeMergedContext,
  getDefaultWorkbenchPresetName,
  type WorkbenchPreset,
  type WorkbenchRecipe,
} from '@shared/contract/workbenchPreset';
import { shortSessionIdForFileName } from '@shared/utils/id';
import type { SessionWithMeta } from '../../../stores/sessionStore';
import type { ToastType } from '../../../stores/uiStore';
import type { ToastAction } from '../../../hooks/useToast';
import type { Translations } from '../../../i18n';
import { createLogger } from '../../../utils/logger';
import { copyPathToClipboard } from '../../../utils/platform';
import { getDisplaySessionTitle } from '../../../utils/sessionPresentation';
import { pickNativeFile } from '../../../services/tauriPluginFacade';
import {
  canReuseSessionWorkbench,
  formatPresetMenuLabel,
  getReusableWorkbenchDirectory,
} from './sidebarPresentation';
import type { ContextMenuItem } from './SessionContextMenu';

const logger = createLogger('Sidebar');

export const SESSION_DIAGNOSTICS_EXPORT_TIMEOUT_MS = 12_000;

const SESSION_FORK_IMPORT_ERROR_CODES = [
  'INVALID_ENVELOPE',
  'UNSUPPORTED_SCHEMA_VERSION',
  'OWNER_SCOPE_MISMATCH',
  'PROJECT_SCOPE_MISMATCH',
  'SYNC_ID_DIGEST_CONFLICT',
  'DIGEST_MISMATCH',
  'REFERENCE_NOT_CLOSED',
  'ORDINAL_INVALID',
  'ID_REMAP_COLLISION',
  'PORTABLE_EVIDENCE_REQUIRED',
] as const;

const SESSION_FORK_REEXPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'DIGEST_MISMATCH',
  'REFERENCE_NOT_CLOSED',
  'ORDINAL_INVALID',
  'ID_REMAP_COLLISION',
  'PORTABLE_EVIDENCE_REQUIRED',
  'UNSUPPORTED_SCHEMA_VERSION',
]);

type SessionForkImportErrorCode = typeof SESSION_FORK_IMPORT_ERROR_CODES[number];

type ErrorWithCode = Error & { code?: string };

function errorWithCode(message: string, code?: string): ErrorWithCode {
  const error = new Error(message) as ErrorWithCode;
  if (code) error.code = code;
  return error;
}

export function isSessionForkEnvelopeShape(value: unknown): value is SessionExportEnvelopeV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as {
    version?: unknown;
    projectId?: unknown;
    sessions?: unknown;
    messages?: unknown;
  };
  return typeof record.version === 'number'
    && typeof record.projectId === 'string'
    && Array.isArray(record.sessions)
    && Array.isArray(record.messages);
}

export function sessionForkImportNamespace(projectId: string, exportId: string): string {
  const projectPart = projectId.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'project';
  const exportPart = exportId.replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  return `desktop-${projectPart}-${exportPart}`;
}

export function rejectAfter<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
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
  handleOpenVoiceAudit: (session: SessionWithMeta) => void;
  voiceLiveInstalled: boolean;
  unarchiveSession: (sessionId: string) => void;
  archiveSession: (sessionId: string) => void;
  softDelete: (sessionIds: string[]) => void;
  saveExportToDownloads: (fileName: string, content: string, options?: { silent?: boolean }) => Promise<void>;
  reloadSessions: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  locateImportedSession: (sourceExportId: string, projectId: string) => Promise<boolean>;
  findImportedSession: (sourceExportId: string, projectId: string) => Promise<{
    id: string;
    sourcePayloadDigest?: string;
  } | null>;
  confirmImportSessionFork: (options: {
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
  }) => Promise<boolean>;
  showActionToast: (message: string, action?: ToastAction) => void;
  showSuccessToast: (message: string) => void;
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
    handleOpenVoiceAudit,
    voiceLiveInstalled,
    unarchiveSession,
    archiveSession,
    softDelete,
    saveExportToDownloads,
    reloadSessions,
    switchSession,
    locateImportedSession,
    findImportedSession,
    confirmImportSessionFork,
    showActionToast,
    showSuccessToast,
    showToast,
    openRuntimeLogsFolder,
    t,
  } = deps;
  const menu = t.sessionMenu;

  const importErrorCode = (error: unknown): SessionForkImportErrorCode | null => {
    const explicitCode = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
    if ((SESSION_FORK_IMPORT_ERROR_CODES as readonly string[]).includes(explicitCode)) {
      return explicitCode as SessionForkImportErrorCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    return SESSION_FORK_IMPORT_ERROR_CODES.find((code) => message.includes(code)) ?? null;
  };

  const importErrorMessage = (code: string | null): string => {
    switch (code) {
      case 'INVALID_ENVELOPE': return menu.importSessionForkInvalidEnvelope;
      case 'UNSUPPORTED_SCHEMA_VERSION': return menu.importSessionForkUnsupportedVersion;
      case 'OWNER_SCOPE_MISMATCH': return menu.importSessionForkOwnerMismatch;
      case 'PROJECT_SCOPE_MISMATCH': return menu.importSessionForkProjectMismatch;
      case 'SYNC_ID_DIGEST_CONFLICT': return menu.importSessionForkDuplicate;
      case 'DIGEST_MISMATCH': return menu.importSessionForkDigestMismatch;
      case 'REFERENCE_NOT_CLOSED': return menu.importSessionForkReferenceNotClosed;
      case 'ORDINAL_INVALID': return menu.importSessionForkOrdinalInvalid;
      case 'ID_REMAP_COLLISION': return menu.importSessionForkIdRemapCollision;
      case 'PORTABLE_EVIDENCE_REQUIRED': return menu.importSessionForkEvidenceRequired;
      default: return menu.importSessionForkFailedGeneric;
    }
  };

  const exportCurrentSessionFork = async (): Promise<void> => {
    const fileName = `neo-session-fork-${shortSessionIdForFileName(session.id)}.json`;
    try {
      const response = await window.domainAPI?.invoke<SessionExportEnvelopeV2>(
        IPC_DOMAINS.SESSION,
        'exportSessionFork',
        {
          sessionId: session.id,
          exportId: typeof globalThis.crypto?.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : `${session.id}-${Date.now()}`,
          mode: 'subtree',
        },
      );
      if (!response?.success || !response.data) {
        throw new Error(response?.error?.message || 'Failed to export session fork');
      }
      await saveExportToDownloads(
        fileName,
        `${JSON.stringify(response.data, null, 2)}\n`,
        { silent: true },
      );
      showSuccessToast(menu.savedToDownloads.replace('{fileName}', fileName));
    } catch (error) {
      logger.error('Failed to export session fork', error);
      showActionToast(menu.exportSessionForkFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
    }
  };

  const chooseAnotherFileAction = (): ToastAction => ({
    label: menu.importSessionForkChooseAnother,
    onClick: () => {
      void pickAndImportSessionFork();
    },
  });

  const importErrorAction = (code: string | null, envelope: SessionExportEnvelopeV2): ToastAction => {
    if (code === 'SYNC_ID_DIGEST_CONFLICT') {
      return {
        label: menu.importSessionForkLocateExisting,
        onClick: () => {
          void locateImportedSession(envelope.exportId, session.projectId ?? envelope.projectId).then((found) => {
            if (!found) showActionToast(menu.importSessionForkLocateMissing);
          });
        },
      };
    }
    if (!code || SESSION_FORK_REEXPORT_ERROR_CODES.has(code)) {
      return {
        label: menu.importSessionForkReExport,
        onClick: () => {
          void exportCurrentSessionFork();
        },
      };
    }
    return chooseAnotherFileAction();
  };

  async function runImportSessionFork(filePath: string): Promise<void> {
    const projectId = session.projectId;
    if (!projectId) {
      showActionToast(menu.importSessionForkNoProject);
      return;
    }

    let envelope: SessionExportEnvelopeV2 | undefined;
    try {
      const file = await window.domainAPI?.invoke<string>(
        IPC_DOMAINS.WORKSPACE,
        'readFile',
        { filePath },
      );
      if (!file?.success || typeof file.data !== 'string') {
        showActionToast(menu.importSessionForkInvalidFile, chooseAnotherFileAction());
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(file.data);
      } catch {
        showActionToast(menu.importSessionForkInvalidFile, chooseAnotherFileAction());
        return;
      }
      if (!isSessionForkEnvelopeShape(parsed)) {
        showActionToast(menu.importSessionForkInvalidFile, chooseAnotherFileAction());
        return;
      }
      const parsedEnvelope = parsed;
      envelope = parsedEnvelope;

      const planned = await confirmImportSessionFork({
        title: menu.importSessionForkPlanTitle,
        message: menu.importSessionForkPlanMessage
          .replace('{sourceProject}', parsedEnvelope.projectId)
          .replace('{targetProject}', projectId)
          .replace('{sessionCount}', String(parsedEnvelope.sessions.length))
          .replace('{messageCount}', String(parsedEnvelope.messages.length)),
        confirmText: menu.importSessionForkPlanConfirm,
        cancelText: menu.importSessionForkPlanCancel,
      });
      if (!planned) return;

      const existingImported = parsedEnvelope.exportId
        ? await findImportedSession(parsedEnvelope.exportId, projectId)
        : null;

      const namespace = sessionForkImportNamespace(projectId, String(parsedEnvelope.exportId ?? ''));
      const importFork = async (allowProjectRemap: boolean): Promise<ImportSessionForkResponse> => {
        const response = await window.domainAPI?.invoke<ImportSessionForkResponse>(
          IPC_DOMAINS.SESSION,
          'importSessionFork',
          {
            envelope: parsedEnvelope,
            targetProjectId: projectId,
            namespace,
            allowProjectRemap,
          },
        );
        if (!response?.success || !response.data) {
          throw errorWithCode(
            response?.error?.message || 'Failed to import session fork',
            response?.error?.code,
          );
        }
        return response.data;
      };

      let imported: ImportSessionForkResponse;
      try {
        imported = await importFork(false);
      } catch (error) {
        if (importErrorCode(error) !== 'PROJECT_SCOPE_MISMATCH') throw error;
        const remapConfirmed = await confirmImportSessionFork({
          title: menu.importSessionForkRemapTitle,
          message: menu.importSessionForkRemapMessage
            .replace('{sourceProject}', parsedEnvelope.projectId)
            .replace('{targetProject}', projectId),
          confirmText: menu.importSessionForkRemapConfirm,
          cancelText: menu.importSessionForkRemapCancel,
        });
        if (!remapConfirmed) return;
        imported = await importFork(true);
      }
      await reloadSessions();
      await switchSession(imported.rootSessionId);
      if (existingImported?.id === imported.rootSessionId) {
        showActionToast(menu.importSessionForkDuplicate, {
          label: menu.importSessionForkLocateExisting,
          onClick: () => {
            void locateImportedSession(parsedEnvelope.exportId, projectId).then((found) => {
              if (!found) showActionToast(menu.importSessionForkLocateMissing);
            });
          },
        });
        return;
      }
      showSuccessToast(menu.importSessionForkSucceeded.replace('{count}', String(Object.keys(imported.sessionIdMap).length)));
    } catch (error) {
      const code = importErrorCode(error);
      logger.error('Failed to import session fork', { code, error });
      if (envelope) {
        showActionToast(importErrorMessage(code), importErrorAction(code, envelope));
        return;
      }
      showActionToast(
        menu.importSessionForkFailed.replace(
          '{message}',
          error instanceof Error ? error.message : String(error),
        ),
        chooseAnotherFileAction(),
      );
    }
  }

  async function pickAndImportSessionFork(): Promise<void> {
    try {
      const filePath = await pickNativeFile({
        title: menu.importSessionForkFileTitle,
        extensions: ['json'],
      });
      if (!filePath) return;
      await runImportSessionFork(filePath);
    } catch (error) {
      logger.error('Failed to import session fork', error);
      showActionToast(
        menu.importSessionForkFailed.replace(
          '{message}',
          error instanceof Error ? error.message : String(error),
        ),
        chooseAnotherFileAction(),
      );
    }
  }

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
    ...(voiceLiveInstalled ? [{
      label: t.voiceAudit.menuLabel,
      icon: createElement(Mic2, { className: 'h-4 w-4' }),
      onClick: () => handleOpenVoiceAudit(session),
    }] : []),
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
      label: menu.exportSessionFork,
      icon: createElement(GitFork, { className: 'h-4 w-4' }),
      onClick: () => exportCurrentSessionFork(),
    },
    ...(session.projectId ? [{
      label: menu.importSessionFork,
      icon: createElement(GitFork, { className: 'h-4 w-4' }),
      onClick: () => pickAndImportSessionFork(),
    } satisfies ContextMenuItem] : []),
    {
      label: menu.exportSessionLog,
      icon: createElement(ScrollText, { className: 'h-4 w-4' }),
      onClick: async () => {
        try {
          const response = await rejectAfter(
            window.domainAPI?.invoke<{ content: string; suggestedFileName: string; encoding?: 'utf8' | 'base64' }>(
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
          const suggestedFileName = response.data.suggestedFileName
            || `neo-session-${shortSessionIdForFileName(session.id)}.zip`;
          if (response.data.encoding === 'base64') {
            const saved = await window.domainAPI?.invoke<{ filePath: string }>(
              IPC_DOMAINS.WORKSPACE,
              'saveBinaryToDownloads',
              { fileName: suggestedFileName, base64: response.data.content },
            );
            if (!saved?.success || !saved.data?.filePath) {
              throw new Error(saved?.error?.message || 'Failed to save diagnostics package');
            }
            showToast('success', menu.exportSessionLogSavedPath.replace('{path}', saved.data.filePath));
            void window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'showItemInFolder', {
              filePath: saved.data.filePath,
            });
          } else {
            await saveExportToDownloads(suggestedFileName, response.data.content);
          }
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
