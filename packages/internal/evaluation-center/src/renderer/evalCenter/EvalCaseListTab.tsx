import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, FilePlus2, RefreshCw } from 'lucide-react';
import { EVALUATION_CHANNELS } from '../../shared/evaluationChannels';
import type {
  EvalCaseListEntry,
  EvalCaseListItem,
  EvalCaseSplitBucket,
} from '@shared/contract/evaluation';
import { invokeEvaluation } from '../evaluationRunIpc';
import { useEvaluationI18n } from '../i18n/useEvaluationI18n';
import { useEvalCenterStore } from '../stores/evalCenterStore';
import { toast } from '@renderer/hooks/useToast';
import { Button } from '@renderer/components/primitives/Button';
import { EmptyState } from '@renderer/components/primitives/EmptyState';
import { Modal, ModalFooter } from '@renderer/components/primitives/Modal';
import { Select } from '@renderer/components/primitives/Select';
import { ConfirmDialog } from '@renderer/components/composites/ConfirmDialog';

// 题库 YAML 的 category 是自由文本，矩阵只认 src/host/testing/types.ts 的 TestCategory 契约四值。
// ⚠ 这里是手抄：渲染侧进不了 host 类型，两边没有类型关联。契约加值必须同步改这里，否则新值会静默落进「其他」列。
const TEST_CATEGORIES = ['basic_tool', 'task_completion', 'error_recovery', 'edge_case'] as const;
const MATRIX_OTHER = '\u0000other';
const MATRIX_MISSING = '\u0000missing';

type LoadState = 'loading' | 'ready' | 'error';
type StatusFilter = 'active' | 'all' | 'normal' | 'draft' | 'archived';

function isParseError(item: EvalCaseListItem): item is Extract<EvalCaseListItem, { parseError: string }> {
  return 'parseError' in item;
}

function matrixColumnLabel(
  column: string,
  c: { matrixOther: string; matrixMissing: string },
  otherKinds: number,
): string {
  if (column === MATRIX_OTHER) return c.matrixOther.replace('{n}', String(otherKinds));
  if (column === MATRIX_MISSING) return c.matrixMissing;
  return column;
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
  if (filter === 'core') return item.splits.includes('core');
  return item.splits.includes('safety');
}

