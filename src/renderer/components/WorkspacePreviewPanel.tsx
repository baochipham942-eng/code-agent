import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  Check,
  CheckCircle2,
  Clipboard,
  ClipboardCheck,
  Code2,
  Copy,
  File,
  FileText,
  Image,
  Mail,
  MessageSquare,
  Presentation,
  RefreshCw,
  Send,
  Table2,
  Terminal,
} from 'lucide-react';
import type {
  DeliveryReviewRunResult,
  PreviewFeedbackItem,
  ScenarioAcceptanceArtifact,
  WorkspacePreviewItem,
  WorkspacePreviewKind,
} from '@shared/contract';
import { formatDesignBriefLabel } from '@shared/contract/designBrief';
import type { DesignBrief } from '@shared/contract/designBrief';
import {
  createWorkbenchRecipeMergedContext,
  type WorkbenchPreset,
  type WorkbenchRecipe,
} from '@shared/contract/workbenchPreset';
import { EVALUATION_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import { directionTokens, type DirectionTokens } from '@/design/direction-tokens';
import { useWorkspacePreviewModel } from '../hooks/useWorkspacePreviewModel';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import { useWorkbenchPresetStore } from '../stores/workbenchPresetStore';
import { resolveFileUrl } from '../utils/resolveFileUrl';
import { isPreviewable } from '../utils/previewable';
import {
  buildWorkspacePreviewHtmlSrcdoc,
  type WorkspacePreviewRuntimeStatus,
} from '../utils/workspacePreview';
import { DiffView } from './DiffView';
import { ChartBlock } from './features/chat/MessageBubble/ChartBlock';
import { DocumentBlock } from './features/chat/MessageBubble/DocumentBlock';
import { SpreadsheetBlock } from './features/chat/MessageBubble/SpreadsheetBlock';
import {
  QuestionFormPreview,
  DESIGN_BRIEF_SUBMIT_EVENT,
  type DesignBriefSubmitDetail,
} from './QuestionFormPreview';
import {
  AssetTabButton,
  PromptAppLibrary,
  isGalleryItem,
  type WorkspaceAssetTab,
} from './WorkspaceAssets';
import { useSessionStore } from '../stores/sessionStore';
import ipcService from '../services/ipcService';

function kindLabel(kind: WorkspacePreviewKind): string {
  switch (kind) {
    case 'document': return 'Document';
    case 'spreadsheet': return 'Sheet';
    case 'message_draft': return 'Message';
    case 'calendar_event': return 'Calendar';
    case 'reminder': return 'Reminder';
    case 'web_snapshot': return 'Web';
    case 'diff': return 'Diff';
    case 'terminal': return 'Terminal';
    case 'trace': return 'Trace';
    case 'handoff': return 'Handoff';
    case 'generic_html': return 'HTML';
    case 'chart': return 'Chart';
    case 'diagram': return 'Diagram';
    case 'question_form': return 'Brief';
    case 'design_ppt': return 'Design PPT';
    default: return 'File';
  }
}

function KindIcon({ kind }: { kind: WorkspacePreviewKind }) {
  const cls = 'h-4 w-4 shrink-0';
  switch (kind) {
    case 'document':
    case 'handoff':
      return <FileText className={`${cls} text-sky-300`} />;
    case 'spreadsheet':
      return <Table2 className={`${cls} text-emerald-300`} />;
    case 'message_draft':
      return <Mail className={`${cls} text-amber-300`} />;
    case 'calendar_event':
    case 'reminder':
      return <Calendar className={`${cls} text-violet-300`} />;
    case 'web_snapshot':
      return <Image className={`${cls} text-cyan-300`} />;
    case 'diff':
    case 'generic_html':
    case 'chart':
    case 'diagram':
      return <Code2 className={`${cls} text-orange-300`} />;
    case 'terminal':
      return <Terminal className={`${cls} text-zinc-300`} />;
    case 'question_form':
      return <MessageSquare className={`${cls} text-cyan-300`} />;
    case 'design_ppt':
      return <Presentation className={`${cls} text-fuchsia-300`} />;
    default:
      return <File className={`${cls} text-zinc-400`} />;
  }
}

function statusClass(status: WorkspacePreviewItem['status']): string {
  switch (status) {
    case 'draft': return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
    case 'applied':
    case 'sent': return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20';
    case 'failed': return 'bg-red-500/10 text-red-300 border-red-500/20';
    default: return 'bg-zinc-800 text-zinc-400 border-zinc-700';
  }
}

function firstFontName(stack: string): string {
  return stack
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .find(Boolean) || 'system-ui';
}

function tokensForBrief(brief?: DesignBrief): DirectionTokens | undefined {
  if (!brief) return undefined;
  return brief.directionTokens || (brief.direction ? directionTokens[brief.direction] : undefined);
}

function DirectionTokenMini({
  tokens,
  className = '',
}: {
  tokens: DirectionTokens;
  className?: string;
}) {
  const colors = [
    tokens.palette.primary,
    tokens.palette.surface,
    tokens.palette.accent,
    tokens.palette.muted,
    tokens.palette.contrast,
  ];
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span className="flex h-2 w-14 overflow-hidden rounded-sm border border-white/[0.08]">
        {colors.map((color, index) => (
          <span
            key={`${color}-${index}`}
            className="flex-1"
            style={{ backgroundColor: color }}
          />
        ))}
      </span>
      <span className="max-w-[90px] truncate text-[10px] text-zinc-500">
        {firstFontName(tokens.fonts.sans)}
      </span>
    </span>
  );
}

