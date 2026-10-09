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
  getPlanApprovalRecord,
  movePlanStep,
  type PendingPlanApprovalTarget,
  updateMessageWithPlanApproval,
} from '../utils/planApprovalView';

type EditorMode = 'steps' | 'feedback';
type ConflictChoice = 'local' | 'latest';
type PlanApprovalConflict = {
  local: PlanApprovalStep;
  latest: PlanApprovalStep;
  choice?: ConflictChoice;
};
type PlanApprovalConflictMap = Record<string, PlanApprovalConflict>;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isStaleVersion(error: unknown): boolean {
  return errorCode(error) === 'STALE_VERSION';
}

function editedStep(step: PlanApprovalStep, content: string): PlanApprovalStep {
  const nextContent = content.trim();
  return {
    ...step,
    content: nextContent,
    ...(nextContent !== step.originalContent ? { edited: true } : { edited: undefined }),
  };
}

function cloneSteps(steps: readonly PlanApprovalStep[]): PlanApprovalStep[] {
  return steps.map((step) => ({ ...step }));
}

function withDerivedEdited(step: PlanApprovalStep, content = step.content): PlanApprovalStep {
  return {
    ...step,
    content,
    ...(content !== step.originalContent ? { edited: true } : { edited: undefined }),
  };
}

function isStepEdited(step: PlanApprovalStep): boolean {
  return step.content !== step.originalContent;
}

function mergeStaleSteps(
  base: readonly PlanApprovalStep[],
  local: readonly PlanApprovalStep[],
  latest: readonly PlanApprovalStep[],
): { steps: PlanApprovalStep[]; conflicts: PlanApprovalConflictMap } {
  const baseById = new Map(base.map((step) => [step.id, step]));
  const latestById = new Map(latest.map((step) => [step.id, step]));
  const localById = new Map(local.map((step) => [step.id, step]));
  const merged: PlanApprovalStep[] = [];
  const conflicts: PlanApprovalConflictMap = {};
  const includedIds = new Set<string>();

  for (const localStep of local) {
    const baseStep = baseById.get(localStep.id);
    const latestStep = latestById.get(localStep.id);
    if (!baseStep) {
      merged.push(withDerivedEdited(localStep));
      includedIds.add(localStep.id);
      continue;
    }
    if (!latestStep) {
      // A latest deletion loses only when the user left this step untouched.
      if (localStep.content !== baseStep.content) {
        merged.push(withDerivedEdited(localStep));
        includedIds.add(localStep.id);
      }
      continue;
    }

    const localChanged = localStep.content !== baseStep.content;
    const latestChanged = latestStep.content !== baseStep.content;
    if (localChanged && latestChanged && latestStep.content !== localStep.content) {
      conflicts[localStep.id] = { local: localStep, latest: latestStep };
      merged.push(withDerivedEdited(latestStep, localStep.content));
    } else if (localChanged) {
      merged.push(withDerivedEdited(latestStep, localStep.content));
    } else {
      merged.push(withDerivedEdited(latestStep));
    }
    includedIds.add(localStep.id);
  }

  for (const latestStep of latest) {
    if (includedIds.has(latestStep.id)) continue;
    // A user deletion is retained even if the model changed that step too.
    if (!localById.has(latestStep.id) && baseById.has(latestStep.id)) continue;
    merged.push(withDerivedEdited(latestStep));
    includedIds.add(latestStep.id);
  }

  return { steps: merged, conflicts };
}

