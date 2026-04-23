// ============================================================================
// PreviewPanel - Right side panel for HTML/Web preview
// ============================================================================

import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, ExternalLink, Maximize2, Minimize2, Camera, Eye, Pencil, Save, FolderOpen } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { createLogger } from '../utils/logger';
import { isWebMode, copyPathToClipboard } from '../utils/platform';

const CodeEditor = lazy(() => import('./CodeEditor'));
const CsvTable = lazy(() => import('./CsvTable'));

const logger = createLogger('PreviewPanel');

const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);
const CSV_EXTS: Record<string, ',' | '\t'> = { csv: ',', tsv: '\t' };
// Code files render in edit-only mode (no rendered form exists) via CodeEditor.
const CODE_LANGUAGE_BY_EXT: Record<string, 'json' | 'yaml' | 'typescript' | 'javascript'> = {
  json: 'json',
  yaml: 'yaml',
  yml:  'yaml',
  ts:   'typescript',
  tsx:  'typescript',
  js:   'javascript',
  jsx:  'javascript',
};
// Media types render via a data: URL built from the binary fetched over IPC.
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg']);
const PDF_EXTS = new Set(['pdf']);

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
  const codeLanguage = CODE_LANGUAGE_BY_EXT[ext];
  const isCode = codeLanguage !== undefined;
  const isImage = IMAGE_EXTS.has(ext);
  const isPdf = PDF_EXTS.has(ext);
  const isBinary = isImage || isPdf;
  const isDirty = !isBinary && content !== savedContent;

  // Load content when the active tab changes and hasn't been loaded yet.
  useEffect(() => {
    if (!activeTab) return;
    if (activeTab.isLoaded) return;
    void loadContent(activeTab.id, activeTab.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.isLoaded]);

  const loadContent = async (tabId: string, filePath: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const tabExt = getExtension(filePath);
      const isBinaryTab = IMAGE_EXTS.has(tabExt) || PDF_EXTS.has(tabExt);
      if (isBinaryTab) {
        // Media: fetch as base64 + mime, store the data: URL as content. It
        // never diverges from savedContent (read-only), so isDirty stays false.
        const binary = await invokeWorkspace<{ base64: string; mimeType: string }>(
          'readBinary', { filePath },
        );
        const dataUrl = `data:${binary.mimeType};base64,${binary.base64}`;
        markPreviewTabLoaded(tabId, dataUrl);
      } else {
        const fetched = await invokeWorkspace<string>('readFile', { filePath });
        // readFile returns '' for empty files — that's valid content, not an error.
        markPreviewTabLoaded(tabId, fetched ?? '');
      }
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

  const handleRevealInFolder = async () => {
    if (!previewFilePath) return;
    try {
      if (isWebMode()) {
        await copyPathToClipboard(previewFilePath);
        return;
      }
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(previewFilePath);
    } catch (err) {
      logger.error('Failed to reveal in folder', err);
    }
  };

  if (!activeTab) return null;

  return (
    <div
      className={`flex flex-col bg-zinc-900 transition-all duration-300 ${
        isMaximized ? 'fixed inset-0 z-50' : 'w-full h-full'
      }`}
    >
      {/* Actions row (filename + dirty indicator + close moved into workbench tab bar) */}
      <div className="flex items-center justify-end px-4 py-3 border-b border-zinc-700 bg-zinc-800">
        <div className="flex items-center gap-1">
          {isMarkdown && (
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
          )}
          {(isMarkdown || isCode) && (
            <button
              onClick={handleSave}
              disabled={!isDirty || isSaving}
              className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={isDirty ? '保存 (Cmd+S)' : '已保存'}
            >
              <Save className={`w-4 h-4 ${isSaving ? 'animate-pulse' : ''}`} />
            </button>
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
            disabled={isExporting || isLoading || !!error || isMarkdown || isCsv || isCode || isBinary}
            className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={isMarkdown || isCsv || isCode || isBinary ? '长图仅支持 HTML 预览' : '导出长图'}
          >
            <Camera className={`w-4 h-4 ${isExporting ? 'animate-pulse' : ''}`} />
          </button>
          <button
            onClick={handleRevealInFolder}
            className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="在 Finder 中显示"
          >
            <FolderOpen className="w-4 h-4" />
          </button>
          <button
            onClick={handleOpenInBrowser}
            className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="用默认程序打开"
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
        ) : isImage ? (
          <div className="flex items-center justify-center h-full overflow-auto bg-zinc-950 p-4">
            <img
              src={content}
              alt={previewFilePath ?? 'image preview'}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : isPdf ? (
          <embed
            src={content}
            type="application/pdf"
            className="w-full h-full"
          />
        ) : isCode && codeLanguage ? (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
                加载编辑器...
              </div>
            }
          >
            <CodeEditor
              value={content}
              onChange={(next: string) => updatePreviewTabContent(activeTab.id, next)}
              onSave={handleSave}
              language={codeLanguage}
            />
          </Suspense>
        ) : isMarkdown && mode === 'edit' ? (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
                加载编辑器...
              </div>
            }
          >
            <CodeEditor
              value={content}
              onChange={(next: string) => updatePreviewTabContent(activeTab.id, next)}
              onSave={handleSave}
              language="markdown"
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
