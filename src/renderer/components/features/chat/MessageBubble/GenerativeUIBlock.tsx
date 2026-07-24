// ============================================================================
// GenerativeUIBlock - Sandboxed iframe renderer for AI-generated HTML widgets
// ============================================================================

import { memo, useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import { Sparkles, Code2, Copy, Check, ExternalLink, MousePointerClick, X } from 'lucide-react';
import { UI } from '@shared/constants';
import { useI18n } from '../../../../hooks/useI18n';
import {
  attachHtmlLocalitySelection,
  type HtmlElementSelection,
  type HtmlLocalitySelectionController,
} from '../../../../utils/htmlLocality';
import {
  buildEditSrcdoc,
  buildPreviewSrcdoc,
  EDIT_SANDBOX,
  PREVIEW_SANDBOX,
} from './generativeUIDocument';

// Prism 语法高亮按需动态加载,只在用户点开"查看源码"时才下载。
const LazyPrismCodeBlock = lazy(() => import('./PrismCodeBlock'));

const MIN_IFRAME_HEIGHT = 100;
const MAX_IFRAME_HEIGHT = 600;

function isResizeMessage(value: unknown): value is { type: 'generative-ui-resize'; height: number } {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { type?: unknown }).type === 'generative-ui-resize'
    && typeof (value as { height?: unknown }).height === 'number'
  );
}

// Simple source code viewer (avoids circular dependency with CodeBlock in MessageContent)
const SourceView = memo(function SourceView({ code }: { code: string }) {
  const lines = code.split('\n');
  const showLineNumbers = lines.length > 3;

  return (
    <div className="relative">
      <Suspense
        fallback={
          <pre className="scrollbar-hidden overflow-x-auto p-4 text-xs leading-5 text-zinc-200">
            {code}
          </pre>
        }
      >
        <LazyPrismCodeBlock
          language="html"
          showLineNumbers={showLineNumbers}
          customStyle={{
            margin: 0,
            padding: '1rem',
            background: 'transparent',
            fontSize: '0.75rem',
            lineHeight: '1.25rem',
          }}
          lineNumberStyle={{
            minWidth: '2.5em',
            paddingRight: '1em',
            color: 'rgb(113 113 122)',
            userSelect: 'none',
          }}
          wrapLongLines={false}
          code={code}
        />
      </Suspense>
    </div>
  );
});

