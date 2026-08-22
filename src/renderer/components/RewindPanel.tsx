// ============================================================================
// RewindPanel - Esc+Esc 触发的独立工作区文件恢复面板
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import type { RestoreWorkspaceFilesAtCheckpointResult } from '@shared/contract/fileRestore';
import type { TurnCheckoutResult } from '@shared/contract/turnCheckout';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import { useSessionStore } from '../stores/sessionStore';
import ipcService from '../services/ipcService';
import { Button, Modal } from './primitives';
import { ConfirmDialog } from './composites/ConfirmDialog';
import { useI18n } from '../hooks/useI18n';

interface Checkpoint {
  id: string;
  timestamp: number;
  messageId: string;
  anchorUserMessageId?: string;
  description?: string;
  fileCount: number;
}

interface PreviewFile {
  filePath: string;
  status: 'added' | 'modified' | 'deleted';
}

interface RewindPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onCheckedOut?: (result: TurnCheckoutResult) => void;
}

export const RewindPanel: React.FC<RewindPanelProps> = ({ isOpen, onClose, onCheckedOut }) => {
  const { t } = useI18n();
  const r = t.taskStatusPanels.rewind;
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewFile[]>([]);
  const [isRewinding, setIsRewinding] = useState(false);
  const [confirmMode, setConfirmMode] = useState<'checkout' | 'files' | null>(null);
  const [rewindError, setRewindError] = useState<string | null>(null);
  const [checkoutResult, setCheckoutResult] = useState<TurnCheckoutResult | null>(null);
  const { currentSessionId } = useSessionStore();

  useEffect(() => {
    setSelectedMessageId(null);
    setPreview([]);
    setCheckoutResult(null);
    setRewindError(null);
    if (isOpen && currentSessionId) {
      loadCheckpoints();
    }
  }, [isOpen, currentSessionId]);

  const loadCheckpoints = async () => {
    if (!currentSessionId) return;
    try {
      const list = await ipcService.invoke(IPC_CHANNELS.CHECKPOINT_LIST, currentSessionId);
      setCheckpoints(list || []);
    } catch {
      setCheckpoints([]);
    }
  };

  const handleSelect = useCallback(async (messageId: string) => {
    setSelectedMessageId(messageId);
    setRewindError(null);
    setCheckoutResult(null);
    if (!currentSessionId) return;
    try {
      const files = await ipcService.invoke(IPC_CHANNELS.CHECKPOINT_PREVIEW, currentSessionId, messageId);
      setPreview(files || []);
    } catch {
      setPreview([]);
    }
  }, [currentSessionId]);

  const handleFilesOnly = async () => {
    if (!selectedMessageId || !currentSessionId) return;
    setIsRewinding(true);
    setRewindError(null);
    try {
      const result = await ipcService.invokeDomain<RestoreWorkspaceFilesAtCheckpointResult>(
        IPC_DOMAINS.SESSION,
        'restoreWorkspaceFilesAtCheckpoint',
        {
          sessionId: currentSessionId,
          checkpointMessageId: selectedMessageId,
        },
      );
      if (result.success) {
        setCheckoutResult(null);
        onClose();
      } else {
        setRewindError(r.rewindFailedRetry);
      }
    } catch (error) {
      setRewindError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRewinding(false);
    }
  };

  const handleTurnCheckout = async () => {
    const selected = checkpoints.find((checkpoint) => checkpoint.messageId === selectedMessageId);
    if (!selected?.anchorUserMessageId || !currentSessionId) return;
    setIsRewinding(true);
    setRewindError(null);
    setCheckoutResult(null);
    try {
      const result = await ipcService.invokeDomain<TurnCheckoutResult>(
        IPC_DOMAINS.SESSION,
        'turnCheckout',
        {
          sessionId: currentSessionId,
          userMessageId: selected.anchorUserMessageId,
          idempotencyKey: `turn-checkout:${currentSessionId}:${selected.anchorUserMessageId}:${crypto.randomUUID()}`,
        },
      );
      setCheckoutResult(result);
      onCheckedOut?.(result);
    } catch (error) {
      setRewindError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRewinding(false);
    }
  };

  const selectedCheckpoint = checkpoints.find((checkpoint) => checkpoint.messageId === selectedMessageId);

  return (
    <>
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={r.title}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setConfirmMode('files')}
            disabled={!selectedMessageId || isRewinding}
          >
            {r.filesOnlyAction}
          </Button>
          <Button
            variant="primary"
            onClick={() => setConfirmMode('checkout')}
            disabled={!selectedCheckpoint?.anchorUserMessageId || isRewinding}
          >
            {isRewinding ? r.rewinding : r.checkoutAction}
          </Button>
        </>
      }
    >
      {rewindError && (
        <div role="alert" className="mb-3 rounded-lg border border-red-700/50 bg-red-950/30 px-3 py-2 text-sm text-badge-danger">
          {r.rewindFailedPrefix.replace('{message}', rewindError)}
        </div>
      )}
      {checkoutResult && (
        <div
          role="status"
          className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
            checkoutResult.state === 'success'
              ? 'border-emerald-800/50 bg-emerald-950/20 text-badge-success'
              : 'border-amber-800/50 bg-amber-950/20 text-badge-warning'
          }`}
        >
          <p className="font-medium">
            {checkoutResult.state === 'success' ? r.checkoutSuccess : r.checkoutPartial}
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            {r.checkoutCounts
              .replace('{files}', String(checkoutResult.restoredFiles.length + checkoutResult.deletedFiles.length))
              .replace('{skipped}', String(checkoutResult.skippedFiles.length))}
          </p>
          {checkoutResult.skippedFiles.map((item) => {
            const file = item.filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? item.filePath;
            const template = item.reason === 'human_edit'
              ? t.chat.turnCheckoutNoteHumanEdit
              : item.reason === 'missing_post_write_digest'
                ? t.chat.turnCheckoutNoteLegacyDigest
                : t.chat.turnCheckoutNoteSnapshotFailed;
            return <p key={`${item.filePath}:${item.reason}`} className="mt-1 text-xs text-zinc-400">{template.replace('{file}', file)}</p>;
          })}
          {checkoutResult.failed
            .filter((item) => item.step !== 'workspace')
            .map((item) => (
              <p key={`${item.step}:${item.reason}`} className="mt-1 text-xs text-zinc-400">
                {item.step}: {item.reason}
              </p>
            ))}
          <p className="mt-1 text-xs text-zinc-400">{r.externalEffectsWarning}</p>
        </div>
      )}
      {/* Checkpoint list */}
      {checkpoints.length === 0 ? (
        <p className="text-zinc-500 text-center py-8 text-sm">{r.noCheckpoints}</p>
      ) : (
        <div className="space-y-1.5">
          {checkpoints.map(cp => (
            <button
              key={cp.messageId}
              type="button"
              aria-pressed={selectedMessageId === cp.messageId}
              onClick={() => handleSelect(cp.messageId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  void handleSelect(cp.messageId);
                }
              }}
              className={`w-full p-3 rounded-lg border cursor-pointer text-left transition-colors ${
                selectedMessageId === cp.messageId
                  ? 'border-badge-info/50 bg-blue-500/10'
                  : 'border-zinc-700 hover:border-zinc-600'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-200">
                  {cp.description || r.checkpointFallback.replace('{id}', cp.id.slice(0, 8))}
                </span>
                <span className="text-xs text-zinc-500">
                  {new Date(cp.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <span className="text-xs text-zinc-500 mt-1 block">
                {r.fileCount.replace('{count}', String(cp.fileCount))}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Preview section */}
      {preview.length > 0 && (
        <div className="mt-3 pt-3 border-t border-zinc-700">
          <p className="text-xs text-zinc-500 mb-1.5">{r.filesAffected}</p>
          <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
            {preview.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className={
                  f.status === 'added' ? 'text-badge-success' :
                  f.status === 'deleted' ? 'text-badge-danger' :
                  'text-badge-warning'
                }>
                  {f.status === 'added' ? '+' : f.status === 'deleted' ? '-' : '~'}
                </span>
                <span className="text-zinc-400 font-mono truncate">{f.filePath}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
    <ConfirmDialog
      isOpen={confirmMode !== null}
      title={confirmMode === 'checkout' ? r.checkoutConfirmTitle : r.confirmTitle}
      message={confirmMode === 'checkout' ? r.checkoutConfirmMessage : r.confirmMessage}
      variant={confirmMode === 'checkout' ? 'warning' : 'danger'}
      confirmText={confirmMode === 'checkout' ? r.checkoutAction : r.confirmAction}
      cancelText={r.cancelRewind}
      onCancel={() => setConfirmMode(null)}
      onConfirm={() => {
        const mode = confirmMode;
        setConfirmMode(null);
        if (mode === 'checkout') void handleTurnCheckout();
        if (mode === 'files') void handleFilesOnly();
      }}
    />
    </>
  );
};
