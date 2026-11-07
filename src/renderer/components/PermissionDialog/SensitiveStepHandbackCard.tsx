// ============================================================================
// SensitiveStepHandbackCard - ADR-088 敏感步骤交回卡（交互状态机版）
// 规格：docs/architecture/sensitive-step-handback.md §3（文案逐字来自规格，改动先改规格）。
//
// 状态机 asking → waiting-for-user → done | skipped：
//   我来完成      ：只推进本地状态（waiting），**不**裁决底层请求
//   完成后继续    ：以一次性 allow 裁决（最小线改动——不新增任何读作 allow 的应答值）
//   这步不做了    ：以 deny 裁决
// 交回步在 host 侧永不执行，无论点哪个按钮；卡片永不出现「本次会话始终允许 / 始终允许」
// （forceConfirm + host 侧 recordHumanGrant 收口双保险）。
// 停车（无人值守）形态见 SensitiveStepParkedRow：无活状态机，单状态卡。
// ============================================================================

import React, { useState } from 'react';
import { Hand } from 'lucide-react';
import { DecisionCard, type DecisionOption } from '../DecisionCard';
import { useI18n } from '../../hooks/useI18n';
import type { PermissionRequest } from './types';

type HandbackPhase = 'asking' | 'waiting' | 'done' | 'skipped';

interface SensitiveStepHandbackCardProps {
  request: PermissionRequest;
  /** 'once' → 一次性 allow（完成后继续）；'deny' → 拒绝（这步不做了）。走 PermissionCard 既有投递链。 */
  onRespond: (level: 'once' | 'deny') => void;
  onCollapse?: () => void;
}

/** 正文按 kind 三选一（规格 §3）；{app}/{label} 缺省回落，仅此两变量。 */
function sensitiveStepBody(
  step: NonNullable<PermissionRequest['details']['sensitiveStep']>,
  copy: ReturnType<typeof useI18n>['t']['decisionCard']['permission']['sensitiveStep'],
): string {
  const app = step.appName?.trim() || copy.appFallback;
  const label = step.elementLabel?.trim() || copy.labelFallback;
  const template = step.kind === 'verification_code'
    ? copy.bodyVerificationCode
    : step.kind === 'payment'
      ? copy.bodyPayment
      : copy.bodyPassword;
  return template.replace('{app}', app).replace('{label}', label);
}

export const SensitiveStepHandbackCard: React.FC<SensitiveStepHandbackCardProps> = ({
  request,
  onRespond,
  onCollapse,
}) => {
  const { t } = useI18n();
  const copy = t.decisionCard.permission.sensitiveStep;
  const step = request.details.sensitiveStep;
  const [phase, setPhase] = useState<HandbackPhase>('asking');
  if (!step) return null;

  const question = phase === 'done'
    ? copy.doneLine
    : phase === 'skipped'
      ? copy.skippedLine
      : sensitiveStepBody(step, copy);

  const options: DecisionOption[] = phase === 'asking'
    ? [
        { id: 'do_it', label: copy.doItMyself },
        { id: 'skip', label: copy.skipStep },
      ]
    : phase === 'waiting'
      ? [
          { id: 'continue', label: copy.continueAfterDone },
          { id: 'skip', label: copy.skipStep },
        ]
      : [];

  return (
    <DecisionCard
      testId="sensitive-step-handback-card"
      className="w-full animate-slideUp"
      pinActions
      tone="amber"
      icon={<Hand size={20} />}
      title={copy.title}
      question={question}
      details={phase === 'waiting' ? (
        <p className="text-xs leading-5 text-zinc-400" data-testid="sensitive-step-waiting-hint">
          {copy.waitingHint}
        </p>
      ) : undefined}
      options={options}
      selectedId={null}
      onSelect={() => {}}
      onConfirm={() => {}}
      onCollapse={onCollapse}
      enterDisabled={phase === 'asking'}
      viewMode="expanded"
      directActions
      primaryActionId={phase === 'waiting' ? 'continue' : phase === 'asking' ? 'do_it' : undefined}
      onDirectAction={(id) => {
        if (id === 'do_it') {
          setPhase('waiting'); // 只推进状态，不裁决底层请求（规格 §3）
          return;
        }
        if (id === 'continue') {
          setPhase('done');
          onRespond('once');
          return;
        }
        if (id === 'skip') {
          setPhase('skipped');
          onRespond('deny');
        }
      }}
      hideFooter={phase === 'done' || phase === 'skipped'}
      settled={phase === 'done' || phase === 'skipped'}
      confirmLabel={copy.continueAfterDone}
    />
  );
};

// ----------------------------------------------------------------------------
// 停车（无人值守）单状态卡：收件箱 / 会话停车卡共用。没有活的状态机——应答走台账
// 裁决口，只给 [完成后继续]（allow）与 [这步不做了]（deny）两个按钮；正文首行加
// 停车提醒（规格 §3「无人值守 / 停车卡」）。
// ----------------------------------------------------------------------------

interface SensitiveStepParkedRowProps {
  step: NonNullable<PermissionRequest['details']['sensitiveStep']>;
  onRespond: (response: 'allow' | 'deny') => void;
  disabled?: boolean;
}

export const SensitiveStepParkedRow: React.FC<SensitiveStepParkedRowProps> = ({
  step,
  onRespond,
  disabled = false,
}) => {
  const { t } = useI18n();
  const copy = t.decisionCard.permission.sensitiveStep;
  return (
    <div className="min-w-0 flex-1" data-testid="sensitive-step-parked-row">
      <div className="text-[11px] text-badge-warning" data-testid="sensitive-step-parked-reminder">
        {copy.parkedReminder}
      </div>
      <div className="mt-0.5 text-xs leading-5 text-zinc-300">{sensitiveStepBody(step, copy)}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button /* ds-allow:button: 收件箱行内超小文本按钮（px-2 py-1 text-xs），primitive 最小 sm 更大 */
          type="button"
          onClick={() => onRespond('allow')}
          disabled={disabled}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-badge-success transition-colors hover:bg-emerald-500/10 hover:text-badge-success disabled:opacity-50"
          data-testid="sensitive-step-parked-continue"
        >
          <Hand className="h-3.5 w-3.5" />
          {copy.continueAfterDone}
        </button>
        <button /* ds-allow:button: 同上，收件箱行内超小文本按钮 */
          type="button"
          onClick={() => onRespond('deny')}
          disabled={disabled}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
          data-testid="sensitive-step-parked-skip"
        >
          {copy.skipStep}
        </button>
      </div>
    </div>
  );
};