export const PlanApprovalEvidence: React.FC<{ approval: PlanApprovalRecord }> = ({ approval }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const approved = approval.status === 'approved';
  const summary = approved
    ? t.planApproval.approvedSummary.replace('{count}', String(approval.steps.length))
    : approval.status === 'revision_requested'
      ? t.planApproval.revisionSummary
      : approval.status === 'starting'
        ? t.planApproval.startingSummary
        : approval.status === 'failed'
          ? t.planApproval.failedSummary
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
              {isStepEdited(step) && (
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

export const PlanApprovalCard: React.FC<{
  target: PendingPlanApprovalTarget;
  collapsed?: boolean;
  onCollapse?: () => void;
}> = ({ target, collapsed: controlledCollapsed, onCollapse }) => {
  const { t } = useI18n();
  const [steps, setSteps] = useState<PlanApprovalStep[]>(() => cloneSteps(target.approval.steps));
  const [baseSteps, setBaseSteps] = useState<PlanApprovalStep[]>(() => cloneSteps(target.approval.steps));
  const [conflicts, setConflicts] = useState<PlanApprovalConflictMap>({});
  const [version, setVersion] = useState(() => target.approval.version ?? 1);
  const [mode, setMode] = useState<EditorMode>('steps');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [feedback, setFeedback] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const isCollapseControlled = controlledCollapsed !== undefined;
  const stepsRef = useRef(steps);
  const baseStepsRef = useRef(baseSteps);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  const updateSteps = useCallback((next: React.SetStateAction<PlanApprovalStep[]>) => {
    const resolved = typeof next === 'function' ? next(stepsRef.current) : next;
    stepsRef.current = resolved;
    setSteps(resolved);
  }, []);

  const updateBaseSteps = useCallback((next: PlanApprovalStep[]) => {
    baseStepsRef.current = next;
    setBaseSteps(next);
  }, []);

  useEffect(() => {
    setInternalCollapsed(false);
  }, [target.toolCallId]);

  useEffect(() => {
    setVersion(target.approval.version ?? 1);
    const initialSteps = cloneSteps(target.approval.steps);
    updateBaseSteps(initialSteps);
    updateSteps(initialSteps);
    setConflicts({});
    setEditingId(null);
    setDraft('');
  }, [target.messageId, target.toolCallId, updateBaseSteps, updateSteps]);

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

  const resyncFromLatestUpdate = useCallback(() => {
    const message = useSessionStore.getState().messages.find((candidate) => candidate.id === target.messageId);
    const toolCall = message?.toolCalls?.find((candidate) => candidate.id === target.toolCallId);
    const latest = getPlanApprovalRecord(toolCall);
    if (!latest) return;
    const merged = mergeStaleSteps(baseStepsRef.current, stepsRef.current, latest.steps);
    setVersion(latest.version ?? 1);
    updateBaseSteps(cloneSteps(latest.steps));
    updateSteps(merged.steps);
    setConflicts(merged.conflicts);
    setEditingId(null);
    setDraft('');
  }, [target.messageId, target.toolCallId, updateBaseSteps, updateSteps]);

  const unresolvedConflict = Object.values(conflicts).some((conflict) => !conflict.choice);

  const chooseConflict = useCallback((stepId: string, choice: ConflictChoice) => {
    const conflict = conflicts[stepId];
    if (!conflict) return;
    const selected = choice === 'latest' ? conflict.latest : conflict.local;
    const originalContent = conflict.latest.originalContent;
    updateSteps((current) => current.map((step) => (
      step.id === stepId ? withDerivedEdited({ ...selected, originalContent }, selected.content) : step
    )));
    setConflicts((current) => ({ ...current, [stepId]: { ...current[stepId], choice } }));
  }, [conflicts, updateSteps]);

  const submit = useCallback(async (
    decision: PlanApprovalRequest['decision'],
    payload?: Pick<PlanApprovalRequest, 'steps' | 'feedback'>,
    options?: { keepInteractive?: boolean },
  ) => {
    if (!options?.keepInteractive && submitting) return;
    // 冲突未选完时，任何带 steps 的 submit（approve/edit）都会把未选的冲突步骤以本地内容
    // 悄悄写穿写边界；只有不带 steps 的 cancel/revise 可以放行。
    if (unresolvedConflict && decision !== 'cancel' && decision !== 'revise') return;
    if (!options?.keepInteractive) setSubmitting(true);
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
          version,
          ...payload,
        } satisfies PlanApprovalRequest,
      );
      applyResponse(response);
      const syncedSteps = cloneSteps(response.approval.steps);
      updateBaseSteps(syncedSteps);
      updateSteps(syncedSteps);
      setConflicts({});
      if (typeof response.approval.version === 'number') setVersion(response.approval.version);
    } catch (submitError) {
      // 失败态只说 UI 语言且带下一步；宿主英文 message 不进卡片，未知码回落通用文案 + 小字附码。
      if (isStaleVersion(submitError)) {
        setError({ message: t.planApproval.staleVersion });
        resyncFromLatestUpdate();
      } else {
        setError({ message: t.planApproval.submitFailed, code: errorCode(submitError) });
      }
      if (!options?.keepInteractive) setSubmitting(false);
    }
  }, [applyResponse, resyncFromLatestUpdate, submitting, t.planApproval.staleVersion, t.planApproval.submitFailed, target, unresolvedConflict, updateBaseSteps, updateSteps, version]);

  const beginEdit = (step: PlanApprovalStep) => {
    setEditingId(step.id);
    setDraft(step.content);
    setError(null);
  };

  const saveEdit = () => {
    const content = draft.trim();
    if (!editingId || !content) return;
    const nextSteps = steps.map((step) => (step.id === editingId ? editedStep(step, content) : step));
    const changed = nextSteps.some((step, index) => step.content !== steps[index]?.content);
    updateSteps(nextSteps);
    setEditingId(null);
    setDraft('');
    if (unresolvedConflict) {
      // 冲突未选完：编辑只在本地保留（随批准一并提交），不带 steps 走写边界，
      // 并把冲突提示顶回来，让保存被拦这件事可见而非静默 no-op。
      setError({ message: t.planApproval.staleVersion });
      return;
    }
    if (changed) void submit('edit', { steps: nextSteps }, { keepInteractive: true });
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
          if (onCollapse) onCollapse();
          else setInternalCollapsed(true);
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
  }, [collapsed, editingId, mode, onCollapse, steps, submitting]);

  if (collapsed) {
    if (isCollapseControlled) return null;
    return (
      <DecisionCollapsedBar
        label={t.decisionCard.pendingLabel}
        expandLabel={t.decisionCard.expand}
        count={1}
        onExpand={() => setInternalCollapsed(false)}
        testId="plan-approval-collapsed"
      />
    );
  }

  return (
    <div className="w-full animate-slideUp" data-testid="plan-approval-card" data-view-mode="expanded">
      <div
        ref={cardRef}
        tabIndex={-1}
        className="mx-auto w-full max-w-3xl rounded-lg border-2 border-badge-info/60 bg-zinc-900 shadow-md dark:shadow-2xl outline-hidden"
      >
        <div className="flex items-center gap-2 rounded-t-lg border-b border-zinc-800 bg-blue-500/10 px-4 py-2.5">
          <ListChecks className="h-4 w-4 shrink-0 text-badge-info" />
          <span className="text-sm font-medium text-badge-info">{t.planApproval.title}</span>
          <span className="text-xs text-zinc-500">{t.planApproval.stepCount.replace('{count}', String(steps.length))}</span>
          {version > 1 && (
            <span className="text-xs text-zinc-500" data-testid="plan-approval-version">
              {t.planApproval.version.replace('{version}', String(version))}
            </span>
          )}
        </div>
        {target.approval.source === 'synthetic_text' && (
          <p className="border-b border-zinc-800 px-4 py-1.5 text-xs text-zinc-500" data-testid="plan-approval-source">
            {t.planApproval.syntheticSource}
          </p>
        )}

        <div className="max-h-[50vh] overflow-y-auto px-4 py-3">
          {target.approval.status === 'failed' && (
            <div
              className="mb-3 rounded-md border border-badge-danger/40 bg-red-500/10 px-3 py-2 text-xs leading-5 text-badge-danger"
              data-testid="plan-approval-failure"
            >
              <span className="font-medium">{t.planApproval.startFailed}</span>
              {target.approval.failureReason && <span className="ml-1 break-all">{target.approval.failureReason}</span>}
            </div>
          )}
          {mode === 'steps' ? (
            <>
              <p className="mb-3 text-sm text-zinc-200">{t.planApproval.question}</p>
              <div className="space-y-2" data-testid="plan-step-list">
                {steps.map((step, index) => {
                  const conflict = conflicts[step.id];
                  return (
                  <div
                    key={step.id}
                    ref={(element) => { rowRefs.current[index] = element; }}
                    tabIndex={0}
                    draggable={editingId === null && !conflict}
                    onDragStart={() => { if (!conflict) setDragIndex(index); }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null) updateSteps((current) => movePlanStep(current, dragIndex, index));
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
                    {conflict ? (
                      <div className="space-y-2" data-testid={`plan-step-conflict-${step.id}`}>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="flex cursor-pointer gap-2 rounded-md border border-zinc-700 bg-zinc-950/60 p-2 text-sm text-zinc-200">
                            <input
                              type="radio"
                              name={`plan-conflict-${step.id}`}
                              checked={conflict.choice === 'local'}
                              onChange={() => chooseConflict(step.id, 'local')}
                              data-testid={`plan-conflict-local-${step.id}`}
                            />
                            <span className="min-w-0">
                              <span className="mb-1 block text-xs font-medium text-badge-info">{t.planApproval.yourEdit}</span>
                              <span className="block leading-5">{conflict.local.content}</span>
                            </span>
                          </label>
                          <label className="flex cursor-pointer gap-2 rounded-md border border-zinc-700 bg-zinc-950/60 p-2 text-sm text-zinc-200">
                            <input
                              type="radio"
                              name={`plan-conflict-${step.id}`}
                              checked={conflict.choice === 'latest'}
                              onChange={() => chooseConflict(step.id, 'latest')}
                              data-testid={`plan-conflict-latest-${step.id}`}
                            />
                            <span className="min-w-0">
                              <span className="mb-1 block text-xs font-medium text-badge-warning">{t.planApproval.latestVersion}</span>
                              <span className="block leading-5">{conflict.latest.content}</span>
                            </span>
                          </label>
                        </div>
                      </div>
                    ) : editingId === step.id ? (
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
                        {isStepEdited(step) && <span className="shrink-0 text-[10px] text-badge-warning">{t.planApproval.changed}</span>}
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
                            onClick={() => updateSteps((current) => current.filter((item) => item.id !== step.id))}
                          ><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => {
                  const id = `step-added-${Date.now()}`;
                  updateSteps((current) => [...current, { id, content: t.planApproval.newStep, originalContent: '', edited: true }]);
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
          {error && (
            <div className="mb-2 text-xs text-badge-danger" data-testid="plan-approval-error">
              {error.message}
              {error.code && <span className="ml-1 text-[10px] text-zinc-500">{error.code}</span>}
            </div>
          )}
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
                  disabled={editingId !== null || steps.length === 0 || unresolvedConflict}
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
