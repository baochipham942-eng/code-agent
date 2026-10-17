import React, { useMemo, useRef, useState } from 'react';
import { Check, Clock3, Pencil, X } from 'lucide-react';
import { Button } from '../../../primitives/Button';
import { Input } from '../../../primitives/Input';
import { Select } from '../../../primitives/Select';
import { useI18n } from '../../../../hooks/useI18n';
import { CRON_URGENCY_CRITERIA } from '@shared/constants';
import { validateEventScheduleConstraints } from '@shared/cronEventValidation';
import {
  compileSimpleSchedule,
  type SimpleFrequency,
} from '../../cron/CronSimpleCreate';
import { CronEventScheduleFields } from '../../cron/CronEventScheduleFields';
import type { CreateCronJobInput } from '../../../../services/cronClient';
import type { PendingScheduleDraft } from './useScheduleDraft';
import { buildScheduleConfirmRows } from './scheduleConfirm';

interface ScheduleConfirmCardProps {
  draft: PendingScheduleDraft;
  confirming: boolean;
  onConfirm: () => void | Promise<unknown>;
  onDismiss: () => void;
  /** 卡内编辑（时间/通知判据）写回待确认草案；缺省时卡片只读（与旧行为一致）。 */
  onDraftChange?: (next: PendingScheduleDraft) => void;
}

/** 时间编辑器的频率档：五档人话频率 + keep（复杂表达式保持原样，直到用户选频率）。 */
type EditableFrequency = SimpleFrequency | 'keep';

interface WhenEditState {
  freq: EditableFrequency;
  time: string;
  weekday: string;
  intervalHours: string;
  onceAt: string;
}

