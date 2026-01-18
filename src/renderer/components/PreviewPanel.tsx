// ============================================================================
// PreviewPanel - Right side panel for HTML/Web preview
// ============================================================================

import React, { useEffect, useState } from 'react';
import { X, RefreshCw, ExternalLink, Maximize2, Minimize2 } from 'lucide-react';
import { useAppStore } from '../stores/appStore';

export const PreviewPanel: React.FC = () => {
  const { previewFilePath, showPreviewPanel, closePreview } = useAppStore();
  const [htmlContent, setHtmlContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  // Load HTML content when file path changes
  useEffect(() => {
    if (previewFilePath && showPreviewPanel) {
      loadHtmlContent();
    }
  }, [previewFilePath, showPreviewPanel]);

  const loadHtmlContent = async () => {
    if (!previewFilePath) return;

    setIsLoading(true);
    setError(null);

    try {
      const content = await window.electronAPI?.invoke('workspace:read-file', previewFilePath);
      if (content) {
        setHtmlContent(content);
      } else {
        setError('无法读取文件内容');
      }
    } catch (err) {
      console.error('Failed to load HTML:', err);
      setError(err instanceof Error ? err.message : '加载文件失败');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefresh = () => {
    loadHtmlContent();
  };

  const handleOpenInBrowser = async () => {
    if (previewFilePath) {
      try {
        await window.electronAPI?.invoke('shell:open-path', previewFilePath);
      } catch (err) {
        console.error('Failed to open in browser:', err);
      }
    }
  };

  if (!showPreviewPanel) return null;

  const fileName = previewFilePath?.split('/').pop() || '预览';

  return (
    <div
      className={`flex flex-col bg-zinc-900 border-l border-zinc-700 transition-all duration-300 ${
        isMaximized ? 'fixed inset-0 z-50' : 'w-[500px]'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 bg-zinc-800/50">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-green-500" />
          <span className="text-sm font-medium text-zinc-200 truncate max-w-[200px]">
            {fileName}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={handleOpenInBrowser}
            className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="在浏览器中打开"
          >
            <ExternalLink className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsMaximized(!isMaximized)}
            className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            title={isMaximized ? '还原' : '最大化'}
          >
            {isMaximized ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={closePreview}
            className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden bg-white">
        {isLoading ? (
          <div className="flex items-center justify-center h-full bg-zinc-800">
            <div className="flex flex-col items-center gap-3">
              <RefreshCw className="w-8 h-8 text-zinc-400 animate-spin" />
              <span className="text-sm text-zinc-400">加载中...</span>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full bg-zinc-800">
            <div className="flex flex-col items-center gap-3 text-center px-4">
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                <X className="w-6 h-6 text-red-400" />
              </div>
              <span className="text-sm text-red-400">{error}</span>
              <button
                onClick={handleRefresh}
                className="px-4 py-2 rounded-lg bg-zinc-700 text-zinc-200 text-sm hover:bg-zinc-600 transition-colors"
              >
                重试
              </button>
            </div>
          </div>
        ) : (
          <iframe
            srcDoc={htmlContent}
            className="w-full h-full border-0"
            title="HTML Preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        )}
      </div>

      {/* Footer - File path */}
      <div className="px-4 py-2 border-t border-zinc-700 bg-zinc-800/50">
        <span className="text-xs text-zinc-500 truncate block">
          {previewFilePath}
        </span>
      </div>
    </div>
  );
};
