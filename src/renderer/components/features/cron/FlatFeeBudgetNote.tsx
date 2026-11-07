// ============================================================================
// FlatFeeBudgetNote — 美元预算上限旁的提示：包月（价表 0 元）模型下上限永不触发。
// 非零价模型不渲染任何内容。
// ============================================================================

import React from 'react';
import { isZeroPricedModel } from '../../../../shared/constants';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';

interface FlatFeeBudgetNoteProps {
  variant: 'settings' | 'cron';
}

export const FlatFeeBudgetNote: React.FC<FlatFeeBudgetNoteProps> = ({ variant }) => {
  const { t } = useI18n();
  const provider = useAppStore((state) => state.modelConfig.provider);
  const model = useAppStore((state) => state.modelConfig.model);
  if (!model || !isZeroPricedModel(provider, model)) return null;
  const cc = t.cronCenter;
  const template = variant === 'settings' ? cc.flatFeeBudgetNoteSettings : cc.flatFeeBudgetNoteCron;
  return (
    <p className="text-xs text-zinc-500" role="note" data-testid="flat-fee-budget-note">
      {template.replace('{model}', model)}
    </p>
  );
};
