import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  Check,
  Clipboard,
  Code2,
  Copy,
  File,
  FileText,
  Image,
  Mail,
  MessageSquare,
  Table2,
  Terminal,
} from 'lucide-react';
import type { WorkspacePreviewItem, WorkspacePreviewKind } from '@shared/contract';
import { formatDesignBriefLabel } from '@shared/contract/designBrief';
import { useWorkspacePreviewModel } from '../hooks/useWorkspacePreviewModel';
import { useAppStore } from '../stores/appStore';
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
import { useSessionStore } from '../stores/sessionStore';

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

function PreviewListItem({
  item,
  active,
  onSelect,
}: {
  item: WorkspacePreviewItem;
  active: boolean;
  onSelect: () => void;
}) {
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
            <div className="mt-0.5 truncate text-[10px] text-cyan-300/80">
              {formatDesignBriefLabel(item.designBrief)}
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

function PreviewBody({ item }: { item: WorkspacePreviewItem }) {
  if (item.kind === 'question_form') {
    return <QuestionFormPreview item={item} />;
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

export const WorkspacePreviewPanel: React.FC = () => {
  const items = useWorkspacePreviewModel();
  const selectedId = useAppStore((state) => state.selectedWorkspacePreviewId);
  const setSelectedId = useAppStore((state) => state.setSelectedWorkspacePreviewId);
  const [copied, setCopied] = useState(false);

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

  useEffect(() => {
    if (!selected && selectedId) {
      setSelectedId(null);
      return;
    }
    if (selected && selected.id !== selectedId) {
      setSelectedId(selected.id);
    }
  }, [selected, selectedId, setSelectedId]);

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
    <div className="flex h-full min-h-0 flex-col bg-zinc-900">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-100">Workspace Preview</div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {items.length > 0 ? `${items.length} items from this workspace` : 'No previewable workspace items yet'}
          </div>
        </div>
        <button
          type="button"
          onClick={copySelected}
          disabled={!selected}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div>
            <Clipboard className="mx-auto h-8 w-8 text-zinc-600" />
            <div className="mt-3 text-sm text-zinc-300">暂无可预览产物</div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-500">
              文档、表格、消息草稿、日程、网页截图、diff 和文件产物会出现在这里。
            </div>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-r border-white/[0.06] p-3">
            <div className="space-y-2">
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
                      <div className="mt-2 inline-flex items-center rounded-md border border-cyan-500/20 bg-cyan-500/[0.06] px-2 py-0.5 text-[11px] text-cyan-200">
                        {formatDesignBriefLabel(selected.designBrief)}
                      </div>
                    )}
                  </div>
                </div>
                <PreviewBody item={selected} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkspacePreviewPanel;