function DesignBriefBadge({ brief }: { brief: DesignBrief }) {
  const tokens = tokensForBrief(brief);
  return (
    <div className="mt-2 inline-flex max-w-full items-center gap-2 rounded-md border border-cyan-500/20 bg-cyan-500/[0.06] px-2 py-1 text-[11px] text-cyan-200">
      {tokens && <DirectionTokenMini tokens={tokens} />}
      <span className="truncate">{formatDesignBriefLabel(brief)}</span>
    </div>
  );
}

function PreviewListItem({
  item,
  active,
  onSelect,
}: {
  item: WorkspacePreviewItem;
  active: boolean;
  onSelect: () => void;
}) {
  const listTokens = tokensForBrief(item.designBrief);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
        active
          ? 'border-cyan-500/35 bg-cyan-500/[0.07]'
          : 'border-white/[0.06] bg-white/[0.025] hover:border-white/[0.14] hover:bg-white/[0.045]'
      }`}
      title={item.file?.path || item.title}
    >
      <div className="flex items-center gap-2">
        <KindIcon kind={item.kind} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-zinc-100">{item.title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-500">
            <span>{kindLabel(item.kind)}</span>
            {item.subtitle && <span className="truncate">· {item.subtitle}</span>}
          </div>
          {item.designBrief && (
            <div className="mt-1 min-w-0 space-y-0.5">
              <div className="truncate text-[10px] text-cyan-300/80">
                {formatDesignBriefLabel(item.designBrief)}
              </div>
              {listTokens && <DirectionTokenMini tokens={listTokens} />}
            </div>
          )}
        </div>
        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${statusClass(item.status)}`}>
          {item.status}
        </span>
      </div>
    </button>
  );
}

function FilePreviewCallout({ item }: { item: WorkspacePreviewItem }) {
  const openPreview = useAppStore((state) => state.openPreview);
  const path = item.file?.path;
  const previewable = isPreviewable(path);
  return (
    <div className="rounded-lg border border-white/[0.08] bg-black/20 p-4">
      <div className="flex items-start gap-3">
        <KindIcon kind={item.kind} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-100">{item.title}</div>
          {path && <div className="mt-1 truncate font-mono text-xs text-zinc-500">{path}</div>}
          {item.content?.summary && (
            <div className="mt-2 text-xs leading-relaxed text-zinc-400">{item.content.summary}</div>
          )}
        </div>
        {path && (
          <button
            type="button"
            onClick={() => openPreview(path)}
            className="rounded-md border border-white/[0.08] bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
          >
            {previewable ? 'Open file preview' : 'Open file'}
          </button>
        )}
      </div>
    </div>
  );
}