/** epoch/ISO → datetime-local 输入值（yyyy-MM-ddTHH:mm，本地时区）。解析不了给空串。 */
function toLocalDateTimeValue(datetime: string | number): string {
  const date = typeof datetime === 'number' ? new Date(datetime) : new Date(datetime);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function isClockPair(hour: unknown, minute: unknown): boolean {
  return /^\d{1,2}$/.test(String(hour)) && /^\d{1,2}$/.test(String(minute))
    && Number(hour) <= 23 && Number(minute) <= 59;
}

/** 当前 schedule → 编辑器初值：认识的人话形态（每天/工作日/每周/每小时/一次）回填，复杂表达式 keep。 */
function initialWhenEditState(schedule: CreateCronJobInput['schedule']): WhenEditState {
  const base: WhenEditState = { freq: 'keep', time: '09:00', weekday: '1', intervalHours: '1', onceAt: '' };
  if (schedule.type === 'every' && schedule.unit === 'hours' && schedule.interval >= 1) {
    return { ...base, freq: 'hourly', intervalHours: String(schedule.interval) };
  }
  if (schedule.type === 'at') {
    return { ...base, freq: 'once', onceAt: toLocalDateTimeValue(schedule.datetime) };
  }
  if (schedule.type === 'cron') {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.expression.trim().split(/\s+/);
    if (dayOfMonth === '*' && month === '*' && isClockPair(hour, minute)) {
      const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      if (dayOfWeek === '*') return { ...base, freq: 'daily', time };
      if (dayOfWeek === '1-5') return { ...base, freq: 'weekdays', time };
      if (/^[0-6]$/.test(dayOfWeek)) return { ...base, freq: 'weekly', time, weekday: dayOfWeek };
    }
  }
  return base;
}

/** 编辑器值 → 契约 schedule（compileSimpleSchedule 的确定性编译）；keep/输入不完整 → null（不落）。 */
function compileWhenEditState(edit: WhenEditState): CreateCronJobInput['schedule'] | null {
  if (edit.freq === 'keep') return null;
  if (edit.freq !== 'hourly' && edit.freq !== 'once' && !/^\d{1,2}:\d{2}$/.test(edit.time)) return null;
  const compiled = compileSimpleSchedule({
    freq: edit.freq,
    time: edit.time,
    weekday: edit.weekday,
    intervalHours: edit.intervalHours,
    onceAt: edit.onceAt,
  });
  if (compiled.scheduleType === 'cron' && compiled.cronExpression) {
    return { type: 'cron', expression: compiled.cronExpression };
  }
  if (compiled.scheduleType === 'every' && compiled.everyUnit
    && compiled.everyInterval && Number.isFinite(Number(compiled.everyInterval)) && Number(compiled.everyInterval) >= 1) {
    return { type: 'every', interval: Number(compiled.everyInterval), unit: compiled.everyUnit };
  }
  if (compiled.scheduleType === 'at' && compiled.atDatetime) {
    return { type: 'at', datetime: compiled.atDatetime };
  }
  return null;
}

export const ScheduleConfirmCard: React.FC<ScheduleConfirmCardProps> = ({
  draft,
  confirming,
  onConfirm,
  onDismiss,
  onDraftChange,
}) => {
  const { t, language } = useI18n();
  const labels = t.scheduleConfirm;
  const cc = t.cronCenter;
  const rows = useMemo(
    () => buildScheduleConfirmRows(draft, labels, language, {
      group: cc.eventConfirmGroup,
      groupFallback: cc.eventConfirmGroupFallback,
      groupAnyChat: cc.eventConfirmGroupAnyChat,
      budget: cc.eventBudgetLabel,
    }),
    [draft, labels, language, cc],
  );

  // event 草案（N-CRON-EVENT-CREATE-CHAT）：没有「什么时候」行/时间编辑器，
  // 换成 CronEventScheduleFields（账号/群选择 + 预算输入）；确认按钮挂共享校验器。
  // normalize 只放行 channel 源，这里按 source 收窄拿 chatId 字段。
  const eventSchedule = draft.input.schedule.type === 'event' && draft.input.schedule.source === 'channel'
    ? draft.input.schedule
    : null;
  const eventViolation = useMemo(() => {
    if (!eventSchedule) return null;
    return validateEventScheduleConstraints({
      schedule: eventSchedule,
      runsOn: draft.input.runsOn,
      action: draft.input.action,
      maxRunBudget: draft.input.maxRunBudget,
    });
  }, [eventSchedule, draft.input.runsOn, draft.input.action, draft.input.maxRunBudget]);

  // event 编辑态放本地（含 ref：同一次账号切换会连续触发 onAccountChange + onChatChange
  // 两次写回，第二次的 draft 闭包是旧的，只有 ref 合并才不丢账号补丁），每次变更整体写回草案。
  const [eventEdit, setEventEdit] = useState(() => ({
    accountId: eventSchedule?.accountId ?? '',
    chatId: eventSchedule?.chatId ?? '',
  }));
  const eventEditRef = useRef(eventEdit);
  const [budgetEdit, setBudgetEdit] = useState(() => String(draft.input.maxRunBudget ?? ''));

  const writeEventEdit = (patch: { accountId?: string; chatId?: string }) => {
    if (!eventSchedule || !onDraftChange) return;
    const next = { ...eventEditRef.current, ...patch };
    eventEditRef.current = next;
    setEventEdit(next);
    // chatId 空串 = 任意会话：写回时不落键，别把 '' 送进 createJob（空串会绑死一个
    // 不存在的会话，任务静默永不触发）。
    const { chatId, ...scheduleWithoutChat } = { ...eventSchedule, ...next };
    const schedule = chatId ? { ...scheduleWithoutChat, chatId } : scheduleWithoutChat;
    onDraftChange({ ...draft, input: { ...draft.input, schedule } as CreateCronJobInput });
  };

  const handleEventBudgetChange = (value: string) => {
    if (!eventSchedule || !onDraftChange) return;
    setBudgetEdit(value);
    const parsed = Number(value);
    onDraftChange({
      ...draft,
      input: {
        ...draft.input,
        maxRunBudget: value.trim() !== '' && Number.isFinite(parsed) ? parsed : null,
      },
    });
  };

  const [editingWhen, setEditingWhen] = useState(false);
  const [whenEdit, setWhenEdit] = useState<WhenEditState>(() => initialWhenEditState(draft.input.schedule));
  const [editingNotify, setEditingNotify] = useState(false);
  const [notifyEdit, setNotifyEdit] = useState(() => draft.restatement?.notifyWhen ?? '');

  const compiledWhen = useMemo(() => compileWhenEditState(whenEdit), [whenEdit]);
  const freqOptions = useMemo(() => [
    { value: 'keep', label: labels.whenKeep },
    { value: 'daily', label: labels.freqDaily },
    { value: 'weekdays', label: labels.freqWeekdays },
    { value: 'weekly', label: labels.freqWeekly },
    { value: 'hourly', label: labels.freqHourly },
    { value: 'once', label: labels.freqOnce },
  ], [labels]);
  const weekdayOptions = useMemo(
    () => labels.weekdays.map((name, index) => ({ value: String(index), label: name })),
    [labels],
  );

  const startWhenEdit = () => {
    setWhenEdit(initialWhenEditState(draft.input.schedule));
    setEditingWhen(true);
  };

  const applyWhenEdit = () => {
    if (!compiledWhen || !onDraftChange) return;
    onDraftChange({
      ...draft,
      input: { ...draft.input, schedule: compiledWhen, scheduleType: compiledWhen.type },
    });
    setEditingWhen(false);
  };

  const startNotifyEdit = () => {
    setNotifyEdit(draft.restatement?.notifyWhen ?? '');
    setEditingNotify(true);
  };

  const applyNotifyEdit = () => {
    if (!onDraftChange) return;
    // what 行的当前展示值（含兜底文案）作为 restatement.what——草案本来没有 restatement
    // 时也保得住 what 行不跳变；notifyWhen 空串 = 每次都通知（confirm 侧不写字段）。
    const what = rows.find((row) => row.key === 'what')?.value ?? '';
    onDraftChange({ ...draft, restatement: { what, notifyWhen: notifyEdit } });
    setEditingNotify(false);
  };

  const renderRowValue = (key: 'what' | 'when' | 'notifyWhen' | 'result' | 'group' | 'budget') => {
    const row = rows.find((candidate) => candidate.key === key);
    const value = row?.value ?? '';
    return (
      <>
        <span className="flex-1 min-w-0 text-[11px] leading-relaxed text-zinc-200">{value}</span>
        {(key === 'when' || key === 'notifyWhen') && onDraftChange && !confirming && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            data-schedule-edit={key}
            onClick={key === 'when' ? startWhenEdit : startNotifyEdit}
            aria-label={`${labels.edit} ${row?.label ?? ''}`}
            leftIcon={<Pencil className="h-3 w-3" />}
          />
        )}
      </>
    );
  };

  return (
    <div
      data-schedule-confirm
      className="mb-2 px-3 py-3 bg-indigo-500/10 border border-badge-accent/20 rounded-lg animate-fadeIn"
    >
      <div className="flex items-start gap-2">
        <Clock3 className="w-4 h-4 text-badge-accent shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-badge-accent">{labels.title}</div>
          <div className="mt-0.5 text-[11px] text-badge-accent/60 leading-relaxed">{labels.description}</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          disabled={confirming}
          title={labels.cancel}
          aria-label={labels.cancel}
          leftIcon={<X className="h-3.5 w-3.5" />}
        />
      </div>

      <div className="mt-2.5 space-y-1.5">
        {rows.map((row) => (
          <div
            key={row.key}
            className="grid grid-cols-[auto_1fr] gap-3 rounded-md bg-indigo-500/5 px-2.5 py-1.5"
            data-schedule-row={row.key}
          >
            <span className="text-[10px] text-badge-accent/55">{row.label}</span>
            <div className="flex min-w-0 items-center gap-1.5">
              {renderRowValue(row.key)}
            </div>
          </div>
        ))}

        {eventSchedule && (
          <div data-schedule-event-fields className="rounded-md bg-indigo-500/5 px-2.5 py-2">
            <CronEventScheduleFields
              accountId={eventEdit.accountId}
              chatId={eventEdit.chatId}
              onAccountChange={(accountId) => writeEventEdit({ accountId, chatId: '' })}
              onChatChange={(chatId) => writeEventEdit({ chatId })}
              maxRunBudget={budgetEdit}
              onBudgetChange={handleEventBudgetChange}
              validationMessage={eventViolation ? cc.eventValidation[eventViolation.reason] : null}
              preferredChatName={draft.eventGroupName}
            />
          </div>
        )}

        {editingWhen && (
          <div
            data-schedule-when-editor
            className="flex flex-wrap items-center gap-1.5 rounded-md bg-indigo-500/5 px-2.5 py-1.5"
          >
            <Select
              selectSize="sm"
              fullWidth={false}
              className="!w-auto"
              aria-label={labels.when}
              value={whenEdit.freq}
              options={freqOptions}
              onChange={(event) => setWhenEdit({ ...whenEdit, freq: event.target.value as EditableFrequency })}
            />
            {(whenEdit.freq === 'daily' || whenEdit.freq === 'weekdays' || whenEdit.freq === 'weekly') && (
              <Input
                type="time"
                inputSize="sm"
                fullWidth={false}
                className="!w-auto"
                aria-label={labels.timeLabel}
                value={whenEdit.time}
                onChange={(event) => setWhenEdit({ ...whenEdit, time: event.target.value })}
              />
            )}
            {whenEdit.freq === 'weekly' && (
              <Select
                selectSize="sm"
                fullWidth={false}
                className="!w-auto"
                aria-label={labels.weekdayLabel}
                value={whenEdit.weekday}
                options={weekdayOptions}
                onChange={(event) => setWhenEdit({ ...whenEdit, weekday: event.target.value })}
              />
            )}
            {whenEdit.freq === 'hourly' && (
              <Input
                type="number"
                inputSize="sm"
                fullWidth={false}
                className="!w-20"
                aria-label={labels.intervalHoursLabel}
                min={1}
                value={whenEdit.intervalHours}
                onChange={(event) => setWhenEdit({ ...whenEdit, intervalHours: event.target.value })}
              />
            )}
            {whenEdit.freq === 'once' && (
              <Input
                type="datetime-local"
                inputSize="sm"
                fullWidth={false}
                className="!w-auto"
                aria-label={labels.onceAtLabel}
                value={whenEdit.onceAt}
                onChange={(event) => setWhenEdit({ ...whenEdit, onceAt: event.target.value })}
              />
            )}
            <Button type="button" size="sm" data-schedule-when-apply disabled={!compiledWhen} onClick={applyWhenEdit}>
              {labels.saveEdit}
            </Button>
            <Button type="button" variant="ghost" size="sm" data-schedule-when-cancel onClick={() => setEditingWhen(false)}>
              {labels.cancelEdit}
            </Button>
          </div>
        )}

        {editingNotify && (
          <div
            data-schedule-notify-editor
            className="flex flex-col gap-1.5 rounded-md bg-indigo-500/5 px-2.5 py-1.5"
          >
            <Input
              inputSize="sm"
              data-schedule-notify-input
              aria-label={labels.notifyWhen}
              placeholder={labels.notifyEditPlaceholder}
              maxLength={CRON_URGENCY_CRITERIA.MAX_CHARS}
              value={notifyEdit}
              onChange={(event) => setNotifyEdit(event.target.value)}
            />
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" data-schedule-notify-cancel onClick={() => setEditingNotify(false)}>
                {labels.cancelEdit}
              </Button>
              <Button type="button" size="sm" data-schedule-notify-apply onClick={applyNotifyEdit}>
                {labels.saveEdit}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-2.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-schedule-confirm-cancel
          onClick={onDismiss}
          disabled={confirming}
        >
          {labels.cancel}
        </Button>
        <Button
          type="button"
          data-schedule-confirm-submit
          size="sm"
          onClick={() => void onConfirm()}
          loading={confirming}
          disabled={Boolean(eventViolation)}
          leftIcon={<Check className="h-3 w-3" />}
        >
          {labels.confirm}
        </Button>
      </div>
    </div>
  );
};
