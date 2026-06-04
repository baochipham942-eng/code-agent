import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  Check,
  Clipboard,
  Code2,
  Copy,
  File,
  FileText,
  Image,
  LayoutGrid,
  Mail,
  MessageSquare,
  Presentation,
  Table2,
  Terminal,
} from 'lucide-react';
import type {
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
import { IPC_DOMAINS } from '@shared/ipc';
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
import { LocalityFeedbackBar } from './LivePreview/LocalityFeedbackBar';
import { ChartBlock } from './features/chat/MessageBubble/ChartBlock';
import { DocumentBlock } from './features/chat/MessageBubble/DocumentBlock';
import { SpreadsheetBlock } from './features/chat/MessageBubble/SpreadsheetBlock';
import {
  QuestionFormPreview,
  DESIGN_BRIEF_SUBMIT_EVENT,
  type DesignBriefSubmitDetail,
} from './QuestionFormPreview';
import {
  AssetDrawerPanel,
  AssetToolbarButton,
  PromptAppLibrary,
  isGalleryItem,
} from './WorkspaceAssets';
import { useSessionStore } from '../stores/sessionStore';
import ipcService from '../services/ipcService';
import ProjectHeaderBar from './ProjectHeaderBar';

type WorkspaceAssetDrawer = 'apps' | 'gallery' | 'feedback';

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
    case 'handoff': return 'Continue';
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
      <div className="flex items-start gap-2">
        <KindIcon kind={item.kind} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 break-words text-xs font-medium leading-snug text-zinc-100">{item.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-zinc-500">
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
        <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${statusClass(item.status)}`}>
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

      {/* 定点反馈：当前选中页（selectedIndex 即 0-based slide_index）+ pptxPath → 锚点消息发给 agent */}
      {pptxPath && selectedScreenshot && (
        <LocalityFeedbackBar
          anchor={{ kind: 'ppt', filePath: pptxPath, slideIndex: selectedIndex, displayName: item.title }}
          locationLabel={`第 ${selectedIndex + 1} 页`}
        />
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
    return <SpreadsheetBlock spec={item.content.json} filePath={item.file?.path} />;
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
  const [activeDrawer, setActiveDrawer] = useState<WorkspaceAssetDrawer | null>(null);
  const [copied, setCopied] = useState(false);
  const [assetActionError, setAssetActionError] = useState<string | null>(null);
  const galleryItems = useMemo(() => items.filter(isGalleryItem), [items]);
  const appAssetCount = presets.length + recipes.length;

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
    items.find((item) => item.id === selectedId) || items[0] || null
  ), [items, selectedId]);
  const currentSessionTitle = useMemo(() => {
    if (!currentSessionId) return undefined;
    return sessions.find((session) => session.id === currentSessionId)?.title;
  }, [currentSessionId, sessions]);
  useEffect(() => {
    if (!selected && selectedId) {
      setSelectedId(null);
      return;
    }
    if (selected && selected.id !== selectedId) {
      setSelectedId(selected.id);
    }
  }, [selected, selectedId, setSelectedId]);

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

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-zinc-900">
      {/* P0-2 项目空间 header：项目维度的目标/状态/入驻角色/跨 session 聚合产物 */}
      <ProjectHeaderBar />
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-3 py-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Clipboard className="h-4 w-4 shrink-0 text-cyan-300" />
            <div className="truncate text-sm font-semibold text-zinc-100">Preview</div>
          </div>
          <div className="mt-0.5 truncate text-xs text-zinc-500">
            {items.length} files · {galleryItems.length} visuals · {appAssetCount} apps
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <AssetToolbarButton
            label={`Prompt Apps (${appAssetCount})`}
            icon={<LayoutGrid className="h-4 w-4" />}
            count={appAssetCount}
            active={activeDrawer === 'apps'}
            onClick={() => setActiveDrawer((current) => (current === 'apps' ? null : 'apps'))}
          />
          <AssetToolbarButton
            label={`Gallery (${galleryItems.length})`}
            icon={<Image className="h-4 w-4" />}
            count={galleryItems.length}
            active={activeDrawer === 'gallery'}
            onClick={() => setActiveDrawer((current) => (current === 'gallery' ? null : 'gallery'))}
          />
          <div className="mx-1 h-5 w-px bg-white/[0.08]" />
          <AssetToolbarButton
            label={copied ? 'Copied' : 'Copy preview'}
            icon={copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
            disabled={!selected}
            onClick={copySelected}
          />
        </div>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div>
            <Clipboard className="mx-auto h-8 w-8 text-zinc-600" />
            <div className="mt-3 text-sm text-zinc-300">暂无可预览文件</div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-500">当前会话还没有文件产物。</div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-white/[0.06] p-3">
            <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
              <span>Files</span>
              <span>{items.length}</span>
            </div>
            <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
              {items.map((item) => (
                <PreviewListItem
                  key={item.id}
                  item={item}
                  active={item.id === selected?.id}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {selected && (
              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  <KindIcon kind={selected.kind} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-zinc-100">{selected.title}</div>
                    <div className="mt-0.5 truncate text-xs text-zinc-500">
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
                <PreviewBody item={selected} />
              </div>
            )}
          </div>
        </div>
      )}

      {activeDrawer && (
        <button
          type="button"
          aria-label="关闭资源面板"
          className="absolute inset-0 z-20 cursor-default bg-black/20"
          onClick={() => setActiveDrawer(null)}
        />
      )}

      {activeDrawer === 'apps' && (
        <AssetDrawerPanel
          title="Prompt Apps"
          subtitle={`${appAssetCount} saved`}
          onClose={() => setActiveDrawer(null)}
        >
          <div className="flex min-h-full flex-col">
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
        </AssetDrawerPanel>
      )}

      {activeDrawer === 'gallery' && (
        <AssetDrawerPanel
          title="Gallery"
          subtitle={`${galleryItems.length} visual assets`}
          onClose={() => setActiveDrawer(null)}
        >
          {galleryItems.length === 0 ? (
            <div className="flex min-h-full items-center justify-center px-6 text-center">
              <div>
                <Image className="mx-auto h-8 w-8 text-zinc-600" />
                <div className="mt-3 text-sm text-zinc-300">暂无 Gallery 资产</div>
              </div>
            </div>
          ) : (
            <div className="space-y-2 p-3">
              {galleryItems.map((item) => (
                <PreviewListItem
                  key={item.id}
                  item={item}
                  active={item.id === selected?.id}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
            </div>
          )}
        </AssetDrawerPanel>
      )}

    </div>
  );
};

export default WorkspacePreviewPanel;
