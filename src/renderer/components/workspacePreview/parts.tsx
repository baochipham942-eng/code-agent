import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Calendar,
  Code2,
  File,
  FileText,
  GitCompare,
  Image,
  Mail,
  MessageSquare,
  Music,
  Presentation,
  RotateCcw,
  Table2,
  Terminal,
  Video,
} from 'lucide-react';
import type {
  WorkspacePreviewItem,
  WorkspacePreviewKind,
} from '@shared/contract';
import { formatDesignBriefLabel } from '@shared/contract/designBrief';
import type { DesignBrief } from '@shared/contract/designBrief';
import type { DirectionTokens } from '@/design/direction-tokens';
import { useAppStore } from '../../stores/appStore';
import { resolveFileUrl } from '../../utils/resolveFileUrl';
import { isPreviewable } from '../../utils/previewable';
import { buildWorkspacePreviewHtmlSrcdoc, type WorkspacePreviewRuntimeStatus } from '../../utils/workspacePreview';
import {
  buildWorkspaceRevisionComparison,
  buildWorkspaceRevisionHistory,
} from '../../utils/workspaceRevisions';
import { DiffView } from '../DiffView';
import { Badge } from '../primitives';
import { LocalityFeedbackBar } from '../LivePreview/LocalityFeedbackBar';
import { ChartBlock } from '../features/chat/MessageBubble/ChartBlock';
import { DocumentBlock } from '../features/chat/MessageBubble/DocumentBlock';
import { SpreadsheetBlock } from '../features/chat/MessageBubble/SpreadsheetBlock';
import { QuestionFormPreview } from '../QuestionFormPreview';
import {
  kindLabel,
  statusClass,
  firstFontName,
  tokensForBrief,
  isRuntimeStatus,
  revisionLabel,
  parseDesignPptArtifact,
} from './helpers';

export function KindIcon({ kind }: { kind: WorkspacePreviewKind }) {
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
    case 'image':
      return <Image className={`${cls} text-cyan-300`} />;
    case 'audio':
      return <Music className={`${cls} text-emerald-300`} />;
    case 'video':
      return <Video className={`${cls} text-fuchsia-300`} />;
    case 'archive':
      return <Archive className={`${cls} text-amber-300`} />;
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
    case 'presentation':
      return <Presentation className={`${cls} text-fuchsia-300`} />;
    default:
      return <File className={`${cls} text-zinc-400`} />;
  }
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

export function DesignBriefBadge({ brief }: { brief: DesignBrief }) {
  const tokens = tokensForBrief(brief);
  return (
    <div className="mt-2 inline-flex max-w-full items-center gap-2 rounded-md border border-cyan-500/20 bg-cyan-500/[0.06] px-2 py-1 text-[11px] text-cyan-200">
      {tokens && <DirectionTokenMini tokens={tokens} />}
      <span className="truncate">{formatDesignBriefLabel(brief)}</span>
    </div>
  );
}

export function PreviewListItem({
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
        <Badge className={`mt-0.5 shrink-0 text-[10px] ${statusClass(item.status)}`}>
          {item.status}
        </Badge>
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

export function RevisionPanel({
  items,
  selected,
  currentSessionId,
  isRestoring,
  actionError,
  actionMessage,
  onSelect,
  onRestore,
}: {
  items: WorkspacePreviewItem[];
  selected: WorkspacePreviewItem;
  currentSessionId?: string | null;
  isRestoring: boolean;
  actionError?: string | null;
  actionMessage?: string | null;
  onSelect: (itemId: string) => void;
  onRestore: () => void;
}) {
  const history = useMemo(() => buildWorkspaceRevisionHistory(items, selected), [items, selected]);
  const comparison = useMemo(() => buildWorkspaceRevisionComparison(items, selected), [items, selected]);
  const canRestoreCheckpoint = Boolean(selected.file?.path && selected.source.messageId && currentSessionId);
  const hasRevision = Boolean(selected.revision?.artifactId || history.length > 1 || canRestoreCheckpoint);
  if (!hasRevision) return null;

  return (
    <div className="space-y-2 rounded-lg border border-white/[0.08] bg-black/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <GitCompare className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
          <div className="truncate text-xs font-medium text-zinc-200">Versions</div>
          {selected.revision?.sha256 && (
            <div className="truncate font-mono text-[10px] text-zinc-600">
              {selected.revision.sha256.slice(0, 12)}
            </div>
          )}
        </div>
        {selected.file?.path && (
          <button
            type="button"
            onClick={onRestore}
            disabled={!canRestoreCheckpoint || isRestoring}
            className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              canRestoreCheckpoint
                ? 'Restore files to this message checkpoint'
                : 'No checkpoint anchor is available for this artifact'
            }
          >
            <RotateCcw className={`h-3.5 w-3.5 ${isRestoring ? 'animate-spin' : ''}`} />
            Restore checkpoint
          </button>
        )}
      </div>

      {history.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {history.map((item, index) => (
            <button
              type="button"
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={`rounded-md border px-2 py-1 text-[11px] ${
                item.id === selected.id
                  ? 'border-cyan-500/35 bg-cyan-500/[0.08] text-cyan-200'
                  : 'border-white/[0.08] bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
              }`}
              title={item.title}
            >
              {revisionLabel(item, index)}
            </button>
          ))}
        </div>
      )}

      {comparison ? (
        <div className="space-y-1">
          <div className="text-[10px] text-zinc-500">
            Compare {comparison.beforeLabel} {revisionLabel(comparison.previous, Math.max(0, history.indexOf(comparison.previous)))} to {comparison.afterLabel} {revisionLabel(comparison.current, Math.max(0, history.indexOf(comparison.current)))}
          </div>
          <div className="max-h-[360px] overflow-auto rounded border border-white/[0.06]">
            <DiffView
              oldText={comparison.before}
              newText={comparison.after}
              fileName={comparison.fileName}
            />
          </div>
        </div>
      ) : (
        <div className="rounded border border-white/[0.06] bg-zinc-950/60 px-2 py-1.5 text-[11px] text-zinc-500">
          {history.length > 1 ? 'No inline comparable content for this revision.' : 'No previous revision found in this session.'}
        </div>
      )}

      {actionError && (
        <div className="rounded border border-rose-500/20 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-200">
          {actionError}
        </div>
      )}
      {actionMessage && (
        <div className="rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-200">
          {actionMessage}
        </div>
      )}
    </div>
  );
}

export function PreviewBody({ item }: { item: WorkspacePreviewItem }) {
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
