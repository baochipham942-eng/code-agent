// ============================================================================
// GenerativeUIBlock - Sandboxed iframe renderer for AI-generated HTML widgets
// ============================================================================

import { memo, useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import { Sparkles, Code2, Copy, Check, ExternalLink, MousePointerClick, Download } from 'lucide-react';
import { UI } from '@shared/constants';
import { useI18n } from '../../../../hooks/useI18n';
import {
  attachHtmlLocalitySelection,
  type HtmlElementSelection,
  type HtmlLocalitySelectionController,
} from '../../../../utils/htmlLocality';
import {
  applyHtmlElementEdit,
  buildEditSrcdoc,
  buildPreviewSrcdoc,
  buildStandaloneHtml,
  extractHtmlTitle,
  EDIT_SANDBOX,
  PREVIEW_SANDBOX,
  type HtmlElementEdit,
} from './generativeUIDocument';
import { GenerativeUIEditPanel } from './GenerativeUIEditPanel';
import { generativeUIClient } from '../../../../services/generativeUIClient';
import { hashGenerativeUiBody, stripEditMarker } from '@shared/generativeUIEdit';

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

export const GenerativeUIBlock = memo(function GenerativeUIBlock({
  code,
  messageId,
  sessionId,
  sourceOrdinal = 0,
  isStreaming = false,
}: {
  code: string;
  messageId?: string;
  sessionId?: string;
  sourceOrdinal?: number;
  isStreaming?: boolean;
}) {
  const [showSource, setShowSource] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(MIN_IFRAME_HEIGHT);
  const [loaded, setLoaded] = useState(false);
  const [selection, setSelection] = useState<HtmlElementSelection | null>(null);
  const [selectedElement, setSelectedElement] = useState<Element | null>(null);
  // 用户改过之后的源码。null = 没改过，跟着外部 code 走（模型重新生成时自然更新）。
  const [draftCode, setDraftCode] = useState<string | null>(null);
  // 进编辑态时把源码钉住：srcdoc 一变 iframe 就重载，选中态会当场丢掉，
  // 改完字号就没法接着改颜色。所见即所得靠直接改 iframe 里的 DOM，不靠重载。
  const [editBaseCode, setEditBaseCode] = useState<string | null>(null);
  const [patchError, setPatchError] = useState(false);
  const [conflict, setConflict] = useState(false);
  // 两态各持一个 ref：共用一个的话，切换时 React 会在挂载新 iframe 之后
  // 才把旧 iframe 的 ref 置空，ref 变 null，预览态的高度上报就再也对不上 source 了。
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const editIframeRef = useRef<HTMLIFrameElement>(null);
  const controllerRef = useRef<HtmlLocalitySelectionController | null>(null);
  // 这次编辑动过哪些属性——贴进编辑标记供模型参考
  const touchedFieldsRef = useRef<Set<string>>(new Set());
  const { t } = useI18n();

  const activeCode = draftCode ?? code;
  const srcdoc = buildPreviewSrcdoc(activeCode);

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
    setSelectedElement(null);
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
    controllerRef.current = attachHtmlLocalitySelection(doc, (next, element) => {
      setSelection(next);
      setSelectedElement(element);
    });
  }, [detachSelection]);

  // srcdoc 换了就是换了一个 document，旧监听/节点引用必须先释放，onLoad 再挂新的
  useEffect(() => {
    detachSelection();
  }, [detachSelection, code, editing]);

  useEffect(() => () => detachSelection(), [detachSelection]);

  // 外部 code 变了（持久化回灌 / 模型重新生成 / 云同步）→ draft 作废，跟上新的真源。
  // 持久化成功后我们自己写的那次也走这里，draft 归零、新 code 成为新基准。
  useEffect(() => {
    setDraftCode(null);
  }, [code]);

  /**
   * 把 draft 写回三处（DB + 活跃 orchestrator + 编辑标记）。在退出编辑态时调。
   * baseHash 用 editBaseCode——用户就是从它开始改的；库里当前值和它对不上说明
   * 中间被人动过，host 会 fail-closed 返回 conflict。
   */
  const persistDraft = useCallback(async (base: string, draft: string) => {
    // 直接判 messageId/sessionId（而非 canPersist），顺带让 TS narrow 掉 undefined
    if (!messageId || !sessionId || draft === base) return;
    try {
      const result = await generativeUIClient.persistHtmlEdit({
        sessionId,
        messageId,
        sourceOrdinal,
        baseHash: hashGenerativeUiBody(base),
        newCode: stripEditMarker(draft),
        fields: [...touchedFieldsRef.current],
      });
      if (!result.persisted) {
        // 对账没过——库里那份已经不是用户改的基准了。放弃本次 draft，回到真源。
        if (result.reason === 'conflict') setConflict(true);
        setDraftCode(null);
      }
    } catch {
      // 写库失败：不谎报成功，回到真源，让用户重来
      setDraftCode(null);
    }
  }, [sessionId, messageId, sourceOrdinal]);

  // 副作用不能塞进 setEditing 的 updater——StrictMode 下 updater 会跑两遍，
  // 落库就会发两次。从闭包读 editing（已在 deps 里），在 updater 外面做。
  const toggleEditing = useCallback(() => {
    if (editing) {
      // 退出编辑：把这次的改动落库
      if (editBaseCode !== null && draftCode !== null) {
        void persistDraft(editBaseCode, draftCode);
      }
      setEditBaseCode(null);
      setEditing(false);
    } else {
      // 进入编辑：钉住当前源码作基准，清空本次动过的属性
      setEditBaseCode(draftCode ?? code);
      touchedFieldsRef.current = new Set();
      setConflict(false);
      setEditing(true);
    }
    setShowSource(false);
    setLoaded(false);
    setPatchError(false);
  }, [editing, code, draftCode, editBaseCode, persistDraft]);

  /**
   * 一次属性修改走两步，顺序不能反：**先算补丁，成了才改 DOM**。
   * 反过来的话补丁失败时 iframe 已经变了、源码没变，两边就分叉了——
   * 用户看到改动生效，实际存下去的是旧的。
   */
  const applyEdit = useCallback((edit: Omit<HtmlElementEdit, 'selector'>) => {
    const element = controllerRef.current?.getSelectedElement();
    if (!element || !selection) return;

    const result = applyHtmlElementEdit(activeCode, { ...edit, selector: selection.selector });
    if (!result.ok) {
      setPatchError(true);
      return;
    }
    setPatchError(false);
    setDraftCode(result.code);

    // 所见即所得：直接改 iframe 里那个元素，不重载
    const live = element as HTMLElement;
    if (edit.text !== undefined) { live.textContent = edit.text; touchedFieldsRef.current.add('text'); }
    if (edit.fontSize !== undefined) { live.style.fontSize = `${edit.fontSize}px`; touchedFieldsRef.current.add('font-size'); }
    if (edit.color !== undefined) { live.style.color = edit.color; touchedFieldsRef.current.add('color'); }

    const doc = live.ownerDocument;
    setIframeHeight(Math.max(
      MIN_IFRAME_HEIGHT,
      Math.min(MAX_IFRAME_HEIGHT, doc.body.scrollHeight),
    ));
  }, [activeCode, selection]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), UI.COPY_FEEDBACK_DURATION);
  }, [code]);

  // 丢去浏览器：用独立页面（含用户编辑、去掉 iframe 专用的 CSP/高度脚本），不是预览 srcdoc
  const handleOpen = useCallback(() => {
    const blob = new Blob([buildStandaloneHtml(activeCode)], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [activeCode]);

  // 导出成一个能发出去的 .html 文件（抄 ExportModal 的 Blob 下载）
  const handleExport = useCallback(() => {
    const title = extractHtmlTitle(activeCode) || t.generativeUI.generativeUI;
    const safe = title.replace(/[^a-zA-Z0-9一-龥]/g, '_').slice(0, 60);
    const filename = `${safe}_${new Date().toISOString().split('T')[0]}.html`;
    const blob = new Blob([buildStandaloneHtml(activeCode)], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [activeCode, t.generativeUI.generativeUI]);

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
            disabled={isStreaming && !editing}
            title={isStreaming && !editing ? t.generativeUI.editStreamingHint : undefined}
            data-testid="generative-ui-edit-toggle"
            className={`flex items-center gap-1.5 px-2 py-1 rounded-lg transition-all text-xs disabled:opacity-40 disabled:cursor-not-allowed ${
              editing ? 'text-cyan-300 bg-zinc-700' : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
            }`}
          >
            <MousePointerClick className="w-3.5 h-3.5" />
            <span>{editing ? t.generativeUI.exitEdit : t.generativeUI.edit}</span>
          </button>
          <button
            onClick={() => {
              // 切到源码视图前，先把没落库的编辑落了，别静默丢
              if (editing && editBaseCode !== null && draftCode !== null) {
                void persistDraft(editBaseCode, draftCode);
              }
              setShowSource(s => !s);
              setEditing(false);
              setEditBaseCode(null);
              detachSelection();
            }}
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
            onClick={handleExport}
            data-testid="generative-ui-export"
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{t.generativeUI.exportHtml}</span>
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

      {/* 对账没过：库里那份已经不是用户改的基准（云同步 / 另一处编辑），修改没落库 */}
      {conflict && !editing && (
        <div
          className="px-4 py-2 border-b border-amber-500/20 bg-amber-500/5 text-[11px] text-amber-200"
          data-testid="generative-ui-conflict"
        >
          {t.generativeUI.editConflict}
        </div>
      )}

      {/* Content: Source or Preview */}
      {showSource ? (
        <SourceView code={activeCode} />
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
              srcDoc={buildEditSrcdoc(editBaseCode ?? activeCode)}
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

      {/* 选中后给属性面板：文字 / 字号 / 颜色。key 换元素时重建输入框，
          避免用 effect 回灌把正在输入的内容冲掉。 */}
      {editing && !showSource && selection && selectedElement && (
        <GenerativeUIEditPanel
          key={selection.selector}
          element={selectedElement}
          tag={selection.tag}
          onApply={applyEdit}
          onClear={() => controllerRef.current?.clear()}
        />
      )}
      {editing && !showSource && patchError && (
        <div
          className="px-4 py-2 border-t border-amber-500/20 bg-amber-500/5 text-[11px] text-amber-200"
          data-testid="generative-ui-patch-error"
        >
          {t.generativeUI.patchFailed}
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
