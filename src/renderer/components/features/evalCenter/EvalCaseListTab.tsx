import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, FilePlus2, RefreshCw } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  EvalCaseListEntry,
  EvalCaseListItem,
  EvalCaseSplitBucket,
} from '@shared/contract/evaluation';
import ipcService from '../../../services/ipcService';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { Button } from '../../primitives/Button';
import { EmptyState } from '../../primitives/EmptyState';
import { Modal, ModalFooter } from '../../primitives/Modal';
import { Select } from '../../primitives/Select';
import { ConfirmDialog } from '../../composites/ConfirmDialog';

type LoadState = 'loading' | 'ready' | 'error';
type StatusFilter = 'active' | 'all' | 'normal' | 'draft' | 'archived';

function isParseError(item: EvalCaseListItem): item is Extract<EvalCaseListItem, { parseError: string }> {
  return 'parseError' in item;
}

function statusOf(item: EvalCaseListEntry): Exclude<StatusFilter, 'active' | 'all'> {
  if (item.isDraft) return 'draft';
  if (item.retired) return 'archived';
  return 'normal';
}

function matchesSplit(item: EvalCaseListEntry, filter: string): boolean {
  if (!filter) return true;
  if (filter === 'daily') return item.splits.includes('held-in');
  if (filter === 'held-out') return item.splits.includes('held-out');
  return item.splits.includes('safety');
}

