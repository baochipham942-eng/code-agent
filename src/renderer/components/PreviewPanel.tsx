// ============================================================================
// PreviewPanel - Right side panel for HTML/Web preview
// ============================================================================

import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, File, Folder, X, RefreshCw, ExternalLink, Maximize2, Minimize2, Camera, Eye, Pencil, Save, FolderOpen, Presentation } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { createLogger } from '../utils/logger';
import { isWebMode, copyPathToClipboard } from '../utils/platform';
import { inlineHtmlAssets } from '../utils/inlineHtmlAssets';

const CodeEditor = lazy(() => import('./CodeEditor'));
const CsvTable = lazy(() => import('./CsvTable'));
const LivePreviewFrame = lazy(() => import('./LivePreview/LivePreviewFrame'));
const DocumentBlock = lazy(async () => {
  const module = await import('./features/chat/MessageBubble/DocumentBlock');
  return { default: module.DocumentBlock };
});
const SpreadsheetBlock = lazy(async () => {
  const module = await import('./features/chat/MessageBubble/SpreadsheetBlock');
  return { default: module.SpreadsheetBlock };
});

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
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi']);
const ARCHIVE_EXTS = new Set(['zip']);
const DOCX_EXTS = new Set(['docx']);
const EXCEL_EXTS = new Set(['xlsx', 'xls']);
const PRESENTATION_EXTS = new Set(['pptx']);

type DocumentParagraphType = 'heading' | 'paragraph' | 'list-item';

interface DocxPreviewResult {
  html: string;
  paragraphs: Array<{ index: number; type: string; text: string; level?: number }>;
  text: string;
  wordCount: number;
}

interface ExcelPreviewResult {
  sheets: Array<{ name: string; headers: string[]; rows: unknown[][]; rowCount: number }>;
  sheetCount: number;
}

interface PresentationInspection {
  filePath: string;
  format: 'pptx';
  slideCount: number;
  shownCount: number;
  truncated: boolean;
  slides: Array<{
    index: number;
    name: string;
    title?: string;
    text: string[];
  }>;
}

interface ArchiveInspection {
  filePath: string;
  format: 'zip';
  entryCount: number;
  shownCount: number;
  truncated: boolean;
  entries: Array<{
    name: string;
    isDirectory: boolean;
    depth: number;
    extension?: string;
  }>;
}

function getExtension(filePath: string | null | undefined): string {
  if (!filePath) return '';
  const idx = filePath.lastIndexOf('.');
  return idx < 0 ? '' : filePath.slice(idx + 1).toLowerCase();
}

function basename(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() || filePath;
}

function commandApi() {
  return window.codeAgentAPI || window.electronAPI;
}

function normalizeDocumentParagraphType(value: string): DocumentParagraphType {
  if (value === 'heading' || value === 'list-item') return value;
  return 'paragraph';
}

function paragraphsFromRawText(text: string): DocxPreviewResult['paragraphs'] {
  return text
    .split(/\n{2,}|\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 500)
    .map((line, index) => ({
      index,
      type: 'paragraph',
      text: line,
    }));
}

function buildDocxPreviewSpec(filePath: string, result: DocxPreviewResult): string {
  const normalized = result.paragraphs
    .map((paragraph, index) => ({
      index: typeof paragraph.index === 'number' ? paragraph.index : index,
      type: normalizeDocumentParagraphType(paragraph.type),
      text: paragraph.text.trim(),
      level: paragraph.level,
    }))
    .filter((paragraph) => paragraph.text.length > 0);
  const paragraphs = normalized.length > 0 ? normalized : paragraphsFromRawText(result.text);
  if (paragraphs.length === 0) {
    throw new Error('DOCX preview has no readable paragraphs');
  }

  return JSON.stringify({
    title: basename(filePath).replace(/\.docx$/i, ''),
    paragraphs,
    text: result.text,
    wordCount: result.wordCount,
  });
}

function buildExcelPreviewSpec(filePath: string, result: ExcelPreviewResult): string {
  const sheets = result.sheets.filter((sheet) => sheet.headers.length > 0 || sheet.rows.length > 0);
  if (sheets.length === 0) {
    throw new Error('Excel preview has no readable sheets');
  }
  return JSON.stringify({
    title: basename(filePath).replace(/\.(xlsx|xls)$/i, ''),
    sheets,
    sheetCount: result.sheetCount || sheets.length,
  });
}

