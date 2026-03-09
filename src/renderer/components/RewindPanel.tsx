// ============================================================================
// RewindPanel - Esc+Esc 触发的检查点回退面板
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import { useSessionStore } from '../stores/sessionStore';

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
  const { currentSessionId } = useSessionStore();

  useEffect(() => {
    if (isOpen && currentSessionId) {
      loadCheckpoints();
    }
  }, [isOpen, currentSessionId]);

  const loadCheckpoints = async () => {
    if (!currentSessionId) return;
    try {
      const list = await window.electronAPI?.invoke(IPC_CHANNELS.CHECKPOINT_LIST, currentSessionId);
      setCheckpoints(list || []);
    } catch {
      setCheckpoints([]);
    }
  };

  const handleSelect = useCallback(async (messageId: string) => {
    setSelectedMessageId(messageId);
    if (!currentSessionId) return;
    try {
      const files = await window.electronAPI?.invoke(IPC_CHANNELS.CHECKPOINT_PREVIEW, currentSessionId, messageId);
      setPreview(files || []);
    } catch {
      setPreview([]);
    }
  }, [currentSessionId]);

  const handleRewind = async () => {
    if (!selectedMessageId || !currentSessionId) return;
    setIsRewinding(true);
    try {
      const result = await window.electronAPI?.invoke(IPC_CHANNELS.CHECKPOINT_REWIND, currentSessionId, selectedMessageId);
      if (result?.success) {
        onClose();
      }
    } finally {
      setIsRewinding(false);
    }
  };

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center backdrop-blur-sm">
      <div className="bg-deep border border-border-default rounded-xl shadow-2xl w-[520px] max-h-[600px] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-border-default flex items-center justify-between">
          <h2 className="text-base font-semibold text-text-primary">Rewind to Checkpoint</h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-secondary transition-colors text-lg">
            &times;
          </button>
        </div>

        {/* Checkpoint list */}
        <div className="flex-1 overflow-y-auto p-3">
          {checkpoints.length === 0 ? (
            <p className="text-text-tertiary text-center py-8 text-sm">No checkpoints available</p>
          ) : (
            <div className="space-y-1.5">
              {checkpoints.map(cp => (
                <div
                  key={cp.messageId}
                  onClick={() => handleSelect(cp.messageId)}
                  className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedMessageId === cp.messageId
                      ? 'border-blue-500/50 bg-blue-500/10'
                      : 'border-border-default hover:border-border-strong'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-primary">
                      {cp.description || `Checkpoint ${cp.id.slice(0, 8)}`}
                    </span>
                    <span className="text-xs text-text-tertiary">
                      {new Date(cp.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <span className="text-xs text-text-tertiary mt-1 block">
                    {cp.fileCount} file{cp.fileCount !== 1 ? 's' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Preview section */}
        {preview.length > 0 && (
          <div className="px-4 py-2 border-t border-border-default">
            <p className="text-xs text-text-tertiary mb-1.5">Files affected:</p>
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
                  <span className="text-text-secondary font-mono truncate">{f.filePath}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="p-4 border-t border-border-default flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleRewind}
            disabled={!selectedMessageId || isRewinding}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg disabled:opacity-40 hover:bg-blue-500 transition-colors"
          >
            {isRewinding ? 'Rewinding...' : 'Rewind'}
          </button>
        </div>
      </div>
    </div>
  );
};
