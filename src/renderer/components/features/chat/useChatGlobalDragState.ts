// ============================================================================
// useChatGlobalDragState - ChatView 全局拖拽高亮状态
// （N-MAXLINES-MINEFIELD-2-FU1-S10 自 ChatView.tsx 原样搬移：回调体与依赖数组逐字保留；
// 与 useChatGlobalFileDrop 分工——本 hook 只管 drag-over 高亮，drop 处理在隔壁）
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { isDragPointInsideVisibleRect } from '../../../utils/dragBounds';

export function useChatGlobalDragState() {
  // Global drop zone state
  const globalDropZoneRef = useRef<HTMLDivElement>(null);
  const [isGlobalDragOver, setIsGlobalDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const clearGlobalDragState = useCallback(() => {
    dragCounterRef.current = 0;
    setIsGlobalDragOver(false);
  }, []);
  const isDragInsideGlobalDropZone = useCallback((event: { clientX: number; clientY: number }) => {
    const rect = globalDropZoneRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return isDragPointInsideVisibleRect(event, rect, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }, []);

  useEffect(() => {
    if (!isGlobalDragOver) return;
    const handleWindowDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      if (!isDragInsideGlobalDropZone(event)) {
        clearGlobalDragState();
      }
    };
    const handleWindowDragLeave = (event: DragEvent) => {
      if (!isDragInsideGlobalDropZone(event)) {
        clearGlobalDragState();
      }
    };
    window.addEventListener('dragend', clearGlobalDragState);
    window.addEventListener('drop', clearGlobalDragState);
    window.addEventListener('blur', clearGlobalDragState);
    window.addEventListener('dragover', handleWindowDragOver, true);
    window.addEventListener('dragleave', handleWindowDragLeave, true);
    return () => {
      window.removeEventListener('dragend', clearGlobalDragState);
      window.removeEventListener('drop', clearGlobalDragState);
      window.removeEventListener('blur', clearGlobalDragState);
      window.removeEventListener('dragover', handleWindowDragOver, true);
      window.removeEventListener('dragleave', handleWindowDragLeave, true);
    };
  }, [clearGlobalDragState, isDragInsideGlobalDropZone, isGlobalDragOver]);

  const handleGlobalDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer.types.includes('Files')) return;
    dragCounterRef.current++;
    if (isDragInsideGlobalDropZone(e)) {
      setIsGlobalDragOver(true);
    }
  }, [isDragInsideGlobalDropZone]);

  const handleGlobalDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer.types.includes('Files')) return;
    if (!isDragInsideGlobalDropZone(e)) {
      clearGlobalDragState();
      return;
    }
    e.dataTransfer.dropEffect = 'copy';
    setIsGlobalDragOver(true);
  }, [clearGlobalDragState, isDragInsideGlobalDropZone]);

  const handleGlobalDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragInsideGlobalDropZone(e)) {
      clearGlobalDragState();
      return;
    }
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsGlobalDragOver(false);
    }
  }, [clearGlobalDragState, isDragInsideGlobalDropZone]);

  return {
    globalDropZoneRef,
    isGlobalDragOver,
    clearGlobalDragState,
    handleGlobalDragEnter,
    handleGlobalDragOver,
    handleGlobalDragLeave,
  };
}
