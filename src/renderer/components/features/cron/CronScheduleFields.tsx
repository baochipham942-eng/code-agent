// ============================================================================
// CronScheduleFields —— 手动编辑器「调度方式」里的三个时间型调度字段组
//（at 执行时间 / every 间隔循环 / cron 表达式）。
// 自 CronJobEditor.tsx 逐字搬出（N-TRIGGER-MAIL-CREATE-ENTRY-K1：编辑器逼近
// max-lines 棘轮，事件源新增第 5 种调度类型 'event-mail' 前先把这块收拢）。
// 渲染条件（scheduleType 分支选择）留在编辑器，本组件只管字段本体。
// ============================================================================

import React from 'react';
import { isHourAlignedCronExpression, suggestCronStaggerMinute } from '@shared/cronStagger';
import { FormField } from '../../composites/FormField';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';
import { useI18n } from '../../../hooks/useI18n';
import type { CronJobDraft } from './types';

interface CronScheduleFieldsProps {
  draft: Pick<
    CronJobDraft,
    'scheduleType' | 'atDatetime' | 'everyInterval' | 'everyUnit' | 'everyStartAt' | 'everyEndAt' | 'cronExpression' | 'cronTimezone' | 'runsOn'
  >;
  setField: <K extends keyof CronJobDraft>(key: K, value: CronJobDraft[K]) => void;
  errors: Partial<Record<'atDatetime' | 'everyInterval' | 'cronExpression', string>>;
}

export const CronScheduleFields: React.FC<CronScheduleFieldsProps> = ({ draft, setField, errors }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;

  return (
    <>
      {draft.scheduleType === 'at' && (
        <FormField label="执行时间" required error={errors.atDatetime}>
          <Input
            type="text"
            value={draft.atDatetime}
            onChange={(e) => setField('atDatetime', e.target.value)}
            placeholder="2026-03-19T09:00"
            className="font-mono"
          />
        </FormField>
      )}

      {draft.scheduleType === 'every' && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="间隔值" required error={errors.everyInterval}>
              <Input
                type="number"
                min={draft.runsOn === 'cloud'
                  ? (draft.everyUnit === 'minutes' ? 60 : 1)
                  : (draft.everyUnit === 'minutes' ? 5 : 1)}
                value={draft.everyInterval}
                onChange={(e) => setField('everyInterval', e.target.value)}
              />
            </FormField>
            <FormField label="单位">
              <Select
                value={draft.everyUnit}
                onChange={(e) => setField('everyUnit', e.target.value as CronJobDraft['everyUnit'])}
                options={[
                  { value: 'minutes', label: '分钟' },
                  { value: 'hours', label: '小时' },
                  { value: 'days', label: '天' },
                ]}
              />
            </FormField>
          </div>
          <p className="text-xs text-zinc-500" data-testid="cron-min-interval-hint">
            {draft.runsOn === 'cloud' ? cc.cloudIntervalHint : cc.localIntervalHint}
          </p>
          {(draft.everyUnit === 'hours' || draft.everyUnit === 'days') && (
            <p className="text-xs text-zinc-500" data-testid="cron-auto-stagger-hint">
              {draft.everyUnit === 'hours' ? '小时' : '天'}级任务会按任务 ID 自动错峰到非整点分钟，避免扎堆触发。
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="开始时间">
              <Input
                type="text"
                value={draft.everyStartAt}
                onChange={(e) => setField('everyStartAt', e.target.value)}
                placeholder="可选"
                className="font-mono"
              />
            </FormField>
            <FormField label="结束时间">
              <Input
                type="text"
                value={draft.everyEndAt}
                onChange={(e) => setField('everyEndAt', e.target.value)}
                placeholder="可选"
                className="font-mono"
              />
            </FormField>
          </div>
        </>
      )}

      {draft.scheduleType === 'cron' && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Cron 表达式" required error={errors.cronExpression}>
              <Input
                value={draft.cronExpression}
                onChange={(e) => setField('cronExpression', e.target.value)}
                className="font-mono"
              />
            </FormField>
            <FormField label="时区">
              <Input
                value={draft.cronTimezone}
                onChange={(e) => setField('cronTimezone', e.target.value)}
                placeholder="Asia/Shanghai"
              />
            </FormField>
          </div>
          {isHourAlignedCronExpression(draft.cronExpression) && (
            <p className="text-xs text-badge-warning" data-testid="cron-stagger-hint">
              整点任务容易和其他任务扎堆触发，建议把分钟位错开到{' '}
              {suggestCronStaggerMinute(draft.cronExpression)} 分。
            </p>
          )}
        </div>
      )}
    </>
  );
};
