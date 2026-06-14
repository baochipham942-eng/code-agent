import type { Task, TaskOutputRef } from '@shared/contract/backgroundTask';
import type { ScriptRunSnapshot } from '@shared/contract/scriptRun';

export type SessionReplayEvidenceType = 'replay' | 'trace';
export type SessionReplayEvidenceActionKind = 'sessionReplay' | 'file' | 'url' | 'copy';

export interface SessionReplayEvidence {
  id: string;
  sessionId: string;
  type: SessionReplayEvidenceType;
  label: string;
  title: string;
  sourceLabel: string;
  actionKind: SessionReplayEvidenceActionKind;
  pathOrUrl?: string;
}

const MAX_EVIDENCE_PER_SESSION = 4;
const MAX_LABEL_LENGTH = 28;

function truncateLabel(value: string, maxLength = MAX_LABEL_LENGTH): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function lastPathSegment(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function evidenceTypeLabel(type: SessionReplayEvidenceType): string {
  return type === 'trace' ? 'Trace' : 'Replay';
}

function normalizePathOrUrl(ref: TaskOutputRef): { pathOrUrl?: string; actionKind: SessionReplayEvidenceActionKind } {
  if (ref.path) {
    return { pathOrUrl: ref.path, actionKind: 'file' };
  }
  if (!ref.uri) {
    return { actionKind: 'sessionReplay' };
  }

  const uri = ref.uri.trim();
  if (/^https?:\/\//i.test(uri)) {
    return { pathOrUrl: uri, actionKind: 'url' };
  }
  if (/^file:\/\//i.test(uri)) {
    return { pathOrUrl: uri.replace(/^file:\/\//i, ''), actionKind: 'file' };
  }
  return { pathOrUrl: uri, actionKind: 'copy' };
}

function workflowStatusLabel(status: ScriptRunSnapshot['status']): string {
  switch (status) {
    case 'running':
      return '执行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return '待开始';
  }
}

function pushEvidence(
  map: Map<string, SessionReplayEvidence[]>,
  evidence: SessionReplayEvidence,
): void {
  const list = map.get(evidence.sessionId) ?? [];
  if (list.some((item) => item.id === evidence.id)) {
    return;
  }
  if (list.length >= MAX_EVIDENCE_PER_SESSION) {
    return;
  }
  list.push(evidence);
  map.set(evidence.sessionId, list);
}

function buildWorkflowReplayEvidence(snapshot: ScriptRunSnapshot): SessionReplayEvidence | null {
  if (!snapshot.sessionId) {
    return null;
  }

  const goal = snapshot.goal?.trim();
  const status = workflowStatusLabel(snapshot.status);
  return {
    id: `workflow:${snapshot.runId}:replay`,
    sessionId: snapshot.sessionId,
    type: 'replay',
    label: 'Workflow replay',
    sourceLabel: 'Workflow',
    actionKind: 'sessionReplay',
    title: goal
      ? `Workflow replay · ${status} · ${goal}`
      : `Workflow replay · ${status} · ${snapshot.runId}`,
  };
}

function buildTaskOutputEvidence(
  task: Task,
  ref: TaskOutputRef,
): SessionReplayEvidence | null {
  if (!task.sessionId || (ref.type !== 'replay' && ref.type !== 'trace')) {
    return null;
  }

  const { pathOrUrl, actionKind } = normalizePathOrUrl(ref);
  const fallbackLabel = lastPathSegment(pathOrUrl) || evidenceTypeLabel(ref.type);
  const label = truncateLabel(ref.label || fallbackLabel);
  const typeLabel = evidenceTypeLabel(ref.type);
  const sourceLabel = truncateLabel(task.title || 'Background task');
  const pathSuffix = pathOrUrl ? ` · ${pathOrUrl}` : '';

  return {
    id: `background:${task.id}:${ref.id}`,
    sessionId: task.sessionId,
    type: ref.type,
    label,
    sourceLabel,
    actionKind,
    pathOrUrl,
    title: `${typeLabel} · ${label} · ${task.title || task.id}${pathSuffix}`,
  };
}

export function buildSessionReplayEvidenceMap(
  workflowRuns: Record<string, ScriptRunSnapshot>,
  tasks: Task[],
): Map<string, SessionReplayEvidence[]> {
  const map = new Map<string, SessionReplayEvidence[]>();

  for (const snapshot of Object.values(workflowRuns)) {
    const evidence = buildWorkflowReplayEvidence(snapshot);
    if (evidence) {
      pushEvidence(map, evidence);
    }
  }

  for (const task of tasks) {
    for (const ref of task.outputRefs) {
      const evidence = buildTaskOutputEvidence(task, ref);
      if (evidence) {
        pushEvidence(map, evidence);
      }
    }
  }

  return map;
}