function TextPreview({ item }: { item: WorkspacePreviewItem }) {
  const text = item.content?.text || item.content?.summary || item.content?.diff || '';
  return (
    <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.08] bg-black/30 p-4 text-xs leading-relaxed text-zinc-300">
      {text || 'No preview content.'}
    </pre>
  );
}

function isRuntimeStatus(value: unknown): value is WorkspacePreviewRuntimeStatus {
  return value === 'booting' || value === 'ready' || value === 'error';
}

function WorkspaceHtmlPreview({ item }: { item: WorkspacePreviewItem }) {
  const html = item.content?.html || '';
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);
  const [runtimeStatus, setRuntimeStatus] = useState<WorkspacePreviewRuntimeStatus>('booting');
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);

  const srcdoc = useMemo(
    () => buildWorkspacePreviewHtmlSrcdoc(html, { previewId: item.id }),
    [html, item.id],
  );

  useEffect(() => {
    setHeight(320);
    setRuntimeStatus('booting');
    setRuntimeMessage(null);
  }, [srcdoc]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as {
        channel?: string;
        previewId?: string;
        type?: string;
        height?: unknown;
        status?: unknown;
        message?: unknown;
      } | null;
      if (data?.channel !== 'workspace-preview' || data.previewId !== item.id) return;

      if (data.type === 'workspace-preview:resize' && typeof data.height === 'number') {
        setHeight(Math.max(160, Math.min(900, Math.ceil(data.height))));
        return;
      }

      if (data.type === 'workspace-preview:status' && isRuntimeStatus(data.status)) {
        setRuntimeStatus(data.status);
        setRuntimeMessage(typeof data.message === 'string' ? data.message : null);
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [item.id]);

  return (
    <div className="overflow-hidden rounded-lg border border-white/[0.08] bg-zinc-950">
      <div className="relative">
        {runtimeStatus !== 'ready' && (
          <div className="pointer-events-none absolute right-2 top-2 z-10 max-w-[70%] rounded border border-white/[0.08] bg-zinc-950/90 px-2 py-1 text-[10px] text-zinc-400 shadow">
            {runtimeStatus === 'error' ? runtimeMessage || 'Preview runtime error' : 'Loading preview'}
          </div>
        )}
        <iframe
          ref={iframeRef}
          sandbox="allow-scripts"
          srcDoc={srcdoc}
          className="w-full border-0 bg-zinc-950"
          style={{ height: `${height}px`, minHeight: '160px', maxHeight: '900px' }}
          title={item.title}
          onLoad={() => setRuntimeStatus((current) => (current === 'error' ? current : 'ready'))}
        />
      </div>
    </div>
  );
}

interface DesignPptArtifactSpec {
  kind?: 'design_ppt';
  title?: string;
  topic?: string;
  theme?: string;
  outputPath?: string;
  slideCodePath?: string;
  promptPath?: string;
  screenshots?: string[];
  slidesCount?: number;
  iterations?: number;
  screenshotError?: string;
}

