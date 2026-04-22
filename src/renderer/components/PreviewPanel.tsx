// ============================================================================
// PreviewPanel - Right side panel for HTML/Web preview
// ============================================================================

import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, ExternalLink, Maximize2, Minimize2, Camera, Eye, Pencil, Save } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { createLogger } from '../utils/logger';
import { isWebMode, copyPathToClipboard } from '../utils/platform';
import { PreviewTabs } from './PreviewTabs';

const MarkdownEditor = lazy(() => import('./MarkdownEditor'));
const CsvTable = lazy(() => import('./CsvTable'));

const logger = createLogger('PreviewPanel');

const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);
const CSV_EXTS: Record<string, ',' | '\t'> = { csv: ',', tsv: '\t' };

function getExtension(filePath: string | null | undefined): string {
  if (!filePath) return '';
  const idx = filePath.lastIndexOf('.');
  return idx < 0 ? '' : filePath.slice(idx + 1).toLowerCase();
}

async function invokeWorkspace<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.WORKSPACE, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Workspace action failed: ${action}`);
  }
  return response.data as T;
}

export const PreviewPanel: React.FC = () => {
  const previewTabs = useAppStore((s) => s.previewTabs);
  const activePreviewTabId = useAppStore((s) => s.activePreviewTabId);
  const showPreviewPanel = useAppStore((s) => s.showPreviewPanel);
  const closePreview = useAppStore((s) => s.closePreview);
  const updatePreviewTabContent = useAppStore((s) => s.updatePreviewTabContent);
  const updatePreviewTabMode = useAppStore((s) => s.updatePreviewTabMode);
  const markPreviewTabLoaded = useAppStore((s) => s.markPreviewTabLoaded);
  const markPreviewTabSaved = useAppStore((s) => s.markPreviewTabSaved);

  const activeTab = useMemo(
    () => previewTabs.find((t) => t.id === activePreviewTabId) ?? null,
    [previewTabs, activePreviewTabId],
  );

  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const previewFilePath = activeTab?.path ?? null;
  const content = activeTab?.content ?? '';
  const savedContent = activeTab?.savedContent ?? '';
  const mode = activeTab?.mode ?? 'preview';

  const ext = getExtension(previewFilePath);
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  const csvDelimiter = CSV_EXTS[ext];
  const isCsv = csvDelimiter !== undefined;
  const isDirty = content !== savedContent;

  // Load content when the active tab changes and hasn't been loaded yet.
  useEffect(() => {
    if (!activeTab || !showPreviewPanel) return;
    if (activeTab.isLoaded) return;
    void loadContent(activeTab.id, activeTab.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.isLoaded, showPreviewPanel]);

  const loadContent = async (tabId: string, filePath: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const fetched = await invokeWorkspace<string>('readFile', { filePath });
      // readFile returns '' for empty files — that's valid content, not an error.
      markPreviewTabLoaded(tabId, fetched ?? '');
    } catch (err) {
      logger.error('Failed to load file', err);
      setError(err instanceof Error ? err.message : '加载文件失败');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefresh = () => {
    if (activeTab) void loadContent(activeTab.id, activeTab.path);
  };

  const handleSave = async () => {
    if (!activeTab || !isDirty || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      await invokeWorkspace('writeFile', { filePath: activeTab.path, content: activeTab.content });
      markPreviewTabSaved(activeTab.id);
    } catch (err) {
      logger.error('Failed to save file', err);
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportLongScreenshot = async () => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // srcDoc iframe 与主文档同源，parent 可访问 contentDocument
    const doc = iframe.contentDocument;
    const target = doc?.documentElement;
    if (!doc || !target) {
      setError('无法访问预览文档（可能是跨域限制）');
      return;
    }

    setIsExporting(true);
    setError(null);
    try {
      // 懒加载 html2canvas（~45KB gzipped）
      const { default: html2canvas } = await import('html2canvas');
      const canvas = await html2canvas(target, {
        // scrollHeight 让整页（包括视口外）都被渲染
        width: target.scrollWidth,
        height: target.scrollHeight,
        windowWidth: target.scrollWidth,
        windowHeight: target.scrollHeight,
        useCORS: true,
        allowTaint: false,
        logging: false,
        backgroundColor: null,
      });

      canvas.toBlob((blob) => {
        if (!blob) {
          setError('生成截图失败');
          setIsExporting(false);
          return;
        }
        const url = URL.createObjectURL(blob);
        const fileName = (previewFilePath?.split('/').pop() || 'preview').replace(/\.[^.]+$/, '');
        const a = document.createElement('a');
        a.href = url;
        a.download = `${fileName}-long-screenshot.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setIsExporting(false);
      }, 'image/png');
    } catch (err) {
      logger.error('Long screenshot export failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      // CORS tainted canvas 会抛 SecurityError
      if (msg.includes('tainted') || msg.includes('SecurityError')) {
        setError('存在跨域外链资源，无法生成截图。请本地化资源后重试。');
      } else {
        setError(`导出截图失败：${msg}`);
      }
      setIsExporting(false);
    }
  };

  const handleOpenInBrowser = async () => {
    if (!previewFilePath) return;
    try {
      if (isWebMode()) {
        await copyPathToClipboard(previewFilePath);
        return;
      }
      await invokeWorkspace('openPath', { filePath: previewFilePath });
    } catch (err) {
      logger.error('Failed to open in browser', err);
    }
  };

  if (!showPreviewPanel || !activeTab) return null;

  const fileName = previewFilePath?.split('/').pop() || '预览';

  return (
    <div
      className={`flex flex-col bg-zinc-900 border-l border-zinc-700 transition-all duration-300 ${
        isMaximized ? 'fixed inset-0 z-50' : 'w-[500px]'
      }`}
    >
      <PreviewTabs />
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 bg-zinc-800">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-green-500" />
          <span className="text-sm font-medium text-zinc-200 truncate max-w-[200px]">
            {fileName}
            {isMarkdown && isDirty && (
              <span className="ml-1 text-amber-400" title="未保存">•</span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {isMarkdown && (
            <>
              <button
                onClick={() => updatePreviewTabMode(activeTab.id, mode === 'edit' ? 'preview' : 'edit')}
                className={`p-1.5 rounded transition-colors ${
                  mode === 'edit'
                    ? 'bg-primary-500/20 text-primary-300 hover:bg-primary-500/30'
                    : 'hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200'
                }`}
                title={mode === 'edit' ? '切到预览' : '切到编辑'}
              >
                {mode === 'edit'
                  ? <Eye className="w-4 h-4" />
                  : <Pencil className="w-4 h-4" />}
              </button>
              <button
                onClick={handleSave}
                disabled={!isDirty || isSaving}
                className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title={isDirty ? '保存 (Cmd+S)' : '已保存'}
              >
                <Save className={`w-4 h-4 ${isSaving ? 'animate-pulse' : ''}`} />
              </button>
            </>
          )}
          <button
            onClick={handleRefresh}
            className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={handleExportLongScreenshot}
            disabled={isExporting || isLoading || !!error || isMarkdown || isCsv}
            className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={isMarkdown || isCsv ? '长图仅支持 HTML 预览' : '导出长图'}
          >
            <Camera className={`w-4 h-4 ${isExporting ? 'animate-pulse' : ''}`} />
          </button>
          <button
            onClick={handleOpenInBrowser}
            className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="在浏览器中打开"
          >
            <ExternalLink className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsMaximized(!isMaximized)}
            className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors"
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
            className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className={`flex-1 overflow-hidden ${isMarkdown || isCsv ? 'bg-zinc-900' : 'bg-white'}`}>
        {isLoading ? (
          <div className="flex items-center justify-center h-full bg-zinc-700">
            <div className="flex flex-col items-center gap-3">
              <RefreshCw className="w-8 h-8 text-zinc-400 animate-spin" />
              <span className="text-sm text-zinc-400">加载中...</span>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full bg-zinc-700">
            <div className="flex flex-col items-center gap-3 text-center px-4">
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                <X className="w-6 h-6 text-red-400" />
              </div>
              <span className="text-sm text-red-400">{error}</span>
              <button
                onClick={handleRefresh}
                className="px-4 py-2 rounded-lg bg-zinc-600 text-zinc-200 text-sm hover:bg-zinc-600 transition-colors"
              >
                重试
              </button>
            </div>
          </div>
        ) : isMarkdown && mode === 'edit' ? (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
                加载编辑器...
              </div>
            }
          >
            <MarkdownEditor
              value={content}
              onChange={(next) => updatePreviewTabContent(activeTab.id, next)}
              onSave={handleSave}
            />
          </Suspense>
        ) : isMarkdown ? (
          <div className="h-full overflow-y-auto px-6 py-4">
            <article className="prose prose-invert prose-sm max-w-none prose-pre:bg-zinc-950 prose-pre:border prose-pre:border-zinc-800">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                {content}
              </ReactMarkdown>
            </article>
          </div>
        ) : isCsv && csvDelimiter ? (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
                加载表格...
              </div>
            }
          >
            <CsvTable content={content} delimiter={csvDelimiter} />
          </Suspense>
        ) : (
          <iframe
            ref={iframeRef}
            srcDoc={content}
            className="w-full h-full border-0"
            title="HTML Preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        )}
      </div>

      {/* Footer - File path */}
      <div className="px-4 py-2 border-t border-zinc-700 bg-zinc-800">
        <span className="text-xs text-zinc-500 truncate block">
          {previewFilePath}
        </span>
      </div>
    </div>
  );
};
