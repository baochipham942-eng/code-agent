// ============================================================================
// EvalHarvestDialog —— 「从会话转成题目」（对齐页 B7 + B8）
//
// 两段一个组件：
// - B7 字段映射清单：默认全勾按需取消；「会话 id」勾选锁定（来源必须留）、
//   「助手回复」整行置灰不可勾（回复不是题目的一部分）。
// - B8 逐份草稿表单：候选判定标准由宿主从会话推出，人勾/改/删；
//   零确认时「保存为草稿」置灰 + 理由常驻，无任何绕过出口。
//   次要出口「存为待办，稍后再补」落草稿区并标「还没有判定标准」。
//
// 硬化（移出 drafts/ + reviewStatus:reviewed）不在这里：确认过判定标准的草稿
// 依旧是 pending，题库页照旧整行禁选。
// ============================================================================
import React, { useMemo, useState } from 'react';
import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import {
  EVAL_DRAFT_CASE_TYPES,
  HARVEST_DEFAULT_FIELDS,
  HARVEST_EXPECTATION_PARAM_KEYS,
  HARVEST_EXPECTATION_TYPES,
  HARVEST_LOCKED_FIELDS,
} from '@shared/contract/evaluation';
import type {
  EvalDraftCaseType,
  HarvestCandidate,
  HarvestDraftSeed,
  HarvestExpectationType,
  HarvestFieldKey,
} from '@shared/contract/evaluation';
import { EVALUATION_CHANNELS } from '../../shared/evaluationChannels';
import { invokeEvaluation } from '../evaluationRunIpc';
import { useEvaluationI18n } from '../i18n/useEvaluationI18n';
import { toast } from '@renderer/hooks/useToast';
import { Button } from '@renderer/components/primitives/Button';
import { Modal } from '@renderer/components/primitives/Modal';
import { Select } from '@renderer/components/primitives/Select';

type Phase = 'mapping' | 'loading' | 'drafts';

interface CandidateRow extends HarvestCandidate {
  rowId: string;
  confirmed: boolean;
}

interface DraftForm {
  seed: HarvestDraftSeed;
  id: string;
  caseType: EvalDraftCaseType;
  description: string;
  prompt: string;
  tags: string[];
  rows: CandidateRow[];
}

const FIELD_ROWS: Array<{ key: HarvestFieldKey | 'assistantReply'; labelKey: string; noteKey: string; targetKey: string }> = [
  { key: 'prompt', labelKey: 'fieldPromptLabel', noteKey: 'fieldPromptNote', targetKey: 'fieldPromptTarget' },
  { key: 'sourceSessionId', labelKey: 'fieldSessionIdLabel', noteKey: 'fieldSessionIdNote', targetKey: 'fieldSessionIdTarget' },
  { key: 'qualityTags', labelKey: 'fieldQualityLabel', noteKey: 'fieldQualityNote', targetKey: 'fieldQualityTarget' },
  { key: 'toolTrace', labelKey: 'fieldToolTraceLabel', noteKey: 'fieldToolTraceNote', targetKey: 'fieldToolTraceTarget' },
  { key: 'assistantReply', labelKey: 'fieldReplyLabel', noteKey: 'fieldReplyNote', targetKey: 'fieldReplyTarget' },
];

const INPUT_CLASS = 'mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-hidden focus:border-zinc-500';

let rowSeq = 0;
function toRows(candidates: HarvestCandidate[]): CandidateRow[] {
  return candidates.map((candidate) => ({ ...candidate, rowId: `row-${(rowSeq += 1)}`, confirmed: false }));
}

function toForm(seed: HarvestDraftSeed): DraftForm {
  return {
    seed,
    id: seed.id,
    caseType: 'task',
    description: seed.description,
    prompt: seed.prompt,
    tags: [...seed.tags],
    rows: toRows(seed.candidates),
  };
}

export interface EvalHarvestDialogProps {
  sessionIds: string[];
  onClose: () => void;
  /** 头部「来源会话 ↗」点击：回到回放视图看当时发生了什么。 */
  onOpenSession: (sessionId: string) => void;
  /** 全部草稿收完后通知外面刷新题库计数。 */
  onFinished: () => void;
}

