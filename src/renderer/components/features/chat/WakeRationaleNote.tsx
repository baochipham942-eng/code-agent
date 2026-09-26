// ============================================================================
// WakeRationaleNote - 主动建议卡片上的「为什么」入口
// ============================================================================
// 只展示醒来时落库的 rationale / evidence。缺失时写明「这条没有记录理由」，
// 不从正文倒推。

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { MessageMetadata } from '@shared/contract/message';
import { useI18n } from '../../../hooks/useI18n';

export interface WakeRationaleFields {
  rationale?: string;
  evidence?: string;
  missing: boolean;
}

export function wakeRationaleFromMetadata(metadata?: MessageMetadata): WakeRationaleFields | null {
  if (metadata?.wakeRationale) {
    return {
      rationale: metadata.wakeRationale.rationale,
      evidence: metadata.wakeRationale.evidence,
      missing: metadata.wakeRationale.missing,
    };
  }
  if (metadata?.automation?.automationType === 'role_wake') {
    const rationale = metadata.automation.rationale;
    const evidence = metadata.automation.evidence;
    const explicitMissing = metadata.automation.rationaleMissing === true;
    if (!rationale && !evidence && !explicitMissing) return null;
    return {
      rationale,
      evidence,
      missing: explicitMissing || !rationale,
    };
  }
  return null;
}

export const WakeRationaleNote: React.FC<{ fields: WakeRationaleFields }> = ({ fields }) => {
  const { t } = useI18n();
  const text = t.wakeRationale;
  const [open, setOpen] = useState(false);
  const showMissing = fields.missing || !fields.rationale?.trim();

  return (
    <div className="mt-2" data-testid="wake-rationale">
      <button /* ds-allow:button: 主动建议「为什么」是行内展开入口，primitive 按钮会撑破卡片 */
        type="button"
        data-testid="wake-rationale-why"
        aria-expanded={open}
        aria-label={text.whyAria}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-800/70 hover:text-zinc-300"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {text.why}
      </button>
      {open ? (
        <div
          data-testid="wake-rationale-panel"
          className="mt-1.5 max-w-xl rounded-lg border border-zinc-700/70 bg-zinc-900/40 px-2.5 py-2 text-xs leading-5 text-zinc-400"
        >
          {showMissing ? (
            <p data-testid="wake-rationale-missing">{text.missing}</p>
          ) : (
            <>
              <p data-testid="wake-rationale-text">{fields.rationale}</p>
              {fields.evidence ? (
                <p data-testid="wake-rationale-evidence" className="mt-1 text-zinc-500">
                  {text.evidenceLabel}：{fields.evidence}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
};
