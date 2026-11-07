import type { Translations } from '../i18n';

type SessionTaskOutcome = 'accepted' | 'queued' | 'reused' | 'status';
type SessionTaskStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

interface SessionTaskItem {
  shortName: string;
  status: SessionTaskStatus;
  detail?: string;
}

const OUTCOMES = new Set<SessionTaskOutcome>(['accepted', 'queued', 'reused', 'status']);
const STATUSES = new Set<SessionTaskStatus>(['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled']);

function readSessionTask(metadata: Record<string, unknown> | undefined): {
  outcome: SessionTaskOutcome;
  tasks: SessionTaskItem[];
} | null {
  const value = metadata?.sessionTask;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { outcome?: unknown; tasks?: unknown };
  if (typeof candidate.outcome !== 'string' || !OUTCOMES.has(candidate.outcome as SessionTaskOutcome)) return null;
  if (!Array.isArray(candidate.tasks) || candidate.tasks.length === 0) return null;

  const tasks: SessionTaskItem[] = [];
  for (const item of candidate.tasks) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const task = item as { shortName?: unknown; status?: unknown; detail?: unknown };
    if (
      typeof task.shortName !== 'string'
      || !task.shortName.trim()
      || typeof task.status !== 'string'
      || !STATUSES.has(task.status as SessionTaskStatus)
      || (task.detail !== undefined && typeof task.detail !== 'string')
    ) return null;
    tasks.push({
      shortName: task.shortName,
      status: task.status as SessionTaskStatus,
      ...(task.detail ? { detail: task.detail } : {}),
    });
  }
  return { outcome: candidate.outcome as SessionTaskOutcome, tasks };
}

function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, value),
    template,
  );
}

export function formatSessionTaskOutput(
  metadata: Record<string, unknown> | undefined,
  rawOutput: string,
  t: Translations,
): string {
  const sessionTask = readSessionTask(metadata);
  if (!sessionTask) return rawOutput;
  const copy = t.sessionTaskPresentation;
  const first = sessionTask.tasks[0];
  const status = (task: SessionTaskItem): string => copy.status[task.status];

  if (sessionTask.outcome === 'accepted' || sessionTask.outcome === 'queued') {
    return fill(copy[sessionTask.outcome], { name: first.shortName });
  }
  if (sessionTask.outcome === 'reused') {
    return fill(copy.reused, { name: first.shortName, status: status(first) });
  }
  return sessionTask.tasks.map((task) => fill(copy.statusLine, {
    name: task.shortName,
    status: status(task),
    detail: task.detail ? fill(copy.detail, { detail: task.detail }) : '',
  })).join('\n');
}