export const GenerativeUIBlock = memo(function GenerativeUIBlock({ code }: { code: string }) {
  const [showSource, setShowSource] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(MIN_IFRAME_HEIGHT);
  const [loaded, setLoaded] = useState(false);
  const [selection, setSelection] = useState<HtmlElementSelection | null>(null);
  // 两态各持一个 ref：共用一个的话，切换时 React 会在挂载新 iframe 之后
  // 才把旧 iframe 的 ref 置空，ref 变 null，预览态的高度上报就再也对不上 source 了。
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const editIframeRef = useRef<HTMLIFrameElement>(null);
  const controllerRef = useRef<HtmlLocalitySelectionController | null>(null);
  const { t } = useI18n();

  const srcdoc = buildPreviewSrcdoc(code);

  // Listen for height messages from iframe
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== previewIframeRef.current?.contentWindow) return;
      const data: unknown = event.data;
      if (isResizeMessage(data)) {
        const h = Math.max(MIN_IFRAME_HEIGHT, Math.min(MAX_IFRAME_HEIGHT, data.height));
        setIframeHeight(h);
        setLoaded(true);
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const detachSelection = useCallback(() => {
    controllerRef.current?.destroy();
    controllerRef.current = null;
    setSelection(null);
  }, []);

  // 编辑态同源，点选监听由父窗口直接挂到 iframe 文档上；高度也直接量，
  // 不走 postMessage（编辑态没有 allow-scripts，上报脚本本来就跑不了）。
  // 文档从 load 事件的 currentTarget 拿，不读 ref——onLoad 触发时 ref 未必已就位。
  const attachEditDocument = useCallback((frame: HTMLIFrameElement) => {
    detachSelection();
    const doc = frame.contentDocument;
    if (!doc) return;
    setIframeHeight(Math.max(
      MIN_IFRAME_HEIGHT,
      Math.min(MAX_IFRAME_HEIGHT, doc.body.scrollHeight),
    ));
    setLoaded(true);
    controllerRef.current = attachHtmlLocalitySelection(doc, setSelection);
  }, [detachSelection]);

  // srcdoc 换了就是换了一个 document，旧监听/节点引用必须先释放，onLoad 再挂新的
  useEffect(() => {
    detachSelection();
  }, [detachSelection, code, editing]);

  useEffect(() => () => detachSelection(), [detachSelection]);

  // 解除选中交给上面那个 [code, editing] effect —— 它两个方向都覆盖，这里再调一次是冗余
  const toggleEditing = useCallback(() => {
    setEditing((current) => !current);
    setShowSource(false);
    setLoaded(false);
  }, []);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), UI.COPY_FEEDBACK_DURATION);
  }, [code]);

  const handleOpen = useCallback(() => {
    const blob = new Blob([srcdoc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // Clean up after a delay
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [srcdoc]);

  // Fallback: empty code
  if (!code.trim()) {
    return null;
  }

  return (
    <div className="my-3 rounded-xl bg-zinc-900 border border-zinc-700 shadow-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-800 border-b border-zinc-700">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-violet-400" />
          <span className="text-xs font-medium text-violet-400">{t.generativeUI.generativeUI}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleEditing}
            aria-pressed={editing}
            data-testid="generative-ui-edit-toggle"
            className={`flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 transition-all text-xs ${
              editing ? 'text-cyan-300 bg-zinc-700' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <MousePointerClick className="w-3.5 h-3.5" />
            <span>{editing ? t.generativeUI.exitEdit : t.generativeUI.edit}</span>
          </button>
          <button
            onClick={() => { setShowSource(s => !s); setEditing(false); detachSelection(); }}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 transition-all text-xs ${
              showSource ? 'text-violet-400 bg-zinc-700' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>{t.generativeUI.source}</span>
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-400" />
                <span className="text-green-400">{t.generativeUI.copied}</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>{t.generativeUI.copy}</span>
              </>
            )}
          </button>
          <button
            onClick={handleOpen}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>{t.generativeUI.open}</span>
          </button>
        </div>
      </div>

      {/* 编辑态没有 allow-scripts，JS 驱动的动效不会播放——如实说，不装作没这回事 */}
      {editing && !showSource && (
        <div className="px-4 py-1.5 bg-cyan-500/5 border-b border-cyan-500/20 text-[11px] text-cyan-200/80">
          {t.generativeUI.editHint}
        </div>
      )}

      {/* Content: Source or Preview */}
      {showSource ? (
        <SourceView code={code} />
      ) : (
        <div className="relative">
          {!loaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900 text-zinc-500 text-xs">
              {t.generativeUI.loading}
            </div>
          )}
          {editing ? (
            <iframe
              key="edit"
              ref={editIframeRef}
              sandbox={EDIT_SANDBOX}
              srcDoc={buildEditSrcdoc(code)}
              style={{ height: `${iframeHeight}px`, minHeight: `${MIN_IFRAME_HEIGHT}px`, maxHeight: `${MAX_IFRAME_HEIGHT}px` }}
              className="w-full border-0 bg-zinc-900"
              title={t.generativeUI.generativeUI}
              data-testid="generative-ui-edit-frame"
              onLoad={(event) => attachEditDocument(event.currentTarget)}
            />
          ) : (
            <iframe
              key="preview"
              ref={previewIframeRef}
              sandbox={PREVIEW_SANDBOX}
              srcDoc={srcdoc}
              style={{ height: `${iframeHeight}px`, minHeight: `${MIN_IFRAME_HEIGHT}px`, maxHeight: `${MAX_IFRAME_HEIGHT}px` }}
              className="w-full border-0 bg-zinc-900"
              title={t.generativeUI.generativeUI}
              data-testid="generative-ui-preview-frame"
              onLoad={() => setLoaded(true)}
            />
          )}
        </div>
      )}

      {/* 选中回显。P1 只读——属性面板是 P2。 */}
      {editing && !showSource && selection && (
        <div
          className="flex items-center gap-2 px-4 py-2 border-t border-zinc-700 bg-zinc-950/60"
          data-testid="generative-ui-selection-bar"
        >
          <span className="shrink-0 rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[11px] text-cyan-200">
            {`<${selection.tag}>`}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
            {selection.text || t.generativeUI.selectionNoText}
          </span>
          <button
            onClick={() => controllerRef.current?.clear()}
            className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            title={t.generativeUI.clearSelection}
            aria-label={t.generativeUI.clearSelection}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {editing && !showSource && !selection && (
        <div className="px-4 py-2 border-t border-zinc-700 bg-zinc-950/60 text-[11px] text-zinc-500">
          {t.generativeUI.selectHint}
        </div>
      )}
    </div>
  );
});