export const EvalCaseListTab: React.FC = () => {
  const { t } = useEvaluationI18n();
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
  const [highlightedCaseId, setHighlightedCaseId] = useState<string | null>(null);
  // 矩阵默认收起（FB-160）：11 行矩阵在 shrink-0 头部里把 1440×900 的题目列表挤到只剩两行。
  const [matrixOpen, setMatrixOpen] = useState(false);
  const focusCaseId = useEvalCenterStore((state) => state.focusCaseId);
  const clearFocusCase = useEvalCenterStore((state) => state.clearCaseTarget);

  const loadCases = useCallback(async () => {
    setLoadState('loading');
    setLoadError('');
    try {
      const result = await invokeEvaluation(EVALUATION_CHANNELS.LIST_CASES);
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

  useEffect(() => {
    if (loadState !== 'ready' || !focusCaseId) return;
    const row = document.getElementById(`eval-case-${focusCaseId}`);
    row?.scrollIntoView({ block: 'center' });
    setHighlightedCaseId(focusCaseId);
    clearFocusCase();
  }, [clearFocusCase, focusCaseId, loadState]);

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
  // 分布矩阵：行=layer、列=归一后的 category，只数在用题（排除 retired/draft）；空格=覆盖盲区。
  // 列归一（FB-157）：题库 YAML 里 category 是自由文本（15 个值），直接当轴会让 165 格里 138 格标红，
  // 红的是元数据没维护不是覆盖盲区。契约四值各占一列，其余非空值合并成「其他」，没填的进「未填」列且不标红。
  const matrix = useMemo(() => {
    const active = validItems.filter((item) => !item.retired && !item.isDraft);
    const counts = new Map<string, number>();
    const otherValues = new Set<string>();
    let missing = 0;
    for (const item of active) {
      const raw = item.category ?? '';
      let column: string;
      if (!raw) {
        column = MATRIX_MISSING;
        missing += 1;
      } else if ((TEST_CATEGORIES as readonly string[]).includes(raw)) {
        column = raw;
      } else {
        column = MATRIX_OTHER;
        otherValues.add(raw);
      }
      const key = `${item.layer}\u0000${column}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const rows = [...new Set(active.map((item) => item.layer))].sort((a, b) => a.localeCompare(b));
    const columns = [...TEST_CATEGORIES, MATRIX_OTHER, MATRIX_MISSING];
    // 收起态摘要要报红格数，口径与下面单元格的 blind 判定一致：未填列的 0 不算盲区。
    let blind = 0;
    for (const layer of rows) {
      for (const column of columns) {
        if (column !== MATRIX_MISSING && !counts.has(`${layer}\u0000${column}`)) blind += 1;
      }
    }
    return {
      rows,
      columns,
      blind,
      cells: rows.length * columns.length,
      otherKinds: otherValues.size,
      missing,
      total: active.length,
      count: (layer: string, column: string) => counts.get(`${layer}\u0000${column}`) ?? 0,
    };
  }, [validItems]);
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
      await invokeEvaluation(EVALUATION_CHANNELS.SAVE_CASE, {
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
      await invokeEvaluation(EVALUATION_CHANNELS.SAVE_CASE, { action: 'archive', id: archiveItem.id });
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
    const label = split === 'held-in' ? c.dailySet : split === 'held-out' ? c.heldOutSet : split === 'core' ? c.coreSet : c.safetySet;
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
            <option value="core">{c.filterCore}</option>
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
        <Button variant="ghost" size="sm" leftIcon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void loadCases()}>{c.refresh}</Button>
        <Button size="sm" leftIcon={<FilePlus2 className="h-3.5 w-3.5" />} onClick={() => setDraftOpen(true)}>{c.newDraft}</Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {/* 矩阵块放在列表滚动区顶部而不是 shrink-0 头部（FB-160）：1440×900 实测，
            放头部时展开只剩 3 行可见；放滚动区里展开后往下滚就能看全列表。 */}
        {matrix.rows.length > 0 && (
          <div className="mb-2">
            <button
              type="button"
              data-testid="eval-case-matrix-toggle"
              aria-expanded={matrixOpen}
              onClick={() => setMatrixOpen((open) => !open)}
              className="text-left text-[10px] text-zinc-500 hover:text-zinc-300"
            >
              {c.matrixSummary
                .replace('{cells}', String(matrix.cells))
                .replace('{blind}', String(matrix.blind))
                .replace('{n}', String(matrix.missing))
                .replace('{m}', String(matrix.total))}
              <span className="ml-1 underline">{matrixOpen ? c.matrixCollapse : c.matrixExpand}</span>
            </button>
            {matrixOpen && (
          <div className="mt-1 overflow-x-auto" data-testid="eval-case-matrix">
            <div className="mb-1 text-[10px] text-zinc-500">{c.matrixTitle}</div>
            <div className="mb-1 text-[10px] text-zinc-500" data-testid="eval-case-matrix-missing-note">
              {c.matrixMissingNote.replace('{n}', String(matrix.missing)).replace('{m}', String(matrix.total))}
            </div>
            <table className="border-separate border-spacing-0 text-[11px]">
              <thead>
                <tr>
                  <th className="border-b border-zinc-800 px-2 py-1 text-left font-medium text-zinc-500">{c.filterLayer}</th>
                  {matrix.columns.map((column) => (
                    <th key={column} className="whitespace-nowrap border-b border-zinc-800 px-2 py-1 text-right font-medium text-zinc-500">{matrixColumnLabel(column, c, matrix.otherKinds)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((layer) => (
                  <tr key={layer}>
                    <td className="min-w-32 whitespace-nowrap px-2 py-1 text-zinc-300">{layer}</td>
                    {matrix.columns.map((column) => {
                      const n = matrix.count(layer, column);
                      // 「未填」列为 0 不标红：没填 category 不是覆盖盲区，缺口另有标题旁那行计数。
                      const blind = n === 0 && column !== MATRIX_MISSING;
                      return (
                        <td
                          key={column}
                          data-testid={blind ? 'eval-case-matrix-empty' : 'eval-case-matrix-cell'}
                          title={blind ? c.matrixEmptyHint : undefined}
                          className={`px-2 py-1 text-right font-mono ${blind ? 'bg-red-500/10 text-badge-danger' : 'text-zinc-200'}`}
                        >
                          {n}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            )}
          </div>
        )}
        {loadState === 'loading' && <div className="py-10 text-center text-sm text-zinc-500">{c.loading}</div>}
        {loadState === 'error' && <div className="py-10 text-center text-sm text-badge-danger">{c.loadFailed.replace('{message}', loadError)}</div>}
        {loadState === 'ready' && filteredItems.length === 0 && <EmptyState variant="inline" text={c.empty} />}
        {loadState === 'ready' && filteredItems.length > 0 && (
          <table className="w-full min-w-[1180px] border-separate border-spacing-0 text-left text-xs">
            {/* FB-161：浅色主题下爸看到行文字透过 sticky 表头。底色原来只挂在 thead 上，
                这一条在 1440×900 的 web 真机没能复现（thead 背景照常绘制），所以下面是加固不是已证根因：
                底色同时挂到每个 th（sticky 表头的通行写法，不依赖引擎绘制 row-group 背景）+ z-10。
                窄列 min-w + nowrap 针对同一条反馈里的「来源/状态/操作逐字竖排」。 */}
            <thead className="sticky top-0 z-10 bg-zinc-950 text-[10px] uppercase tracking-wide text-zinc-500">
              <tr>
                {[
                  [c.colId, ''],
                  [c.colLayer, ''],
                  [c.colTags, ''],
                  [c.colSplits, ''],
                  [c.colTurns, 'min-w-16'],
                  [c.colExpect, 'min-w-24'],
                  [c.colSource, 'min-w-20'],
                  [c.colStatus, 'min-w-16'],
                  [c.colActions, 'min-w-32'],
                ].map(([label, width]) => (
                  <th key={label} className={`whitespace-nowrap border-b border-zinc-800 bg-zinc-950 px-2 py-2 font-medium ${width}`}>{label}</th>
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
                const unavailable = !item.hardened;
                return (
                  <tr
                    id={`eval-case-${item.id}`}
                    key={`${item.file}-${item.id}`}
                    aria-disabled={unavailable || undefined}
                    className={`${status === 'archived' ? 'opacity-55' : ''} ${unavailable ? 'opacity-60 saturate-50' : ''} ${highlightedCaseId === item.id ? 'bg-teal-500/10' : ''}`}
                    data-testid={`eval-case-row-${item.id}`}
                  >
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
                      <span className={item.hardened ? 'text-badge-success' : 'rounded border border-badge-warning/30 bg-amber-500/10 px-1.5 py-0.5 text-badge-warning'}>
                        {item.hardened ? c.hasExpect : c.noExpect}
                      </span>
                      {unavailable && <span className="ml-2 text-[10px] text-zinc-500">{c.notScored}</span>}
                    </td>
                    <td className="border-b border-zinc-900 px-2 py-2 text-zinc-400">{item.source === 'session' ? c.sourceSession : c.sourceManual}</td>
                    <td className="border-b border-zinc-900 px-2 py-2 text-zinc-400">{status === 'draft' ? c.statusDraft : status === 'archived' ? c.statusArchived : c.statusNormal}</td>
                    <td className="border-b border-zinc-900 px-2 py-2">
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" onClick={() => void copyPath(item.file)}>{c.copyPath}</Button>
                        {status !== 'archived' && <Button size="sm" variant="ghost" leftIcon={<Archive className="h-3.5 w-3.5" />} onClick={() => setArchiveItem(item)}>{c.archive}</Button>}
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