export const EvalHarvestDialog: React.FC<EvalHarvestDialogProps> = ({
  sessionIds,
  onClose,
  onOpenSession,
  onFinished,
}) => {
  const { t } = useEvaluationI18n();
  const h = t.evalCenter.harvest;
  const [phase, setPhase] = useState<Phase>('mapping');
  const [fields, setFields] = useState<HarvestFieldKey[]>([...HARVEST_DEFAULT_FIELDS]);
  const [forms, setForms] = useState<DraftForm[]>([]);
  const [index, setIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [manualType, setManualType] = useState<HarvestExpectationType>(HARVEST_EXPECTATION_TYPES[0]);

  const batchTag = forms[0]?.seed.tags[0] ?? '';
  const current = forms[index];
  const confirmedCount = current ? current.rows.filter((row) => row.confirmed).length : 0;

  const typeLabels = useMemo<Record<EvalDraftCaseType, string>>(() => ({
    tool: h.typeTool,
    task: h.typeTask,
    conversation: h.typeConversation,
    error_handling: h.typeErrorHandling,
    multi_step: h.typeMultiStep,
  }), [h]);

  const toggleField = (key: HarvestFieldKey) => {
    if (HARVEST_LOCKED_FIELDS.includes(key)) return;
    setFields((previous) => (previous.includes(key)
      ? previous.filter((field) => field !== key)
      : [...previous, key]));
  };

  const generate = async () => {
    setPhase('loading');
    try {
      const result = await invokeEvaluation(EVALUATION_CHANNELS.HARVEST_PREVIEW, { sessionIds, fields });
      if (result.failed.length > 0) {
        const detail = result.failed.map((row) => `${row.sessionId}：${row.error}`).join('；');
        const template = result.seeds.length === 0 ? h.allFailed : h.partialFailed;
        toast.error(template.replace('{n}', String(result.failed.length)).replace('{detail}', detail));
      }
      if (result.seeds.length === 0) {
        setPhase('mapping');
        return;
      }
      setForms(result.seeds.map(toForm));
      setIndex(0);
      setPhase('drafts');
    } catch (error) {
      toast.error(h.previewFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
      setPhase('mapping');
    }
  };

  const patchCurrent = (patch: Partial<DraftForm>) => {
    setForms((previous) => previous.map((form, position) => (position === index ? { ...form, ...patch } : form)));
  };

  const patchRow = (rowId: string, patch: Partial<CandidateRow>) => {
    if (!current) return;
    patchCurrent({ rows: current.rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)) });
  };

  const advance = () => {
    setTagDraft('');
    if (index + 1 < forms.length) {
      setIndex(index + 1);
      return;
    }
    toast.success(h.doneTitle.replace('{n}', String(forms.length)));
    onFinished();
    onClose();
  };

  const save = async (pending: boolean) => {
    if (!current) return;
    if (!pending && confirmedCount === 0) return;
    setSaving(true);
    try {
      const result = await invokeEvaluation(EVALUATION_CHANNELS.SAVE_CASE, {
        action: 'create-draft',
        id: current.id.trim(),
        prompt: current.prompt,
        description: current.description,
        type: current.caseType,
        tags: current.tags,
        sourceSessionId: current.seed.sessionId,
        pending,
        expectations: pending
          ? []
          : current.rows
            .filter((row) => row.confirmed)
            .map((row) => ({ type: row.type, params: row.params, reason: row.reason })),
      });
      toast.success(h.saved.replace('{id}', result.id));
      advance();
    } catch (error) {
      toast.error(h.saveFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
    } finally {
      setSaving(false);
    }
  };

  const addManualCandidate = () => {
    if (!current) return;
    const params: Record<string, string> = {};
    for (const key of HARVEST_EXPECTATION_PARAM_KEYS[manualType]) params[key] = '';
    patchCurrent({
      rows: [...current.rows, { ...toRows([{ type: manualType, params, reason: '' }])[0], confirmed: false }],
    });
  };

  const addTag = () => {
    if (!current) return;
    const tag = tagDraft.trim();
    if (!tag || current.tags.includes(tag)) return;
    patchCurrent({ tags: [...current.tags, tag] });
    setTagDraft('');
  };

  const title = phase === 'drafts' && current
    ? h.stepTitle.replace('{index}', String(index + 1)).replace('{total}', String(forms.length))
    : h.openButton;

  return (
    <Modal isOpen onClose={onClose} title={title} size="lg" footer={renderFooter()}>
      <div className="space-y-4" data-testid="eval-harvest-dialog">
        {phase !== 'drafts' ? renderMapping() : renderDraft()}
      </div>
    </Modal>
  );

  function renderMapping() {
    return (
      <>
        <div className="text-xs text-zinc-400">{h.selectedCount.replace('{n}', String(sessionIds.length))}</div>
        <div>
          <div className="mb-2 text-xs font-medium text-zinc-400">{h.mappingTitle}</div>
          <div className="space-y-1.5">
            {FIELD_ROWS.map((row) => {
              const isReply = row.key === 'assistantReply';
              const locked = !isReply && HARVEST_LOCKED_FIELDS.includes(row.key as HarvestFieldKey);
              const checked = isReply ? false : fields.includes(row.key as HarvestFieldKey);
              return (
                <label
                  key={row.key}
                  data-testid={`eval-harvest-field-${row.key}`}
                  className={`flex items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2 text-xs ${
                    isReply ? 'cursor-not-allowed opacity-50' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isReply || locked}
                    onChange={() => !isReply && toggleField(row.key as HarvestFieldKey)}
                    aria-label={h[row.labelKey as keyof typeof h]}
                  />
                  <span className="w-28 shrink-0 text-zinc-200">{h[row.labelKey as keyof typeof h]}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-500">{h[row.noteKey as keyof typeof h]}</span>
                  <span className="shrink-0 text-zinc-600">→</span>
                  <span className="w-40 shrink-0 truncate text-right text-zinc-400">{h[row.targetKey as keyof typeof h]}</span>
                </label>
              );
            })}
          </div>
        </div>
        <div
          className="rounded-lg border border-badge-warning/30 bg-amber-500/10 px-3 py-2 text-xs text-badge-warning"
          data-testid="eval-harvest-standing-hint"
        >
          {h.standingHint}
        </div>
        <div className="text-xs text-zinc-400">
          <span className="text-zinc-500">{h.bucketLabel}：</span>
          {h.bucketValue.replace('{tag}', batchTagPreview())}
        </div>
      </>
    );
  }

  function renderDraft() {
    if (!current) return null;
    return (
      <>
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span className="text-zinc-500">{h.sourceLabel}</span>
          <Button
            variant="ghost"
            size="sm"
            rightIcon={<ExternalLink className="h-3 w-3" />}
            onClick={() => onOpenSession(current.seed.sessionId)}
            aria-label={h.openSource}
          >
            {current.seed.sessionId}
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-zinc-400">
            <span>{h.fieldId}</span>
            <input
              value={current.id}
              onChange={(event) => patchCurrent({ id: event.target.value })}
              className={INPUT_CLASS}
              data-testid="eval-harvest-id"
            />
          </label>
          <label className="block text-xs text-zinc-400">
            <span>{h.fieldType}</span>
            <Select
              selectSize="sm"
              value={current.caseType}
              onChange={(event) => patchCurrent({ caseType: event.target.value as EvalDraftCaseType })}
              className="mt-1"
            >
              {EVAL_DRAFT_CASE_TYPES.map((value) => (
                <option key={value} value={value}>{typeLabels[value]}</option>
              ))}
            </Select>
          </label>
        </div>

        <div className="text-xs text-zinc-500">
          {h.fieldBucket}：<span className="text-zinc-300">{h.bucketDraft}</span>
        </div>

        <label className="block text-xs text-zinc-400">
          <span>{h.fieldDescription}</span>
          <input
            value={current.description}
            onChange={(event) => patchCurrent({ description: event.target.value })}
            className={INPUT_CLASS}
          />
        </label>

        <label className="block text-xs text-zinc-400">
          <span>{h.fieldPrompt}</span>
          <textarea
            value={current.prompt}
            onChange={(event) => patchCurrent({ prompt: event.target.value })}
            rows={4}
            className={INPUT_CLASS}
            data-testid="eval-harvest-prompt"
          />
        </label>

        <div className="text-xs text-zinc-400">
          <span>{h.fieldTags}</span>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {current.tags.map((tag) => (
              <span key={tag} className="flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300">
                {tag}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={h.removeTag.replace('{tag}', tag)}
                  onClick={() => patchCurrent({ tags: current.tags.filter((value) => value !== tag) })}
                >
                  ✕
                </Button>
              </span>
            ))}
            <input
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              className="w-28 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-zinc-500"
            />
            <Button variant="ghost" size="sm" onClick={addTag}>{h.addTag}</Button>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 p-3">
          <div className="text-xs font-medium text-zinc-300">{h.candidatesTitle}</div>
          <div className="mt-1 text-[11px] text-zinc-500">{h.candidatesHint}</div>
          {current.seed.notes.map((note) => (
            <div key={note} className="mt-2 text-[11px] text-badge-warning" data-testid={`eval-harvest-note-${note}`}>
              {note === 'noCandidates' ? h.noCandidates : h.negativeFeedbackNeedsManual}
            </div>
          ))}
          <div className="mt-2 space-y-2">
            {current.rows.map((row) => (
              <div key={row.rowId} data-testid={`eval-harvest-candidate-${row.rowId}`} className="flex items-start gap-2 rounded-lg bg-zinc-900/70 px-2 py-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={row.confirmed}
                  onChange={(event) => patchRow(row.rowId, { confirmed: event.target.checked })}
                  aria-label={row.type}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-zinc-200">{row.type}</div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {HARVEST_EXPECTATION_PARAM_KEYS[row.type].map((key) => (
                      <label key={key} className="text-[10px] text-zinc-500">
                        <span>{key}</span>
                        <input
                          value={row.params[key] ?? ''}
                          onChange={(event) => patchRow(row.rowId, { params: { ...row.params, [key]: event.target.value } })}
                          className="ml-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-zinc-500"
                          aria-label={`${row.type} ${key}`}
                        />
                      </label>
                    ))}
                  </div>
                  {row.reason && <div className="mt-1 text-[10px] text-zinc-500">{row.reason}</div>}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={h.candidateRemove}
                  leftIcon={<Trash2 className="h-3 w-3" />}
                  onClick={() => patchCurrent({ rows: current.rows.filter((value) => value.rowId !== row.rowId) })}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="ghost" size="sm" leftIcon={<Plus className="h-3 w-3" />} onClick={addManualCandidate}>
              {h.manualAdd}
            </Button>
            <Select
              selectSize="sm"
              value={manualType}
              onChange={(event) => setManualType(event.target.value as HarvestExpectationType)}
              aria-label={h.manualAddTypes}
              className="w-48"
            >
              {HARVEST_EXPECTATION_TYPES.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </Select>
          </div>
        </div>
      </>
    );
  }

  function batchTagPreview(): string {
    if (batchTag) return batchTag;
    const now = new Date();
    return `harvest-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  }

  function renderFooter() {
    if (phase !== 'drafts') {
      return (
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={phase === 'loading'}>{t.common.cancel}</Button>
          <Button
            onClick={() => void generate()}
            disabled={phase === 'loading' || sessionIds.length === 0}
            data-testid="eval-harvest-generate"
          >
            {phase === 'loading' ? h.generating : h.generate.replace('{n}', String(sessionIds.length))}
          </Button>
        </div>
      );
    }
    const blocked = confirmedCount === 0;
    return (
      <div className="flex w-full flex-col gap-2">
        {blocked && (
          <div className="text-[11px] text-badge-warning" data-testid="eval-harvest-zero-hint">{h.zeroConfirmed}</div>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void save(true)}
              disabled={saving}
              data-testid="eval-harvest-save-pending"
            >
              {h.savePending}
            </Button>
            <div className="text-[10px] text-zinc-600">{h.savePendingNote}</div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`text-[11px] ${blocked ? 'text-badge-warning' : 'text-zinc-500'}`}
              data-testid="eval-harvest-save-reason"
            >
              {blocked ? h.blockedReason : h.confirmedCount.replace('{n}', String(confirmedCount))}
            </span>
            <Button
              onClick={() => void save(false)}
              disabled={blocked || saving}
              data-testid="eval-harvest-save"
            >
              {saving ? h.saving : h.save}
            </Button>
          </div>
        </div>
      </div>
    );
  }
};

export default EvalHarvestDialog;
