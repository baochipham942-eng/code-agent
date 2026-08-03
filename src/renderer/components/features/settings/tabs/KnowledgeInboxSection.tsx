// ============================================================================
// KnowledgeInboxSection - 设置 → 记忆 的 Knowledge Inbox 独立分区
// ============================================================================
//
// 2026-08-02 从 features/knowledge/KnowledgeMemoryPanel(.parts).tsx 搬入（整窗页壳子退役）。
// Inbox 有写操作（采纳/编辑后采纳/忽略 → memoryInboxResolve IPC）、有列表、有编辑态，
// 按工单放成 MemoryTab 的正常 SettingsSection（「文件管理」之后、诊断区之前），
// 不塞进折叠诊断区。列表与状态机（editingId/draftById/statusById/errorById）整体搬，逻辑未改。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Ban, Check, Inbox, PencilLine } from 'lucide-react';
import { EmptyState } from '../../../primitives';
import { SettingsSection } from '../SettingsLayout';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useI18n } from '../../../../hooks/useI18n';
import { zh, type Translations } from '../../../../i18n';
import {
  buildInboxItems,
  buildMemoryInboxResolvePayload,
  invokeMemoryAudit,
  invokeMemoryInboxResolve,
  type InboxItem,
  type InboxStatus,
  type MemoryAuditPayload,
} from './memoryAuditClient';

function formatTime(value: number | null, t: Translations = zh): string {
  if (!value) return t.knowledgeMemory.timeUnknown;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t.knowledgeMemory.timeUnknown;
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
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
  const { t } = useI18n();
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
              <span className="shrink-0 text-[11px] text-zinc-600">{formatTime(item.updatedAt, t)}</span>
            </div>
            <p className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-400">{item.summary}</p>
            <dl className="mt-3 space-y-1 text-[11px] leading-4 text-zinc-500">
              <div>
                <dt className="inline text-zinc-400">{t.knowledgeMemory.sourceLabelPrefix}</dt>
                <dd className="inline">{item.source}</dd>
              </div>
              <div>
                <dt className="inline text-zinc-400">{t.knowledgeMemory.purposeLabelPrefix}</dt>
                <dd className="inline">{item.reason}</dd>
              </div>
            </dl>

            {isEditing ? (
              <div className="mt-3 space-y-2">
                <textarea
                  value={draft}
                  onChange={(event) => onDraftChange(item.id, event.target.value)}
                  className="min-h-24 w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs leading-5 text-zinc-200 outline-hidden focus:border-zinc-500"
                  aria-label={t.knowledgeMemory.editAriaLabel.replace('{title}', item.title)}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onApproveEdit(item, draft)}
                    disabled={isBusy || !draft.trim()}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {t.knowledgeMemory.saveAdopt}
                  </button>
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    disabled={isBusy}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
                  >
                    {t.knowledgeMemory.cancel}
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
                  {t.knowledgeMemory.adopt}
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(item)}
                  disabled={isBusy}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-badge-info/40 bg-sky-500/10 px-2.5 text-[11px] font-medium text-badge-info hover:bg-sky-500/20 disabled:opacity-50"
                >
                  <PencilLine className="h-3.5 w-3.5" />
                  {t.knowledgeMemory.editAdopt}
                </button>
                <button
                  type="button"
                  onClick={() => onReject(item)}
                  disabled={isBusy}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
                >
                  <Ban className="h-3.5 w-3.5" />
                  {t.knowledgeMemory.ignore}
                </button>
              </div>
            )}

            {errorById[item.id] ? (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[11px] leading-4 text-badge-danger">
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
  const { t } = useI18n();
  const label: Record<InboxStatus, string> = {
    approving: t.knowledgeMemory.inboxStatusApproving,
    rejecting: t.knowledgeMemory.inboxStatusRejecting,
    approved: t.knowledgeMemory.inboxStatusApproved,
    rejected: t.knowledgeMemory.inboxStatusRejected,
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

function LoadingRows() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="h-24 animate-pulse rounded-lg border border-zinc-800 bg-zinc-950/60" />
      ))}
    </div>
  );
}

