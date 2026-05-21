import React, { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlertCircle,
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  Database,
  FileText,
  MessageSquareText,
  PencilLine,
  Zap,
} from 'lucide-react';
import type { AuditItem, InboxItem, InboxStatus } from './KnowledgeMemoryPanel';

function formatTime(value: number | null): string {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function formatConfidence(value: number | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${Math.round(value * 100)}%`;
}

export function KnowledgeInboxList({
  items,
  editingId,
  draftById,
  statusById,
  errorById,
  onApprove,
  onReject,
  onEdit,
  onDraftChange,
  onCancelEdit,
  onApproveEdit,
}: {
  items: InboxItem[];
  editingId: string | null;
  draftById: Record<string, string>;
  statusById: Record<string, InboxStatus>;
  errorById: Record<string, string>;
  onApprove: (item: InboxItem) => void;
  onReject: (item: InboxItem) => void;
  onEdit: (item: InboxItem) => void;
  onDraftChange: (id: string, value: string) => void;
  onCancelEdit: () => void;
  onApproveEdit: (item: InboxItem, value: string) => void;
}) {
  return (
    <div className="space-y-2">
      {items.map((item) => {
        const status = statusById[item.id];
        const isBusy = status === 'approving' || status === 'rejecting';
        const isEditing = editingId === item.id;
        const draft = draftById[item.id] ?? item.content;
        return (
          <article key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-medium text-amber-300">{item.kind}</span>
                  {status ? <InboxStatusBadge status={status} /> : null}
                </div>
                <h4 className="mt-1 line-clamp-2 text-sm font-medium text-zinc-100">{item.title}</h4>
              </div>
              <span className="shrink-0 text-[11px] text-zinc-600">{formatTime(item.updatedAt)}</span>
            </div>
            <p className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-400">{item.summary}</p>
            <dl className="mt-3 space-y-1 text-[11px] leading-4 text-zinc-500">
              <div>
                <dt className="inline text-zinc-400">来源: </dt>
                <dd className="inline">{item.source}</dd>
              </div>
              <div>
                <dt className="inline text-zinc-400">用途: </dt>
                <dd className="inline">{item.reason}</dd>
              </div>
            </dl>

            {isEditing ? (
              <div className="mt-3 space-y-2">
                <textarea
                  value={draft}
                  onChange={(event) => onDraftChange(item.id, event.target.value)}
                  className="min-h-24 w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs leading-5 text-zinc-200 outline-hidden focus:border-emerald-500/70"
                  aria-label={`编辑 ${item.title}`}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onApproveEdit(item, draft)}
                    disabled={isBusy || !draft.trim()}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    <Check className="h-3.5 w-3.5" />
                    保存采纳
                  </button>
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    disabled={isBusy}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onApprove(item)}
                  disabled={isBusy}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" />
                  采纳
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(item)}
                  disabled={isBusy}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 text-[11px] font-medium text-sky-200 hover:bg-sky-500/20 disabled:opacity-50"
                >
                  <PencilLine className="h-3.5 w-3.5" />
                  编辑采纳
                </button>
                <button
                  type="button"
                  onClick={() => onReject(item)}
                  disabled={isBusy}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
                >
                  <Ban className="h-3.5 w-3.5" />
                  忽略
                </button>
              </div>
            )}

            {errorById[item.id] ? (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[11px] leading-4 text-red-200">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{errorById[item.id]}</span>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function InboxStatusBadge({ status }: { status: InboxStatus }) {
  const label: Record<InboxStatus, string> = {
    approving: '采纳中',
    rejecting: '忽略中',
    approved: '已采纳',
    rejected: '已忽略',
  };
  const tone = status === 'approved'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
    : status === 'rejected'
      ? 'border-zinc-700 bg-zinc-900 text-zinc-400'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${tone}`}>
      {label[status]}
    </span>
  );
}

export function AuditRow({ item }: { item: AuditItem }) {
  const confidence = formatConfidence(item.confidence);
  const [isExpanded, setIsExpanded] = useState(false);
  const hasBody = Boolean(item.body?.trim());
  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <InjectionBadge value={item.injection} />
            <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400">{item.scope}</span>
            {confidence ? <span className="text-[11px] text-zinc-600">confidence {confidence}</span> : null}
          </div>
          <h4 className="mt-2 line-clamp-2 text-sm font-medium text-zinc-100">{item.title}</h4>
        </div>
        <span className="shrink-0 text-[11px] text-zinc-600">{formatTime(item.updatedAt)}</span>
      </div>
      <p className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-400">{item.summary}</p>
      <dl className="mt-3 grid grid-cols-1 gap-1 text-[11px] leading-4 text-zinc-500 lg:grid-cols-2">
        <div>
          <dt className="inline text-zinc-400">来源: </dt>
          <dd className="inline break-all">{item.source}</dd>
        </div>
        <div>
          <dt className="inline text-zinc-400">用途: </dt>
          <dd className="inline">{item.purpose}</dd>
        </div>
        <div>
          <dt className="inline text-zinc-400">类型: </dt>
          <dd className="inline">{item.origin}</dd>
        </div>
      </dl>
      {hasBody ? (
        <div className="mt-3 border-t border-zinc-800 pt-2">
          <button
            type="button"
            onClick={() => setIsExpanded((value) => !value)}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          >
            {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {isExpanded ? '收起原文证据' : '查看原文证据'}
          </button>
          {isExpanded ? (
            <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-3 text-[11px] leading-5 text-zinc-300">
              {item.body}
            </pre>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function InjectionBadge({ value }: { value: AuditItem['injection'] }) {
  const labels: Record<AuditItem['injection'], { text: string; className: string; Icon: LucideIcon }> = {
    'seed-candidate': { text: 'seed 候选', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300', Icon: Zap },
    'memory-index': { text: 'index 候选', className: 'border-sky-500/30 bg-sky-500/10 text-sky-300', Icon: FileText },
    'recent-conversations': { text: 'recent 候选', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300', Icon: MessageSquareText },
    available: { text: '按需读取', className: 'border-zinc-700 bg-zinc-800/70 text-zinc-300', Icon: FileText },
    stored: { text: '已存储', className: 'border-zinc-700 bg-zinc-800/70 text-zinc-400', Icon: Database },
  };
  const config = labels[value];
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${config.className}`}>
      <config.Icon className="h-3 w-3" />
      {config.text}
    </span>
  );
}

export function LoadingRows() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="h-24 animate-pulse rounded-lg border border-zinc-800 bg-zinc-950/60" />
      ))}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center rounded-lg border border-dashed border-zinc-800 px-6 text-center">
      <Icon className="h-8 w-8 text-zinc-600" />
      <h4 className="mt-3 text-sm font-medium text-zinc-300">{title}</h4>
      <p className="mt-1 max-w-sm text-xs leading-5 text-zinc-500">{text}</p>
    </div>
  );
}
