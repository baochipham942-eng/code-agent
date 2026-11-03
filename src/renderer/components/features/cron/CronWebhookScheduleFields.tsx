// ============================================================================
// CronWebhookScheduleFields — 编辑器里「Webhook 投递」调度的表单段（创建门）
// 云端服务没配置：一句话原因 + 「去设置」，调用方据 gated 禁用保存；已配置：
// 单次预算上限（webhook 任务硬性要求 > 0）。
// ============================================================================

import React from 'react';
import { Button } from '../../primitives/Button';
import { Input } from '../../primitives/Input';
import { FormField } from '../../composites/FormField';
import { useI18n } from '../../../hooks/useI18n';

interface CronWebhookScheduleFieldsProps {
  loading: boolean;
  configured: boolean;
  onGotoSettings: () => void;
  maxRunBudget: string;
  onBudgetChange: (value: string) => void;
  validationMessage: string | null;
}

export const CronWebhookScheduleFields: React.FC<CronWebhookScheduleFieldsProps> = ({
  loading, configured, onGotoSettings, maxRunBudget, onBudgetChange, validationMessage,
}) => {
  const { t } = useI18n();
  const cc = t.cronCenter;

  if (!loading && !configured) {
    return (
      <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-badge-warning" data-testid="cron-webhook-gate">
        <p>{cc.webhook.gateUnconfigured}</p>
        <Button size="sm" variant="secondary" onClick={onGotoSettings} data-testid="cron-webhook-goto-settings">
          {cc.webhook.gotoSettings}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <FormField label={cc.eventBudgetLabel} required htmlFor="cron-webhook-budget" hint={cc.eventBudgetHint}>
        <Input
          id="cron-webhook-budget"
          type="number"
          value={maxRunBudget}
          onChange={(event) => onBudgetChange(event.target.value)}
          placeholder="0.5"
        />
      </FormField>
      <p className="text-xs text-zinc-500">{cc.webhook.budgetRequired}</p>
      {validationMessage && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-badge-danger" data-testid="cron-webhook-validation">
          {validationMessage}
        </div>
      )}
    </div>
  );
};