function parseDesignPptArtifact(item: WorkspacePreviewItem): DesignPptArtifactSpec | null {
  const raw = item.content?.json;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DesignPptArtifactSpec;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function DesignPptPreview({ item }: { item: WorkspacePreviewItem }) {
  const openPreview = useAppStore((state) => state.openPreview);
  const spec = parseDesignPptArtifact(item);
  const screenshots = spec?.screenshots || [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedScreenshot = screenshots[Math.min(selectedIndex, Math.max(screenshots.length - 1, 0))];
  const pptxPath = spec?.outputPath || item.file?.path;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 rounded-lg border border-white/[0.08] bg-black/20 p-3 text-xs text-zinc-400 sm:grid-cols-4">
        <div>
          <div className="text-[10px] uppercase text-zinc-600">Slides</div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">{spec?.slidesCount || screenshots.length || '-'}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-zinc-600">Theme</div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">{spec?.theme || '-'}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-zinc-600">Iterations</div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">{spec?.iterations ?? '-'}</div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {pptxPath && (
            <button
              type="button"
              onClick={() => openPreview(pptxPath)}
              className="rounded-md border border-white/[0.08] bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
            >
              Open PPTX
            </button>
          )}
          {spec?.slideCodePath && (
            <button
              type="button"
              onClick={() => openPreview(spec.slideCodePath!)}
              className="rounded-md border border-white/[0.08] bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
            >
              Edit code
            </button>
          )}
        </div>
      </div>

      {selectedScreenshot ? (
        <div className="overflow-hidden rounded-lg border border-white/[0.08] bg-zinc-950">
          <img
            src={resolveFileUrl(selectedScreenshot)}
            alt={`Slide ${selectedIndex + 1}`}
            className="w-full bg-zinc-950 object-contain"
          />
        </div>
      ) : (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] p-3 text-xs text-amber-200">
          {spec?.screenshotError || 'No slide screenshots available.'}
        </div>
      )}

      {screenshots.length > 1 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {screenshots.map((screenshot, index) => (
            <button
              key={screenshot}
              type="button"
              onClick={() => setSelectedIndex(index)}
              className={`overflow-hidden rounded-md border transition-colors ${
                index === selectedIndex
                  ? 'border-cyan-400 bg-cyan-500/10'
                  : 'border-white/[0.08] bg-white/[0.025] hover:border-white/[0.16]'
              }`}
              title={`Slide ${index + 1}`}
            >
              <img
                src={resolveFileUrl(screenshot)}
                alt={`Slide ${index + 1}`}
                className="aspect-video w-full object-cover"
              />
              <div className="px-2 py-1 text-left text-[10px] text-zinc-400">Slide {index + 1}</div>
            </button>
          ))}
        </div>
      )}

      {(spec?.slideCodePath || spec?.promptPath) && (
        <div className="space-y-1 rounded-lg border border-white/[0.08] bg-black/20 p-3 text-[11px] text-zinc-500">
          {spec.slideCodePath && <div className="truncate font-mono">code: {spec.slideCodePath}</div>}
          {spec.promptPath && <div className="truncate font-mono">prompts: {spec.promptPath}</div>}
        </div>
      )}
    </div>
  );
}

function PreviewBody({ item }: { item: WorkspacePreviewItem }) {
  if (item.kind === 'question_form') {
    return <QuestionFormPreview item={item} />;
  }
  if (item.kind === 'design_ppt') {
    return <DesignPptPreview item={item} />;
  }
  if (item.kind === 'diff' && item.content?.before !== undefined && item.content?.after !== undefined) {
    return (
      <DiffView
        oldText={item.content.before}
        newText={item.content.after}
        fileName={item.file?.name || item.title}
      />
    );
  }
  if (item.kind === 'generic_html' && item.content?.html) {
    return <WorkspaceHtmlPreview item={item} />;
  }
  if (item.kind === 'spreadsheet' && item.content?.json) {
    return <SpreadsheetBlock spec={item.content.json} />;
  }
  if (item.kind === 'document' && item.content?.json) {
    return <DocumentBlock spec={item.content.json} />;
  }
  if (item.kind === 'chart' && item.content?.json) {
    return <ChartBlock spec={item.content.json} />;
  }
  if (item.kind === 'message_draft' || item.kind === 'calendar_event' || item.kind === 'reminder') {
    return <TextPreview item={item} />;
  }
  if (item.file) {
    return <FilePreviewCallout item={item} />;
  }
  return <TextPreview item={item} />;
}

