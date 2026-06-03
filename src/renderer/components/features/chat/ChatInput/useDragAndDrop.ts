// ============================================================================
// useDragAndDrop - 拖放附件处理 Hook
//
// 从 ChatInput/index.tsx 抽出（架构债闸门：单文件有效行 ≤1000）。
// 管理拖放高亮状态 + 文件/文件夹拖入转附件。
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import type { MessageAttachment } from '../../../../../shared/contract';
import { UI } from '@shared/constants';
import { collectDroppedAttachments } from './utils';

interface UseDragAndDropOptions {
  processFile: (file: File) => Promise<MessageAttachment | null>;
  processFolderEntry: (
    dirEntry: FileSystemDirectoryEntry,
    folderName: string
  ) => Promise<MessageAttachment | null>;
  setAttachments: React.Dispatch<React.SetStateAction<MessageAttachment[]>>;
  setIsUploading: (uploading: boolean) => void;
}

export function useDragAndDrop({
  processFile,
  processFolderEntry,
  setAttachments,
  setIsUploading,
}: UseDragAndDropOptions) {
  const [isDragOver, setIsDragOver] = useState(false);

  const clearDragState = useCallback(() => {
    setIsDragOver(false);
  }, []);

  // 拖拽中断兜底：dragend / 窗口失焦 / drop 在别处时清掉高亮
  useEffect(() => {
    if (!isDragOver) return;
    window.addEventListener('dragend', clearDragState);
    window.addEventListener('drop', clearDragState);
    window.addEventListener('blur', clearDragState);
    return () => {
      window.removeEventListener('dragend', clearDragState);
      window.removeEventListener('drop', clearDragState);
      window.removeEventListener('blur', clearDragState);
    };
  }, [clearDragState, isDragOver]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    setIsUploading(true);

    try {
      const newAttachments = await collectDroppedAttachments(e.dataTransfer, processFile, processFolderEntry);

      if (newAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...newAttachments].slice(0, UI.MAX_ATTACHMENTS_DROP));
      }
    } finally {
      setIsUploading(false);
    }
  }, [processFile, processFolderEntry, setAttachments, setIsUploading]);

  return { isDragOver, handleDragOver, handleDragLeave, handleDrop };
}

export default useDragAndDrop;