export function KnowledgeInboxSection() {
  const { t } = useI18n();
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const [data, setData] = useState<MemoryAuditPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingInboxId, setEditingInboxId] = useState<string | null>(null);
  const [draftByInboxId, setDraftByInboxId] = useState<Record<string, string>>({});
  const [inboxStatusById, setInboxStatusById] = useState<Record<string, InboxStatus>>({});
  const [inboxErrorById, setInboxErrorById] = useState<Record<string, string>>({});

  const loadAudit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await invokeMemoryAudit({
        projectPath: workingDirectory,
        sessionId: currentSessionId,
      });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [currentSessionId, workingDirectory]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  const handleResolveInboxItem = useCallback(async (
    item: InboxItem,
    decision: 'approve' | 'reject',
    content?: string,
  ) => {
    const runningStatus: InboxStatus = decision === 'approve' ? 'approving' : 'rejecting';
    const doneStatus: InboxStatus = decision === 'approve' ? 'approved' : 'rejected';
    setInboxStatusById((prev) => ({ ...prev, [item.id]: runningStatus }));
    setInboxErrorById((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    setError(null);

    try {
      await invokeMemoryInboxResolve(buildMemoryInboxResolvePayload(item, decision, {
        content,
        projectPath: workingDirectory,
        sessionId: currentSessionId,
      }));
      setInboxStatusById((prev) => ({ ...prev, [item.id]: doneStatus }));
      setEditingInboxId((current) => current === item.id ? null : current);
      await loadAudit();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setInboxStatusById((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      setInboxErrorById((prev) => ({ ...prev, [item.id]: message }));
      setError(t.knowledgeMemory.inboxProcessFailed.replace('{message}', message));
    }
  }, [currentSessionId, loadAudit, t, workingDirectory]);

  const handleStartEditInboxItem = useCallback((item: InboxItem) => {
    setEditingInboxId(item.id);
    setDraftByInboxId((prev) => ({
      ...prev,
      [item.id]: prev[item.id] ?? item.content,
    }));
  }, []);

  const inboxItems = useMemo(() => data ? buildInboxItems(data, t) : [], [data, t]);

  return (
    <SettingsSection
      title={t.knowledgeMemory.inboxSectionTitle}
      description={t.knowledgeMemory.inboxSectionDescription}
      actions={(
        <span className="text-xs text-zinc-500">
          {t.knowledgeMemory.countSuffix.replace('{count}', String(inboxItems.length))}
        </span>
      )}
    >
      <div
        className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-3"
        data-testid="knowledge-inbox-section"
      >
        {error ? (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-badge-danger">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        ) : null}
        {isLoading ? (
          <LoadingRows />
        ) : inboxItems.length === 0 ? (
          <EmptyState
            variant="panel"
            icon={Inbox}
            title={t.knowledgeMemory.inboxEmptyTitle}
            text={t.knowledgeMemory.inboxEmptyText}
          />
        ) : (
          <KnowledgeInboxList
            items={inboxItems}
            editingId={editingInboxId}
            draftById={draftByInboxId}
            statusById={inboxStatusById}
            errorById={inboxErrorById}
            onApprove={(item) => void handleResolveInboxItem(item, 'approve')}
            onReject={(item) => void handleResolveInboxItem(item, 'reject')}
            onEdit={handleStartEditInboxItem}
            onDraftChange={(id, value) => setDraftByInboxId((prev) => ({ ...prev, [id]: value }))}
            onCancelEdit={() => setEditingInboxId(null)}
            onApproveEdit={(item, value) => void handleResolveInboxItem(item, 'approve', value)}
          />
        )}
      </div>
    </SettingsSection>
  );
}
