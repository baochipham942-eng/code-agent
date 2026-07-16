// ============================================================================
// RewindPanel - Esc+Esc 触发的检查点回退面板
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import { useSessionStore } from '../stores/sessionStore';
import ipcService from '../services/ipcService';
import { Button, Modal } from './primitives';
import { ConfirmDialog } from './composites/ConfirmDialog';

interface Checkpoint {
  id: string;
  timestamp: number;
  messageId: string;
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
}

export const RewindPanel: React.FC<RewindPanelProps> = ({ isOpen, onClose }) => {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewFile[]>([]);
  const [isRewinding, setIsRewinding] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [rewindError, setRewindError] = useState<string | null>(null);
  const { currentSessionId } = useSessionStore();

  useEffect(() => {
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
    if (!currentSessionId) return;
    try {
      const files = await ipcService.invoke(IPC_CHANNELS.CHECKPOINT_PREVIEW, currentSessionId, messageId);
      setPreview(files || []);
    } catch {
      setPreview([]);
    }
  }, [currentSessionId]);

  const handleRewind = async () => {
    if (!selectedMessageId || !currentSessionId) return;
    setIsRewinding(true);
    setRewindError(null);
    try {
      const result = await ipcService.invoke(IPC_CHANNELS.CHECKPOINT_REWIND, currentSessionId, selectedMessageId);
      if (result?.success) {
        onClose();
      } else {
        setRewindError(result?.error || 'Rewind failed. Please try again.');
      }
    } catch (error) {
      setRewindError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRewinding(false);
    }
  };

  return (
    <>
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Rewind to Checkpoint"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => setIsConfirmOpen(true)}
            disabled={!selectedMessageId || isRewinding}
          >
            {isRewinding ? 'Rewinding...' : 'Rewind'}
          </Button>
        </>
      }
    >
      {rewindError && (
        <div role="alert" className="mb-3 rounded-lg border border-red-700/50 bg-red-950/30 px-3 py-2 text-sm text-red-200">
          Rewind failed: {rewindError}
        </div>
      )}
      {/* Checkpoint list */}
      {checkpoints.length === 0 ? (
        <p className="text-zinc-500 text-center py-8 text-sm">No checkpoints available</p>
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
                  ? 'border-blue-500/50 bg-blue-500/10'
                  : 'border-zinc-700 hover:border-zinc-600'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-200">
                  {cp.description || `Checkpoint ${cp.id.slice(0, 8)}`}
                </span>
                <span className="text-xs text-zinc-500">
                  {new Date(cp.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <span className="text-xs text-zinc-500 mt-1 block">
                {cp.fileCount} file{cp.fileCount !== 1 ? 's' : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Preview section */}
      {preview.length > 0 && (
        <div className="mt-3 pt-3 border-t border-zinc-700">
          <p className="text-xs text-zinc-500 mb-1.5">Files affected:</p>
          <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
            {preview.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className={
                  f.status === 'added' ? 'text-green-400' :
                  f.status === 'deleted' ? 'text-red-400' :
                  'text-yellow-400'
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
      isOpen={isConfirmOpen}
      title="Rewind workspace files?"
      message="Your workspace files will be replaced with the selected checkpoint. Current changes may be lost."
      variant="danger"
      confirmText="Rewind now"
      cancelText="Cancel rewind"
      onCancel={() => setIsConfirmOpen(false)}
      onConfirm={() => {
        setIsConfirmOpen(false);
        void handleRewind();
      }}
    />
    </>
  );
};