function previewItemToAcceptanceArtifact(item: WorkspacePreviewItem): ScenarioAcceptanceArtifact {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    filePath: item.file?.path,
    currentTurn: item.currentTurn,
    content: {
      text: item.content?.text,
      html: item.content?.html,
      json: item.content?.json,
      diff: item.content?.diff,
      summary: item.content?.summary,
    },
  };
}

function deliveryReviewStatusClass(status?: DeliveryReviewRunResult['status']): string {
  switch (status) {
    case 'pass':
      return 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200';
    case 'blocked':
      return 'border-red-500/25 bg-red-500/[0.07] text-red-200';
    case 'needs_work':
      return 'border-amber-500/25 bg-amber-500/[0.07] text-amber-200';
    default:
      return 'border-white/[0.08] bg-white/[0.03] text-zinc-300';
  }
}

function anchorLabel(item: PreviewFeedbackItem): string {
  const anchor = item.anchor;
  if (anchor.kind === 'file_line' && anchor.filePath) return `${anchor.filePath}:${anchor.lineStart ?? 1}`;
  if (anchor.kind === 'html_selector' && anchor.selector) return anchor.selector;
  if (anchor.kind === 'text_quote' && anchor.quote) return `"${anchor.quote.slice(0, 70)}"`;
  if (anchor.kind === 'diff_hunk' && anchor.hunk) return anchor.hunk.slice(0, 70);
  return anchor.filePath || 'Whole item';
}