async function invokeWorkspace<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.WORKSPACE, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Workspace action failed: ${action}`);
  }
  return response.data as T;
}

function parseArchiveInspection(content: string): ArchiveInspection | null {
  try {
    const parsed = JSON.parse(content) as ArchiveInspection;
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function ArchivePreview({ content }: { content: string }) {
  const inspection = parseArchiveInspection(content);
  if (!inspection) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 p-6 text-sm text-zinc-500">
        Archive inspection is unavailable.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-zinc-950 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <span className="inline-flex items-center gap-1 rounded border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-zinc-200">
          <Archive className="h-3.5 w-3.5" />
          ZIP archive
        </span>
        <span>{inspection.entryCount} entries</span>
        {inspection.truncated && <span>showing first {inspection.shownCount}</span>}
      </div>
      <div className="overflow-hidden rounded-lg border border-white/[0.08]">
        <table className="w-full text-left text-xs">
          <thead className="bg-zinc-900 text-[10px] uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="w-24 px-3 py-2 font-medium">Type</th>
              <th className="w-24 px-3 py-2 font-medium">Ext</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {inspection.entries.map((entry) => (
              <tr key={entry.name} className="bg-zinc-950/60 text-zinc-300">
                <td className="min-w-0 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${Math.min(entry.depth, 8) * 12}px` }}>
                    {entry.isDirectory
                      ? <Folder className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                      : <File className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
                    <span className="truncate font-mono">{entry.name}</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-zinc-500">{entry.isDirectory ? 'Folder' : 'File'}</td>
                <td className="px-3 py-2 text-zinc-500">{entry.extension || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function parsePresentationInspection(content: string): PresentationInspection | null {
  try {
    const parsed = JSON.parse(content) as PresentationInspection;
    if (!parsed || !Array.isArray(parsed.slides)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function PresentationPreview({ content }: { content: string }) {
  const inspection = parsePresentationInspection(content);
  if (!inspection) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 p-6 text-sm text-zinc-500">
        Presentation inspection is unavailable.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-zinc-950 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <span className="inline-flex items-center gap-1 rounded border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-zinc-200">
          <Presentation className="h-3.5 w-3.5" />
          PPTX outline
        </span>
        <span>{inspection.slideCount} slides</span>
        {inspection.truncated && <span>showing first {inspection.shownCount}</span>}
      </div>
      <div className="space-y-2">
        {inspection.slides.map((slide) => (
          <div key={slide.name} className="rounded-lg border border-white/[0.08] bg-zinc-900/70 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-zinc-100">
                  Slide {slide.index}
                  {slide.title ? ` · ${slide.title}` : ''}
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">{slide.name}</div>
              </div>
            </div>
            {slide.text.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs leading-relaxed text-zinc-400">
                {slide.text.slice(0, 20).map((text, index) => (
                  <li key={`${slide.name}:${index}`} className="break-words">
                    {text}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-2 text-xs text-zinc-600">No readable text on this slide.</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
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
  // 预览用 HTML：把同目录相对 css/js 内联进来（srcDoc iframe 无法解析相对引用）。
  // 与可编辑/保存的 content 分开，保存仍写原始 content。
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
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
  const isAudio = AUDIO_EXTS.has(ext);
  const isVideo = VIDEO_EXTS.has(ext);
  const isArchive = ARCHIVE_EXTS.has(ext);
  const isDocx = DOCX_EXTS.has(ext);
  const isExcel = EXCEL_EXTS.has(ext);
  const isPresentation = PRESENTATION_EXTS.has(ext);
  const isOffice = isDocx || isExcel || isPresentation;
  const isBinary = isImage || isPdf || isAudio || isVideo;
  const isDirty = !isBinary && !isArchive && !isOffice && content !== savedContent;

  // Load content when the active tab changes and hasn't been loaded yet.
  useEffect(() => {
    if (!activeTab) return;
    if (activeTab.isLoaded) return;
    void loadContent(activeTab.id, activeTab.path);
  }, [activeTab?.id, activeTab?.isLoaded]);

  // 仅对要走 iframe 渲染的 HTML 产物，内联同目录相对 css/js 供预览。
  // markdown/csv/code/图片/pdf 各有专门渲染路径，不需要。
  useEffect(() => {
    const renderAsHtml = !isMarkdown && !isCsv && !isCode && !isBinary && !isArchive && !isOffice;
    if (!renderAsHtml || !content || !previewFilePath) {
      setPreviewHtml(null);
      return;
    }
    const fileDir = previewFilePath.slice(0, previewFilePath.lastIndexOf('/'));
    let cancelled = false;
    void inlineHtmlAssets(content, fileDir, (absPath) =>
      invokeWorkspace<string>('readFile', { filePath: absPath }),
    )
      .then((html) => { if (!cancelled) setPreviewHtml(html); })
      .catch(() => { if (!cancelled) setPreviewHtml(null); });
    return () => { cancelled = true; };
  }, [content, previewFilePath, isMarkdown, isCsv, isCode, isBinary, isArchive, isOffice]);

  const loadContent = async (tabId: string, filePath: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const tabExt = getExtension(filePath);
      const isArchiveTab = ARCHIVE_EXTS.has(tabExt);
      const isDocxTab = DOCX_EXTS.has(tabExt);
      const isExcelTab = EXCEL_EXTS.has(tabExt);
      const isPresentationTab = PRESENTATION_EXTS.has(tabExt);
      const isBinaryTab = IMAGE_EXTS.has(tabExt)
        || PDF_EXTS.has(tabExt)
        || AUDIO_EXTS.has(tabExt)
        || VIDEO_EXTS.has(tabExt);
      if (isArchiveTab) {
        const inspection = await invokeWorkspace<ArchiveInspection>('inspectArchive', {
          filePath,
          limit: 200,
        });
        markPreviewTabLoaded(tabId, JSON.stringify(inspection, null, 2));
      } else if (isPresentationTab) {
        const inspection = await invokeWorkspace<PresentationInspection>('inspectPresentation', {
          filePath,
          limit: 80,
        });
        markPreviewTabLoaded(tabId, JSON.stringify(inspection, null, 2));
      } else if (isDocxTab) {
        const result = await commandApi()?.extractDocxHtml(filePath);
        if (!result) throw new Error('DOCX preview extractor is unavailable');
        markPreviewTabLoaded(tabId, buildDocxPreviewSpec(filePath, result));
      } else if (isExcelTab) {
        const result = await commandApi()?.extractExcelJson(filePath);
        if (!result) throw new Error('Excel preview extractor is unavailable');
        markPreviewTabLoaded(tabId, buildExcelPreviewSpec(filePath, result));
      } else if (isBinaryTab) {
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

  // Live dev server preview — 完全独立的渲染路径，绕开文件加载和编辑器逻辑
  if (activeTab.kind === 'liveDev' && activeTab.devServerUrl) {
    return (
      <div
        className={`flex flex-col bg-zinc-900 transition-all duration-300 ${
          isMaximized ? 'fixed inset-0 z-50' : 'w-full h-full'
        }`}
      >
        <Suspense fallback={<div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">加载 Live Preview...</div>}>
          <LivePreviewFrame
            key={`${activeTab.id}:${activeTab.devServerUrl}`}
            tabId={activeTab.id}
            devServerUrl={activeTab.devServerUrl}
          />
        </Suspense>
      </div>
    );
  }

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
            disabled={isExporting || isLoading || !!error || isMarkdown || isCsv || isCode || isBinary || isArchive || isOffice}
            className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={isMarkdown || isCsv || isCode || isBinary || isArchive || isOffice ? '长图仅支持 HTML 预览' : '导出长图'}
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
      <div className={`flex-1 overflow-hidden ${isMarkdown || isCsv || isImage || isAudio || isVideo || isArchive || isOffice ? 'bg-zinc-900' : 'bg-white'}`}>
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
        ) : isAudio ? (
          <div className="flex h-full items-center justify-center overflow-auto bg-zinc-950 p-6">
            <div className="w-full max-w-2xl rounded-lg border border-white/[0.08] bg-zinc-900 p-4">
              <div className="mb-3 truncate text-sm font-medium text-zinc-100">
                {previewFilePath?.split('/').pop() || 'Audio preview'}
              </div>
              <audio controls src={content} className="w-full" />
            </div>
          </div>
        ) : isVideo ? (
          <div className="flex h-full items-center justify-center overflow-auto bg-zinc-950 p-4">
            <video
              controls
              src={content}
              className="max-h-full max-w-full rounded-lg border border-white/[0.08] bg-black"
            />
          </div>
        ) : isArchive ? (
          <ArchivePreview content={content} />
        ) : isPresentation ? (
          <PresentationPreview content={content} />
        ) : isDocx ? (
          <div className="h-full overflow-auto bg-zinc-950 p-4">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                  加载文档...
                </div>
              }
            >
              <DocumentBlock spec={content} />
            </Suspense>
          </div>
        ) : isExcel ? (
          <div className="h-full overflow-auto bg-zinc-950 p-4">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                  加载表格...
                </div>
              }
            >
              <SpreadsheetBlock spec={content} filePath={previewFilePath ?? undefined} />
            </Suspense>
          </div>
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
              jumpToLine={activeTab.jumpToLine}
              jumpNonce={activeTab.jumpNonce}
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
              jumpToLine={activeTab.jumpToLine}
              jumpNonce={activeTab.jumpNonce}
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
            srcDoc={previewHtml ?? content}
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
