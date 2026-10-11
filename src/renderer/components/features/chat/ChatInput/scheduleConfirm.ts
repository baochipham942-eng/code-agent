import type { CreateCronJobInput } from '../../../../services/cronClient';
import { formatCronScheduleLabel } from '../automationNotice';
import type { PendingScheduleDraft } from './useScheduleDraft';

interface ScheduleConfirmLabels {
  what: string;
  when: string;
  notifyWhen: string;
  result: string;
  fallbackWhat: string;
  fallbackNotifyWhen: string;
  reviewInbox: string;
}

interface ScheduleConfirmRow {
  key: 'what' | 'when' | 'notifyWhen' | 'result';
  label: string;
  value: string;
}

function getActionDescription(input: CreateCronJobInput): string {
  const action = input.action;
  if (action.type === 'agent') return action.prompt.trim();
  if (action.type === 'shell') return action.command.trim();
  if (action.type === 'webhook') return `${action.method} ${action.url}`.trim();
  return '';
}

export function buildScheduleConfirmRows(
  draft: Pick<PendingScheduleDraft, 'input' | 'restatement'>,
  labels: ScheduleConfirmLabels,
): readonly ScheduleConfirmRow[] {
  const what = draft.restatement?.what.trim()
    || draft.input.name?.trim()
    || getActionDescription(draft.input)
    || draft.input.description?.trim()
    || labels.fallbackWhat;
  const notifyWhen = draft.restatement?.notifyWhen.trim() || labels.fallbackNotifyWhen;
  const result = draft.input.resultChannel?.trim() || labels.reviewInbox;

  return [
    { key: 'what', label: labels.what, value: what },
    { key: 'when', label: labels.when, value: formatCronScheduleLabel(draft.input.schedule) },
    { key: 'notifyWhen', label: labels.notifyWhen, value: notifyWhen },
    { key: 'result', label: labels.result, value: result },
  ];
}
