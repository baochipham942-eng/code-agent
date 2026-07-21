// ============================================================================
// CronSimpleCreate —— 「添加自动化」默认创建流（三件套 A3）。
// 目标（自然语言）+ 人话频率 + 原生时间控件，前端确定性编译成 cron/every/at，
// 不走 LLM；聊天侧 /schedule 的 LLM 解析入口保持不变。
// ============================================================================

import React, { useState } from 'react';
import { Button } from '../../primitives/Button';
import { FormField } from '../../composites/FormField';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';
import { Textarea } from '../../primitives/Textarea';
import { useCronStore } from '../../../stores/cronStore';
import { useI18n } from '../../../hooks/useI18n';
import { buildCronJobInput, createDefaultCronJobDraft, type CronJobDraft } from './types';

type SimpleFrequency = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'once';

export interface SimpleScheduleInput {
  freq: SimpleFrequency;
  /** HH:MM（daily/weekdays/weekly） */
  time: string;
  /** cron day-of-week 0-6，0=周日（weekly） */
  weekday: string;
  /** 间隔小时数（hourly） */
  intervalHours: string;
  /** datetime-local 值（once） */
  onceAt: string;
}

/** 人话频率 → CronJobDraft 调度字段。纯函数，确定性编译。 */
export function compileSimpleSchedule(input: SimpleScheduleInput): Partial<CronJobDraft> {
  const [hourStr = '9', minuteStr = '0'] = input.time.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  switch (input.freq) {
    case 'daily':
      return { scheduleType: 'cron', cronExpression: `${minute} ${hour} * * *` };
    case 'weekdays':
      return { scheduleType: 'cron', cronExpression: `${minute} ${hour} * * 1-5` };
    case 'weekly':
      return { scheduleType: 'cron', cronExpression: `${minute} ${hour} * * ${input.weekday}` };
    case 'hourly':
      return { scheduleType: 'every', everyInterval: input.intervalHours, everyUnit: 'hours' };
    case 'once':
      return { scheduleType: 'at', atDatetime: input.onceAt };
  }
}

/** 目标 + 名称 + 调度 → 完整 draft（agent action，agentType 与 LLM 生成路径同款 "default"） */
export function buildSimpleDraft(
  goal: string,
  name: string,
  schedule: Partial<CronJobDraft>
): CronJobDraft {
  return {
    ...createDefaultCronJobDraft(),
    name: name.trim() || goal.trim().slice(0, 20),
    actionType: 'agent',
    agentType: 'default',
    agentPrompt: goal.trim(),
    ...schedule,
  };
}

interface CronSimpleCreateProps {
  onDone: () => void;
}

export const CronSimpleCreate: React.FC<CronSimpleCreateProps> = ({ onDone }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const createJob = useCronStore((state) => state.createJob);
  const [goal, setGoal] = useState('');
  const [name, setName] = useState('');
  const [freq, setFreq] = useState<SimpleFrequency>('daily');
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState('1');
  const [intervalHours, setIntervalHours] = useState('1');
  const [onceAt, setOnceAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!goal.trim()) {
      setError(cc.simpleGoalRequired);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const draft = buildSimpleDraft(goal, name, compileSimpleSchedule({ freq, time, weekday, intervalHours, onceAt }));
      await createJob(buildCronJobInput(draft));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : cc.simpleCreateFailed);
    } finally {
      setSubmitting(false);
    }
  };

  const needTime = freq === 'daily' || freq === 'weekdays' || freq === 'weekly';

  return (
    <div className="space-y-4" data-testid="cron-simple-create">
      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <FormField label={cc.simpleGoalLabel} required>
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={cc.simpleGoalPlaceholder}
          minRows={3}
        />
      </FormField>

      <FormField label={cc.simpleNameLabel}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={cc.simpleNamePlaceholder}
        />
      </FormField>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={cc.simpleFreqLabel}>
          <Select
            value={freq}
            onChange={(e) => setFreq(e.target.value as SimpleFrequency)}
            options={[
              { value: 'daily', label: cc.freqDaily },
              { value: 'weekdays', label: cc.freqWeekdays },
              { value: 'weekly', label: cc.freqWeekly },
              { value: 'hourly', label: cc.freqHourly },
              { value: 'once', label: cc.freqOnce },
            ]}
          />
        </FormField>

        {needTime && (
          <FormField label={cc.simpleTimeLabel}>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </FormField>
        )}
        {freq === 'hourly' && (
          <FormField label={cc.simpleIntervalLabel}>
            <Input
              type="number"
              min={1}
              value={intervalHours}
              onChange={(e) => setIntervalHours(e.target.value)}
            />
          </FormField>
        )}
        {freq === 'once' && (
          <FormField label={cc.simpleOnceAtLabel}>
            <Input type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} />
          </FormField>
        )}
      </div>

      {freq === 'weekly' && (
        <FormField label={cc.simpleWeekdayLabel}>
          <Select
            value={weekday}
            onChange={(e) => setWeekday(e.target.value)}
            options={cc.weekdays.map((label, index) => ({ value: String(index), label }))}
          />
        </FormField>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button onClick={handleSubmit} loading={submitting}>
          {cc.simpleCreateCta}
        </Button>
      </div>
    </div>
  );
};