export const EvalCaseListTab: React.FC = () => {
  const { t } = useI18n();
  const c = t.evalCenter.cases;
  const [items, setItems] = useState<EvalCaseListItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [layerFilter, setLayerFilter] = useState('');
  const [splitFilter, setSplitFilter] = useState('');
  const [expectFilter, setExpectFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftId, setDraftId] = useState('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [savingDraft, setSavingDraft] = useState(false);
  const [archiveItem, setArchiveItem] = useState<EvalCaseListEntry | null>(null);
  const [archiving, setArchiving] = useState(false);

  const loadCases = useCallback(async () => {
    setLoadState('loading');
    setLoadError('');
    try {
      const result = await ipcService.invoke(IPC_CHANNELS.EVALUATION_LIST_CASES);
      setItems(result ?? []);
      setLoadState('ready');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void loadCases();
  }, [loadCases]);

  const validItems = useMemo(() => items.filter((item): item is EvalCaseListEntry => !isParseError(item)), [items]);
  const counts = useMemo(() => ({
    drafts: validItems.filter((item) => item.isDraft).length,
    special: validItems.filter((item) => !item.isDraft && item.relativeDir.length > 0).length,
    defaults: validItems.filter((item) => !item.isDraft && item.relativeDir.length === 0).length,
  }), [validItems]);
  const layers = useMemo(
    () => [...new Set(validItems.map((item) => item.layer))].sort((a, b) => a.localeCompare(b)),
    [validItems],
  );
  const filteredItems = useMemo(() => items.filter((item) => {
    if (isParseError(item)) return !layerFilter && !splitFilter && !expectFilter && statusFilter !== 'archived';
    if (layerFilter && item.layer !== layerFilter) return false;
    if (!matchesSplit(item, splitFilter)) return false;
    if (expectFilter === 'has' && !item.hasExpect) return false;
    if (expectFilter === 'missing' && item.hasExpect) return false;
    const status = statusOf(item);
    if (statusFilter === 'active') return status !== 'archived';
    if (statusFilter !== 'all' && statusFilter !== status) return false;
    return true;
  }), [expectFilter, items, layerFilter, splitFilter, statusFilter]);

  const resetDraft = () => {
    setDraftId('');
    setDraftPrompt('');
    setDraftTags('');
  };

  const createDraft = useCallback(async () => {
    setSavingDraft(true);
    try {
      await ipcService.invoke(IPC_CHANNELS.EVALUATION_SAVE_CASE, {
        action: 'create-draft',
        id: draftId,
        prompt: draftPrompt,
        tags: draftTags.split(',').map((tag) => tag.trim()).filter(Boolean),
      });
      setDraftOpen(false);
      resetDraft();
      toast.success(c.draftSaved);
      await loadCases();
    } catch (error) {
      toast.error(c.actionFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
    } finally {
      setSavingDraft(false);
    }
  }, [c.actionFailed, c.draftSaved, draftId, draftPrompt, draftTags, loadCases]);

  const archiveCase = useCallback(async () => {
    if (!archiveItem) return;
    setArchiving(true);
    try {
      await ipcService.invoke(IPC_CHANNELS.EVALUATION_SAVE_CASE, { action: 'archive', id: archiveItem.id });
      setArchiveItem(null);
      toast.success(c.archived);
      await loadCases();
    } catch (error) {
      toast.error(c.actionFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
    } finally {
      setArchiving(false);
    }
  }, [archiveItem, c.actionFailed, c.archived, loadCases]);

  const copyPath = useCallback(async (file: string) => {
    try {
      await navigator.clipboard.writeText(`.claude/test-cases/${file}`);
      toast.success(c.copiedPath);
    } catch (error) {
      toast.error(c.actionFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
    }
  }, [c.actionFailed, c.copiedPath]);

  const splitChip = (split: EvalCaseSplitBucket) => {
    if (split === 'control') return null;
    const label = split === 'held-in' ? c.dailySet : split === 'held-out' ? c.heldOutSet : c.safetySet;
    const classes = split === 'safety'
      ? 'border-badge-warning/30 bg-amber-500/10 text-badge-warning'
      : 'border-badge-info/30 bg-sky-500/10 text-badge-info';
    return <span key={split} className={`rounded border px-1.5 py-0.5 text-[10px] ${classes}`}>{label}</span>;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="eval-case-list-tab">
      <div className="shrink-0 border-b border-zinc-800 px-3 py-3">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <div className="rounded-lg bg-zinc-900/70 px-3 py-2 shadow-sm">
            <div className="text-sm font-medium text-zinc-200">{c.defaultCount.replace('{n}', String(counts.defaults))}</div>
            <div className="text-[10px] text-zinc-500">{c.defaultNote}</div>
          </div>
          <div className="rounded-lg bg-zinc-900/70 px-3 py-2 shadow-sm">
            <div className="text-sm font-medium text-zinc-200">{c.specialCount.replace('{n}', String(counts.special))}</div>
            <div className="text-[10px] text-badge-warning">{c.specialNote}</div>
          </div>
          <div className="rounded-lg bg-zinc-900/70 px-3 py-2 shadow-sm">
            <div className="text-sm font-medium text-zinc-200">{c.draftCount.replace('{n}', String(counts.drafts))}</div>
            <div className="text-[10px] text-zinc-500">{c.draftNote}</div>
          </div>
        </div>
        <p className="mt-2 text-xs text-zinc-500">{c.specialHint}</p>
      </div>

      <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-zinc-800 px-3 py-2">
        <label className="min-w-36 text-[10px] text-zinc-500">
          <span className="mb-1 block">{c.filterLayer}</span>
          <Select selectSize="sm" value={layerFilter} onChange={(event) => setLayerFilter(event.target.value)}>
            <option value="">{c.filterAll}</option>
            {layers.map((layer) => <option key={layer} value={layer}>{layer}</option>)}
          </Select>
        </label>
        <label className="min-w-32 text-[10px] text-zinc-500">
          <span className="mb-1 block">{c.filterSplit}</span>
          <Select selectSize="sm" value={splitFilter} onChange={(event) => setSplitFilter(event.target.value)}>
            <option value="">{c.filterAll}</option>
            <option value="daily">{c.filterDaily}</option>
            <option value="held-out">{c.filterHeldOut}</option>
            <option value="safety">{c.filterSafety}</option>
          </Select>
        </label>
        <label className="min-w-40 text-[10px] text-zinc-500">
          <span className="mb-1 block">{c.filterExpect}</span>
          <Select selectSize="sm" value={expectFilter} onChange={(event) => setExpectFilter(event.target.value)}>
            <option value="">{c.filterAll}</option>
            <option value="has">{c.filterHasExpect}</option>
            <option value="missing">{c.filterNoExpect}</option>
          </Select>
        </label>
        <label className="min-w-32 text-[10px] text-zinc-500">
          <span className="mb-1 block">{c.filterStatus}</span>
          <Select selectSize="sm" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
            <option value="active">{c.filterActive}</option>
            <option value="all">{c.filterAll}</option>
            <option value="normal">{c.filterNormal}</option>
            <option value="draft">{c.filterDraft}</option>
            <option value="archived">{c.filterArchived}</option>
          </Select>
        </label>
        <span className="ml-auto text-[10px] text-zinc-600">{c.total.replace('{visible}', String(filteredItems.length)).replace('{total}', String(items.length))}</span>
        <Button variant="ghost" size="sm" leftIcon={<RefreshCw />} onClick={() => void loadCases()}>{c.refresh}</Button>
        <Button size="sm" leftIcon={<FilePlus2 />} onClick={() => setDraftOpen(true)}>{c.newDraft}</Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {loadState === 'loading' && <div className="py-10 text-center text-sm text-zinc-500">{c.loading}</div>}
        {loadState === 'error' && <div className="py-10 text-center text-sm text-badge-danger">{c.loadFailed.replace('{message}', loadError)}</div>}
        {loadState === 'ready' && filteredItems.length === 0 && <EmptyState variant="inline" text={c.empty} />}
        {loadState === 'ready' && filteredItems.length > 0 && (
          <table className="w-full min-w-[1180px] border-separate border-spacing-0 text-left text-xs">
            <thead className="sticky top-0 bg-zinc-950 text-[10px] uppercase tracking-wide text-zinc-500">
              <tr>
                {[c.colId, c.colLayer, c.colTags, c.colSplits, c.colTurns, c.colExpect, c.colSource, c.colStatus, c.colActions].map((label) => (
                  <th key={label} className="border-b border-zinc-800 px-2 py-2 font-medium">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => {
                if (isParseError(item)) {
                  return (
                    <tr key={`parse-${item.file}`} className="text-zinc-600" data-testid="eval-case-parse-error">
                      <td className="border-b border-zinc-900 px-2 py-3 font-mono">{item.id}</td>
                      <td colSpan={7} className="border-b border-zinc-900 px-2 py-3">{c.parseFailed.replace('{message}', item.parseError)}</td>
                      <td className="border-b border-zinc-900 px-2 py-3"><Button size="sm" variant="ghost" onClick={() => void copyPath(item.file)}>{c.copyPath}</Button></td>
                    </tr>
                  );
                }
                const status = statusOf(item);
                const inherited = item.inheritedTags.filter((tag) => !item.tags.includes(tag));
                return (
                  <tr key={`${item.file}-${item.id}`} className={status === 'archived' ? 'opacity-55' : ''} data-testid={`eval-case-row-${item.id}`}>
                    <td className="border-b border-zinc-900 px-2 py-2 font-mono text-zinc-300">{item.id}</td>
                    <td className="border-b border-zinc-900 px-2 py-2">
                      <div className="text-zinc-300">{item.layer}</div>
                      <div className="max-w-48 truncate font-mono text-[10px] text-zinc-600" title={item.file}>{item.file}</div>
                    </td>
                    <td className="border-b border-zinc-900 px-2 py-2">
                      <div className="flex max-w-64 flex-wrap gap-1">
                        {item.tags.map((tag) => <span key={`own-${tag}`} className="rounded border border-badge-accent/30 bg-teal-500/10 px-1.5 py-0.5 text-[10px] text-badge-accent">{tag}</span>)}
                        {inherited.map((tag) => <span key={`inherited-${tag}`} title={c.inheritedTag} className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-500">{tag}</span>)}
                      </div>
                    </td>
                    <td className="border-b border-zinc-900 px-2 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {item.splits.map(splitChip)}
                        {item.splits.includes('control') && <span className="text-[10px] text-zinc-600">{c.calibrationSample}</span>}
                      </div>
                    </td>
                    <td className="border-b border-zinc-900 px-2 py-2 font-mono text-zinc-400">{item.turns === 'simulator' ? c.simulatorTurns : item.turns}</td>
                    <td className="border-b border-zinc-900 px-2 py-2">
                      <span className={item.hasExpect ? 'text-badge-success' : 'rounded border border-badge-warning/30 bg-amber-500/10 px-1.5 py-0.5 text-badge-warning'}>
                        {item.hasExpect ? c.hasExpect : c.noExpect}
                      </span>
                    </td>
                    <td className="border-b border-zinc-900 px-2 py-2 text-zinc-400">{item.source === 'session' ? c.sourceSession : c.sourceManual}</td>
                    <td className="border-b border-zinc-900 px-2 py-2 text-zinc-400">{status === 'draft' ? c.statusDraft : status === 'archived' ? c.statusArchived : c.statusNormal}</td>
                    <td className="border-b border-zinc-900 px-2 py-2">
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" onClick={() => void copyPath(item.file)}>{c.copyPath}</Button>
                        {status !== 'archived' && <Button size="sm" variant="ghost" leftIcon={<Archive />} onClick={() => setArchiveItem(item)}>{c.archive}</Button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        isOpen={draftOpen}
        onClose={() => setDraftOpen(false)}
        title={c.draftTitle}
        size="lg"
        footer={<ModalFooter cancelText={t.common.cancel} confirmText={c.createDraft} onCancel={() => setDraftOpen(false)} onConfirm={() => void createDraft()} confirmDisabled={!draftId.trim() || !draftPrompt.trim() || savingDraft} cancelDisabled={savingDraft} />}
      >
        <div className="space-y-4">
          <label className="block text-xs text-zinc-400">
            <span>{c.draftId}</span>
            <input data-modal-autofocus="true" value={draftId} onChange={(event) => setDraftId(event.target.value)} placeholder={c.draftIdPlaceholder} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-hidden focus:border-zinc-500" />
          </label>
          <label className="block text-xs text-zinc-400">
            <span>{c.draftPrompt}</span>
            <textarea value={draftPrompt} onChange={(event) => setDraftPrompt(event.target.value)} placeholder={c.draftPromptPlaceholder} rows={5} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-hidden focus:border-zinc-500" />
          </label>
          <label className="block text-xs text-zinc-400">
            <span>{c.draftTags}</span>
            <input value={draftTags} onChange={(event) => setDraftTags(event.target.value)} placeholder={c.draftTagsPlaceholder} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-hidden focus:border-zinc-500" />
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={archiveItem !== null}
        title={c.archiveTitle}
        message={c.archiveMessage}
        variant="warning"
        confirmText={c.confirmArchive}
        cancelText={t.common.cancel}
        onConfirm={() => void archiveCase()}
        onCancel={() => setArchiveItem(null)}
        confirmDisabled={archiving}
        cancelDisabled={archiving}
      />
    </div>
  );
};