export const WorkspacePreviewPanel: React.FC = () => {
  const items = useWorkspacePreviewModel();
  const selectedId = useAppStore((state) => state.selectedWorkspacePreviewId);
  const setSelectedId = useAppStore((state) => state.setSelectedWorkspacePreviewId);
  const setWorkingDirectory = useAppStore((state) => state.setWorkingDirectory);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const presets = useWorkbenchPresetStore((state) => state.presets);
  const recipes = useWorkbenchPresetStore((state) => state.recipes);
  const applyWorkbenchPreset = useComposerStore((state) => state.applyWorkbenchPreset);
  const applyWorkbenchRecipe = useComposerStore((state) => state.applyWorkbenchRecipe);
  const [activeAssetTab, setActiveAssetTab] = useState<WorkspaceAssetTab>('preview');
  const [copied, setCopied] = useState(false);
  const [deliveryReview, setDeliveryReview] = useState<DeliveryReviewRunResult | null>(null);
  const [reviewRunning, setReviewRunning] = useState(false);
  const [feedbackItems, setFeedbackItems] = useState<PreviewFeedbackItem[]>([]);
  const [feedbackNote, setFeedbackNote] = useState('');
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [sentContext, setSentContext] = useState(false);
  const [assetActionError, setAssetActionError] = useState<string | null>(null);
  const galleryItems = useMemo(() => items.filter(isGalleryItem), [items]);
  const activePreviewItems = activeAssetTab === 'gallery' ? galleryItems : items;

  // 监听 question-form 提交事件，把 brief 锁定到当前 session 运行时 state（不进 DB）。
  // 下一轮 sendMessage 会从 sessionStore 读这条 brief，prepend 到 IPC content 注入 LLM。
  useEffect(() => {
    function onBriefSubmit(e: Event) {
      const detail = (e as CustomEvent<DesignBriefSubmitDetail>).detail;
      if (!detail) return;
      const sessionId = useSessionStore.getState().currentSessionId;
      if (!sessionId) return;
      useSessionStore.getState().setSessionDesignBrief(sessionId, detail.brief);
    }
    window.addEventListener(DESIGN_BRIEF_SUBMIT_EVENT, onBriefSubmit);
    return () => window.removeEventListener(DESIGN_BRIEF_SUBMIT_EVENT, onBriefSubmit);
  }, []);

  const selected = useMemo(() => (
    activePreviewItems.find((item) => item.id === selectedId) || activePreviewItems[0] || null
  ), [activePreviewItems, selectedId]);
  const currentSessionTitle = useMemo(() => {
    if (!currentSessionId) return undefined;
    return sessions.find((session) => session.id === currentSessionId)?.title;
  }, [currentSessionId, sessions]);
  const selectedFeedbackItems = useMemo(() => (
    selected ? feedbackItems.filter((item) => item.previewItemId === selected.id) : []
  ), [feedbackItems, selected]);

  const reloadFeedback = useCallback(async () => {
    if (!currentSessionId) {
      setFeedbackItems([]);
      return;
    }
    const items = await ipcService.invoke(EVALUATION_CHANNELS.PREVIEW_FEEDBACK_LIST, {
      sessionId: currentSessionId,
    });
    setFeedbackItems(items || []);
  }, [currentSessionId]);

  useEffect(() => {
    reloadFeedback().catch(() => setFeedbackItems([]));
  }, [reloadFeedback]);

  useEffect(() => {
    if (activeAssetTab === 'apps') return;
    if (!selected && selectedId) {
      setSelectedId(null);
      return;
    }
    if (selected && selected.id !== selectedId) {
      setSelectedId(selected.id);
    }
  }, [activeAssetTab, selected, selectedId, setSelectedId]);

  const syncWorkspaceDirectory = useCallback(async (dir?: string | null) => {
    const trimmed = dir?.trim();
    if (!trimmed) return;
    const response = await window.domainAPI?.invoke<string | null>(
      IPC_DOMAINS.WORKSPACE,
      'setCurrent',
      { dir: trimmed },
    );
    if (response && !response.success) {
      throw new Error(response.error?.message || 'Failed to sync workspace directory');
    }
    setWorkingDirectory(response?.data || trimmed);
  }, [setWorkingDirectory]);

  const handleUsePreset = useCallback((preset: WorkbenchPreset) => {
    setAssetActionError(null);
    void (async () => {
      await syncWorkspaceDirectory(preset.context.workingDirectory);
      applyWorkbenchPreset(preset);
    })().catch((error) => {
      setAssetActionError(error instanceof Error ? error.message : String(error));
    });
  }, [applyWorkbenchPreset, syncWorkspaceDirectory]);

  const handleUseRecipe = useCallback((recipe: WorkbenchRecipe) => {
    setAssetActionError(null);
    void (async () => {
      const context = createWorkbenchRecipeMergedContext(recipe);
      await syncWorkspaceDirectory(context.workingDirectory);
      applyWorkbenchRecipe(recipe);
    })().catch((error) => {
      setAssetActionError(error instanceof Error ? error.message : String(error));
    });
  }, [applyWorkbenchRecipe, syncWorkspaceDirectory]);

  const copySelected = async () => {
    if (!selected) return;
    const value = selected.content?.text
      || selected.content?.summary
      || selected.content?.html
      || selected.content?.json
      || selected.file?.path
      || selected.title;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const runDeliveryReview = async () => {
    if (!selected || !currentSessionId) return;
    setReviewRunning(true);
    try {
      const result = await ipcService.invoke(EVALUATION_CHANNELS.DELIVERY_REVIEW_RUN, {
        sessionId: currentSessionId,
        sessionTitle: currentSessionTitle,
        artifacts: [previewItemToAcceptanceArtifact(selected)],
        enqueueOnNeedsWork: true,
        createPreviewFeedback: true,
      });
      setDeliveryReview(result || null);
      await reloadFeedback();
    } finally {
      setReviewRunning(false);
    }
  };

  const addFeedback = async () => {
    if (!selected || !currentSessionId || !feedbackNote.trim()) return;
    setFeedbackBusy(true);
    try {
      await ipcService.invoke(EVALUATION_CHANNELS.PREVIEW_FEEDBACK_CREATE, {
        sessionId: currentSessionId,
        previewItemId: selected.id,
        source: 'user',
        note: feedbackNote.trim(),
        anchor: {
          kind: 'artifact',
          filePath: selected.file?.path,
        },
      });
      setFeedbackNote('');
      await reloadFeedback();
    } finally {
      setFeedbackBusy(false);
    }
  };

  const updateFeedbackStatus = async (id: string, status: PreviewFeedbackItem['status']) => {
    await ipcService.invoke(EVALUATION_CHANNELS.PREVIEW_FEEDBACK_UPDATE_STATUS, { id, status });
    await reloadFeedback();
  };

  const sendFeedbackToChat = async () => {
    if (!currentSessionId || !selected) return;
    const context = await ipcService.invoke(EVALUATION_CHANNELS.PREVIEW_FEEDBACK_SEND_TO_CHAT, {
      sessionId: currentSessionId,
      previewItemId: selected.id,
    });
    if (!context?.message) return;
    window.dispatchEvent(new CustomEvent('iact:send', { detail: context.message }));
    setSentContext(true);
    setTimeout(() => setSentContext(false), 1200);
    await Promise.all(
      context.items
        .filter((item) => item.status === 'open')
        .map((item) => ipcService.invoke(EVALUATION_CHANNELS.PREVIEW_FEEDBACK_UPDATE_STATUS, {
          id: item.id,
          status: 'sent',
        })),
    );
    await reloadFeedback();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-900">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-100">Workspace Assets</div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {presets.length + recipes.length} apps · {galleryItems.length} gallery · {items.length} preview
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex items-center gap-1">
            <AssetTabButton
              active={activeAssetTab === 'apps'}
              label="Apps"
              count={presets.length + recipes.length}
              onClick={() => setActiveAssetTab('apps')}
            />
            <AssetTabButton
              active={activeAssetTab === 'gallery'}
              label="Gallery"
              count={galleryItems.length}
              onClick={() => setActiveAssetTab('gallery')}
            />
            <AssetTabButton
              active={activeAssetTab === 'preview'}
              label="Preview"
              count={items.length}
              onClick={() => setActiveAssetTab('preview')}
            />
          </div>
          {activeAssetTab !== 'apps' && (
            <>
              <button
                type="button"
                onClick={copySelected}
                disabled={!selected}
                className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={runDeliveryReview}
                disabled={!selected || !currentSessionId || reviewRunning}
                className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/20 bg-cyan-500/[0.08] px-2.5 py-1 text-xs text-cyan-200 hover:bg-cyan-500/[0.14] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {reviewRunning ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />}
                Review
              </button>
            </>
          )}
        </div>
      </div>

      {activeAssetTab === 'apps' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {assetActionError && (
            <div className="mx-4 mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {assetActionError}
            </div>
          )}
          <PromptAppLibrary
            presets={presets}
            recipes={recipes}
            onUsePreset={handleUsePreset}
            onUseRecipe={handleUseRecipe}
          />
        </div>
      ) : activePreviewItems.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div>
            {activeAssetTab === 'gallery' ? (
              <Image className="mx-auto h-8 w-8 text-zinc-600" />
            ) : (
              <Clipboard className="mx-auto h-8 w-8 text-zinc-600" />
            )}
            <div className="mt-3 text-sm text-zinc-300">
              {activeAssetTab === 'gallery' ? '暂无 Gallery 资产' : '暂无可预览产物'}
            </div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-500">
              {activeAssetTab === 'gallery'
                ? 'HTML、图表、幻灯片、网页截图这类视觉产物会出现在这里。'
                : '文档、表格、消息草稿、日程、网页截图、diff 和文件产物会出现在这里。'}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)_260px]">
          <div className="min-h-0 overflow-y-auto border-r border-white/[0.06] p-3">
            <div className="space-y-2">
              {activePreviewItems.map((item) => (
                <PreviewListItem
                  key={item.id}
                  item={item}
                  active={item.id === selected?.id}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto p-4">
            {selected && (
              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  <KindIcon kind={selected.kind} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-zinc-100">{selected.title}</div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {kindLabel(selected.kind)}
                      {selected.source.label ? ` · ${selected.source.label}` : ''}
                    </div>
                    {selected.designBrief && (
                      <>
                        <DesignBriefBadge brief={selected.designBrief} />
                        {selected.designBrief.references?.length ? (
                          <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-zinc-400">
                            {selected.designBrief.references.map((reference) => (
                              <div key={reference} className="rounded border border-white/[0.06] bg-white/[0.025] px-2 py-1">
                                {reference}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
                {deliveryReview && selected && (
                  <div className={`rounded-lg border px-3 py-2 text-xs ${deliveryReviewStatusClass(deliveryReview.status)}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="inline-flex items-center gap-1.5 font-medium">
                        {deliveryReview.status === 'pass'
                          ? <CheckCircle2 className="h-3.5 w-3.5" />
                          : <AlertTriangle className="h-3.5 w-3.5" />}
                        Delivery Review · {deliveryReview.score}
                      </div>
                      <span className="uppercase">{deliveryReview.status}</span>
                    </div>
                    <div className="mt-1 leading-relaxed">{deliveryReview.summary}</div>
                    <div className="mt-1 text-[11px] opacity-80">
                      {deliveryReview.skills.map((skill) => skill.title).join(' · ')}
                    </div>
                  </div>
                )}
                <PreviewBody item={selected} />
              </div>
            )}
          </div>
          <div className="min-h-0 overflow-y-auto border-l border-white/[0.06] p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-zinc-100">Preview Feedback</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">
                  {selectedFeedbackItems.length} item{selectedFeedbackItems.length === 1 ? '' : 's'}
                </div>
              </div>
              <button
                type="button"
                onClick={sendFeedbackToChat}
                disabled={!selectedFeedbackItems.some((item) => item.status === 'open' || item.status === 'sent')}
                className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send className="h-3 w-3" />
                {sentContext ? 'Sent' : 'Send'}
              </button>
            </div>

            <div className="mt-3 space-y-2">
              {selectedFeedbackItems.length === 0 ? (
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.025] p-3 text-xs leading-relaxed text-zinc-500">
                  Run review or add a note to turn preview problems into repair context.
                </div>
              ) : (
                selectedFeedbackItems.map((item) => (
                  <div
                    key={item.id}
                    className={`rounded-lg border p-2 text-xs ${
                      item.status === 'resolved'
                        ? 'border-emerald-500/15 bg-emerald-500/[0.04]'
                        : item.source === 'delivery_review'
                          ? 'border-amber-500/20 bg-amber-500/[0.05]'
                          : 'border-white/[0.08] bg-white/[0.025]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[10px] uppercase text-zinc-500">
                        {item.issueCode || item.source}
                      </span>
                      <span className="rounded border border-white/[0.08] px-1.5 py-0.5 text-[10px] text-zinc-400">
                        {item.status}
                      </span>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap leading-relaxed text-zinc-300">
                      {item.note}
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-zinc-500">
                      {anchorLabel(item)}
                    </div>
                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => updateFeedbackStatus(item.id, 'resolved')}
                        disabled={item.status === 'resolved'}
                        className="rounded border border-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/[0.08] disabled:opacity-40"
                      >
                        Resolve
                      </button>
                      <button
                        type="button"
                        onClick={() => updateFeedbackStatus(item.id, 'dismissed')}
                        disabled={item.status === 'dismissed'}
                        className="rounded border border-white/[0.08] px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-white/[0.05] disabled:opacity-40"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="mt-3 space-y-2">
              <textarea
                value={feedbackNote}
                onChange={(event) => setFeedbackNote(event.target.value)}
                placeholder="Add note"
                className="min-h-[72px] w-full resize-y rounded-md border border-white/[0.08] bg-black/20 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-cyan-500/40"
              />
              <button
                type="button"
                onClick={addFeedback}
                disabled={!feedbackNote.trim() || feedbackBusy || !selected || !currentSessionId}
                className="w-full rounded-md border border-white/[0.08] bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add feedback
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkspacePreviewPanel;
