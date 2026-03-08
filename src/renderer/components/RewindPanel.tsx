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
        // 刷新前端消息列表（后端已截断 DB + orchestrator 内存）
        const messages = await window.electronAPI?.invoke(IPC_CHANNELS.SESSION_GET_MESSAGES, currentSessionId);
        if (messages) {
          useSessionStore.getState().setMessages(messages);
        }
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
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[520px] max-h-[600px] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-zinc-700/50 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100">Rewind to Checkpoint</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors text-lg">
            &times;
          </button>
        </div>

        {/* Checkpoint list */}
        <div className="flex-1 overflow-y-auto p-3">
          {checkpoints.length === 0 ? (
            <p className="text-zinc-500 text-center py-8 text-sm">No checkpoints available</p>
          ) : (
            <div className="space-y-1.5">
              {checkpoints.map(cp => (
                <div
                  key={cp.messageId}
                  onClick={() => handleSelect(cp.messageId)}
                  className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedMessageId === cp.messageId
                      ? 'border-blue-500/50 bg-blue-500/10'
                      : 'border-zinc-700/50 hover:border-zinc-600'
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
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Preview section */}
        {preview.length > 0 && (
          <div className="px-4 py-2 border-t border-zinc-700/50">
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

        {/* Actions */}
        <div className="p-4 border-t border-zinc-700/50 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
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
