import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  GripVertical,
  ListChecks,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import type {
  PlanApprovalRecord,
  PlanApprovalRequest,
  PlanApprovalResponse,
  PlanApprovalStep,
} from '@shared/contract/planApproval';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../hooks/useI18n';
import ipcService from '../services/ipcService';
import { useSessionStore } from '../stores/sessionStore';
import { Button } from './primitives/Button';
import { DecisionCollapsedBar } from './DecisionCard';
import {
  movePlanStep,
  type PendingPlanApprovalTarget,
  updateMessageWithPlanApproval,
} from '../utils/planApprovalView';

type EditorMode = 'steps' | 'feedback';

function editedStep(step: PlanApprovalStep, content: string): PlanApprovalStep {
  const nextContent = content.trim();
  return {
    ...step,
    content: nextContent,
    ...(nextContent !== step.originalContent ? { edited: true } : { edited: undefined }),
  };
}

export const PlanApprovalEvidence: React.FC<{ approval: PlanApprovalRecord }> = ({ approval }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const approved = approval.status === 'approved';
  const summary = approved
    ? t.planApproval.approvedSummary.replace('{count}', String(approval.steps.length))
    : approval.status === 'revision_requested'
      ? t.planApproval.revisionSummary
      : t.planApproval.cancelledSummary;

  return (
    <div className="my-1 rounded-lg border border-zinc-800 bg-zinc-900/70" data-testid="plan-approval-evidence">
      <button /* ds-allow:button: 折叠存证整行点击，复用 tool step disclosure 形态 */
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-surface-subtle ${
          approved ? 'text-badge-success' : 'text-zinc-400'
        }`}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {approved && <Check className="h-3.5 w-3.5" />}
        <span className="font-medium">{summary}</span>
        {approval.reordered && <span className="text-[10px] text-badge-warning">{t.planApproval.reordered}</span>}
        <span className="ml-auto text-[10px] text-zinc-500">{t.planApproval.evidenceHint}</span>
      </button>
      {expanded && (
        <ol className="space-y-1 border-t border-zinc-800 px-3 py-2">
          {approval.steps.map((step, index) => (
            <li key={step.id} className="flex gap-2 text-xs leading-5 text-zinc-300">
              <span className="w-4 shrink-0 text-right font-mono text-zinc-600">{index + 1}</span>
              <span className="min-w-0 flex-1">{step.content}</span>
              {step.edited && (
                <span className="shrink-0 rounded border border-badge-warning/30 bg-amber-500/10 px-1.5 text-[10px] text-badge-warning">
                  {t.planApproval.changed}
                </span>
              )}
            </li>
          ))}
          {approval.removedSteps?.map((step) => (
            <li key={`removed-${step.id}`} className="flex gap-2 text-xs leading-5 text-zinc-600">
              <span className="w-4 shrink-0" />
              <span className="min-w-0 flex-1 line-through">{step.content}</span>
              <span className="shrink-0 text-[10px] text-badge-danger">{t.planApproval.removed}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

export const PlanApprovalCard: React.FC<{ target: PendingPlanApprovalTarget }> = ({ target }) => {
  const { t } = useI18n();
  const [steps, setSteps] = useState<PlanApprovalStep[]>(() => target.approval.steps.map((step) => ({ ...step })));
  const [mode, setMode] = useState<EditorMode>('steps');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [feedback, setFeedback] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    setCollapsed(false);
  }, [target.toolCallId]);

  useEffect(() => {
    if (collapsed) return;
    // 编辑输入框与反馈 textarea 自带 autoFocus；这里不能把焦点抢回卡容器。
    if (mode !== 'steps' || editingId !== null) return;
    if (steps.length > 0 && !submitting) {
      primaryButtonRef.current?.focus();
      return;
    }
    cardRef.current?.focus();
  }, [collapsed, editingId, mode, steps.length, submitting]);

  const applyResponse = useCallback((response: PlanApprovalResponse) => {
    const store = useSessionStore.getState();
    const message = store.messages.find((candidate) => candidate.id === target.messageId);
    if (message) {
      const updated = updateMessageWithPlanApproval(message, target.toolCallId, response);
      store.updateMessage(message.id, updated);
    }
    if (response.tasks) store.setSessionTasks(response.tasks);
  }, [target.messageId, target.toolCallId]);

  const submit = useCallback(async (
    decision: PlanApprovalRequest['decision'],
    payload?: Pick<PlanApprovalRequest, 'steps' | 'feedback'>,
  ) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await ipcService.invokeDomain<PlanApprovalResponse>(
        IPC_DOMAINS.PLANNING,
        'respondApproval',
        {
          sessionId: target.sessionId,
          messageId: target.messageId,
          toolCallId: target.toolCallId,
          decision,
          ...payload,
        } satisfies PlanApprovalRequest,
      );
      applyResponse(response);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t.planApproval.submitFailed);
      setSubmitting(false);
    }
  }, [applyResponse, submitting, t.planApproval.submitFailed, target]);

  const beginEdit = (step: PlanApprovalStep) => {
    setEditingId(step.id);
    setDraft(step.content);
    setError(null);
  };

  const saveEdit = () => {
    const content = draft.trim();
    if (!editingId || !content) return;
    setSteps((current) => current.map((step) => (
      step.id === editingId ? editedStep(step, content) : step
    )));
    setEditingId(null);
    setDraft('');
  };

  useEffect(() => {
    if (collapsed) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (editingId) {
          setEditingId(null);
          setDraft('');
        } else if (mode === 'feedback') {
          setMode('steps');
        } else if (!submitting) {
          setCollapsed(true);
        }
        return;
      }
      const targetElement = event.target as HTMLElement | null;
      if (targetElement instanceof HTMLInputElement || targetElement instanceof HTMLTextAreaElement) return;
      const digit = Number.parseInt(event.key, 10);
      if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(steps.length, 9)) {
        event.preventDefault();
        event.stopPropagation();
        rowRefs.current[digit - 1]?.focus();
        return;
      }
      if (
        event.key === 'Enter'
        && primaryButtonRef.current === document.activeElement
        && !submitting
      ) {
        const primaryButton = primaryButtonRef.current;
        if (!primaryButton || primaryButton.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        primaryButton.click();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [collapsed, editingId, mode, steps, submitting]);

  if (collapsed) {
    return (
      <DecisionCollapsedBar
        label={t.decisionCard.pendingLabel}
        expandLabel={t.decisionCard.expand}
        count={1}
        onExpand={() => setCollapsed(false)}
        testId="plan-approval-collapsed"
      />
    );
  }

  return (
    <div className="w-full animate-slideUp" data-testid="plan-approval-card">
      <div
        ref={cardRef}
        tabIndex={-1}
        className="mx-auto w-full max-w-3xl rounded-lg border-2 border-badge-info/60 bg-zinc-900 shadow-md dark:shadow-2xl outline-hidden"
      >
        <div className="flex items-center gap-2 rounded-t-lg border-b border-zinc-800 bg-blue-500/10 px-4 py-2.5">
          <ListChecks className="h-4 w-4 shrink-0 text-badge-info" />
          <span className="text-sm font-medium text-badge-info">{t.planApproval.title}</span>
          <span className="text-xs text-zinc-500">{t.planApproval.stepCount.replace('{count}', String(steps.length))}</span>
        </div>

        <div className="max-h-[50vh] overflow-y-auto px-4 py-3">
          {mode === 'steps' ? (
            <>
              <p className="mb-3 text-sm text-zinc-200">{t.planApproval.question}</p>
              <div className="space-y-2" data-testid="plan-step-list">
                {steps.map((step, index) => (
                  <div
                    key={step.id}
                    ref={(element) => { rowRefs.current[index] = element; }}
                    tabIndex={0}
                    draggable={editingId === null}
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null) setSteps((current) => movePlanStep(current, dragIndex, index));
                      setDragIndex(null);
                    }}
                    onDragEnd={() => setDragIndex(null)}
                    className={`group rounded-lg border p-2.5 transition-all ${
                      editingId === step.id
                        ? 'border-badge-info bg-blue-500/10 ring-1 ring-blue-500/50'
                        : editingId
                          ? 'border-zinc-800 opacity-50'
                          : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                    }`}
                    data-testid={`plan-step-${index}`}
                  >
                    {editingId === step.id ? (
                      <div className="space-y-2">
                        <input
                          autoFocus
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              saveEdit();
                            }
                          }}
                          className="w-full rounded-md border border-zinc-600 bg-zinc-950 px-2.5 py-2 text-sm text-zinc-200 outline-hidden focus:border-badge-info"
                          aria-label={t.planApproval.edit}
                        />
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>{t.planApproval.cancelEdit}</Button>
                          <Button size="sm" onClick={saveEdit} disabled={!draft.trim()}>{t.planApproval.save}</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <span title={t.planApproval.drag} className="mt-0.5 cursor-grab text-zinc-600 group-hover:text-zinc-400">
                          <GripVertical className="h-4 w-4" />
                        </span>
                        <span className="mt-0.5 w-4 shrink-0 text-right font-mono text-xs text-zinc-500">{index + 1}</span>
                        <span className="min-w-0 flex-1 text-sm leading-5 text-zinc-200">{step.content}</span>
                        {step.edited && <span className="shrink-0 text-[10px] text-badge-warning">{t.planApproval.changed}</span>}
                        <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                          <button /* ds-allow:button: 步骤行内超小图标动作，Button primitive 尺寸会撑高整行 */
                            type="button"
                            className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
                            title={t.planApproval.edit}
                            onClick={() => beginEdit(step)}
                          ><Pencil className="h-3.5 w-3.5" /></button>
                          <button /* ds-allow:button: 步骤行内超小图标动作，语义危险色 */
                            type="button"
                            className="rounded p-1 text-zinc-500 hover:bg-red-500/10 hover:text-badge-danger"
                            title={t.planApproval.delete}
                            onClick={() => setSteps((current) => current.filter((item) => item.id !== step.id))}
                          ><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => {
                  const id = `step-added-${Date.now()}`;
                  setSteps((current) => [...current, { id, content: t.planApproval.newStep, originalContent: '', edited: true }]);
                  setEditingId(id);
                  setDraft(t.planApproval.newStep);
                }}
                disabled={editingId !== null}
              >{t.planApproval.addStep}</Button>
            </>
          ) : (
            <div className="space-y-3" data-testid="plan-feedback-editor">
              <p className="text-sm text-zinc-200">{t.planApproval.feedbackTitle}</p>
              <textarea
                autoFocus
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder={t.planApproval.feedbackPlaceholder}
                rows={4}
                className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-hidden focus:border-badge-info"
              />
            </div>
          )}
        </div>

        <div className="px-4 pb-3">
          {steps.length === 0 && mode === 'steps' && <div className="mb-2 text-xs text-badge-danger">{t.planApproval.emptyPlan}</div>}
          {error && <div className="mb-2 text-xs text-badge-danger">{error}</div>}
          <div className="flex items-center justify-between gap-2">
            {mode === 'steps' ? (
              <Button size="sm" variant="ghost" onClick={() => setMode('feedback')} disabled={submitting || editingId !== null}>
                {t.planApproval.feedbackAction}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setMode('steps')} disabled={submitting}>
                {t.planApproval.backToPlan}
              </Button>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => void submit('cancel')} disabled={submitting}>{t.planApproval.cancel}</Button>
              {mode === 'steps' ? (
                <Button
                  ref={primaryButtonRef}
                  size="sm"
                  loading={submitting}
                  onClick={() => void submit('approve', { steps })}
                  disabled={editingId !== null || steps.length === 0}
                  data-testid="plan-approve-button"
                >{t.planApproval.approve}</Button>
              ) : (
                <Button
                  ref={primaryButtonRef}
                  size="sm"
                  loading={submitting}
                  onClick={() => void submit('revise', { feedback })}
                  disabled={!feedback.trim()}
                >{t.planApproval.requestRevision}</Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
