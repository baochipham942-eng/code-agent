// ============================================================================
// ConnectorsOnboardingStep —— 首启「连上你平时用的工具」步（模型步之后、
// 绑键步之前；不塞进 ONBOARDING_STEPS，避免改漏斗契约，与 voiceHotkey 同模式）。
// 只列既有连接器的常驻行。两类行为（拍板 2026-10-14 A）：
// · 本机连接器（邮件/日历/提醒事项）在行内直接触发 macOS 授权：走 connector 域
//   既有 repairPermission（与设置页"修复权限"同一 host 动作），行内展示结果；
//   失败时不提供原地重试——系统对 Don't Allow 不会再弹——只记住 id，引导结束
//   由 ModelOnboardingModal 深链落到该卡片。
// · Feishu/Google 只记意图（受控 pendingConnectorId），能力中心深链仍由
//   ModelOnboardingModal 在 onComplete 之后统一发——modal 还开着时早发会被遮罩
//   挡住，且 App 收尾的 setShowSettings(false) 会把面板再关上（返工 10-12）。
// ============================================================================

import React, { useState } from 'react';
import { CalendarDays, ListChecks, Mail } from 'lucide-react';
import { IPC_DOMAINS, type ConnectorStatusSummary } from '@shared/ipc';
import { useI18n } from '../../hooks/useI18n';
import { interpolate } from '../../i18n/interpolate';
import ipcService from '../../services/ipcService';
import { Button } from '../primitives';
import { ConnectorLogo } from '../features/connectors/ConnectorLogo';

interface ConnectorsOnboardingStepProps {
  disabled?: boolean;
  pendingConnectorId: string | null;
  onConnectIntent: (id: string) => void;
}

/** 行 id 与设置页连接器 id 同源（feishu/google-calendar 走 ConnectorLogo 资产） */
const CONNECTOR_ROW_ICONS = {
  mail: Mail,
  calendar: CalendarDays,
  reminders: ListChecks,
} as const;

const CONNECTOR_ROW_IDS = ['feishu', 'google-calendar', 'mail', 'calendar', 'reminders'] as const;

/** 引导步内直接触发系统授权的本机连接器；其余行保持"记住 → 引导后深链" */
const LOCAL_CONNECTOR_ROW_IDS = new Set(['mail', 'calendar', 'reminders']);

/** host 探测文案里「授权通过但没有内容」的标记（邮件无账号/日历无日程/提醒无列表） */
const NO_ACCOUNT_MARKER = '没有找到可访问';

type LocalConnectorOutcome = 'ready' | 'no-account' | 'failed';

function resolveLocalOutcome(status: ConnectorStatusSummary | undefined): LocalConnectorOutcome {
  if (status?.readiness !== 'ready') return 'failed';
  const detail = `${status.detail ?? ''} ${status.error ?? ''}`;
  return detail.includes(NO_ACCOUNT_MARKER) ? 'no-account' : 'ready';
}

export const ConnectorsOnboardingStep: React.FC<ConnectorsOnboardingStepProps> = ({
  disabled = false,
  pendingConnectorId,
  onConnectIntent,
}) => {
  const { t } = useI18n();
  const text = t.onboarding;
  const [busyConnectorId, setBusyConnectorId] = useState<string | null>(null);
  const [localOutcomes, setLocalOutcomes] = useState<Record<string, LocalConnectorOutcome>>({});

  const applyLocalOutcome = (id: string, statuses: ConnectorStatusSummary[] | null) => {
    const status = Array.isArray(statuses) ? statuses.find((item) => item.id === id) : undefined;
    const outcome = resolveLocalOutcome(status);
    setLocalOutcomes((current) => ({ ...current, [id]: outcome }));
    if (outcome === 'failed') {
      // Don't Allow 后系统不会再弹，原地重试无意义：记住 id，引导结束落到该卡片
      onConnectIntent(id);
    }
  };

  const connectLocal = async (id: string) => {
    setBusyConnectorId(id);
    try {
      const statuses = await ipcService.invokeDomain<ConnectorStatusSummary[]>(
        IPC_DOMAINS.CONNECTOR,
        'repairPermission',
        { connectorId: id },
      );
      applyLocalOutcome(id, statuses);
    } catch {
      // 探测失败时该 action 整体 reject（host 侧 osascript 抛错），失败态已写进
      // listStatuses——补读一次；仍读不到就按 failed 兜底。
      const statuses = await ipcService
        .invokeDomain<ConnectorStatusSummary[]>(IPC_DOMAINS.CONNECTOR, 'listStatuses')
        .catch(() => null);
      applyLocalOutcome(id, statuses);
    } finally {
      setBusyConnectorId(null);
    }
  };

  return (
    <section className="space-y-4" data-testid="onboarding-connectors-step">
      <div>
        <h3 className="text-sm font-medium text-zinc-100">{text.connectorsTitle}</h3>
        <p className="mt-1 text-xs leading-5 text-zinc-500">{text.connectorsDescription}</p>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {CONNECTOR_ROW_IDS.map((id) => {
          const row = text.connectorRows[id];
          const FallbackIcon = CONNECTOR_ROW_ICONS[id as keyof typeof CONNECTOR_ROW_ICONS];
          const pending = pendingConnectorId === id;
          const isLocal = LOCAL_CONNECTOR_ROW_IDS.has(id);
          const localBusy = isLocal && busyConnectorId === id;
          const outcome = isLocal ? localOutcomes[id] : undefined;
          return (
            <div
              key={id}
              data-onboarding-connector={id}
              data-pending={pending ? 'true' : 'false'}
              className={`rounded-lg border p-3 ${pending ? 'border-badge-info/60 bg-blue-500/5' : 'border-zinc-800 bg-zinc-950/30'}`}
            >
              <div className="flex items-center gap-3">
                <ConnectorLogo
                  id={id}
                  displayName={row.name}
                  fallback={FallbackIcon ? <FallbackIcon className="h-5 w-5 text-zinc-400" /> : null}
                  className="h-5 w-5"
                />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm text-zinc-100">{row.name}</strong>
                  <span className="block truncate text-xs text-zinc-500">{row.description}</span>
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid={`onboarding-connect-${id}`}
                  disabled={disabled || (isLocal && (busyConnectorId !== null || outcome !== undefined))}
                  loading={localBusy}
                  onClick={() => (isLocal ? void connectLocal(id) : onConnectIntent(id))}
                >
                  {outcome && outcome !== 'failed' ? text.connectorConnected : text.connectorConnect}
                </Button>
              </div>
              {localBusy ? (
                <p className="mt-2 text-xs text-badge-info" data-testid={`onboarding-connecting-${id}`}>
                  {text.connectorConnectingHint}
                </p>
              ) : outcome ? (
                <p
                  className={`mt-2 text-xs leading-5 ${outcome === 'failed' ? 'text-badge-danger' : 'text-badge-success'}`}
                  data-testid={`onboarding-connect-result-${id}`}
                >
                  {outcome === 'ready'
                    ? text.connectorReadyHint
                    : outcome === 'no-account'
                      ? interpolate(text.connectorNoAccountHint, { name: row.name })
                      : interpolate(text.connectorDeniedHint, { name: row.name })}
                </p>
              ) : pending ? (
                <p className="mt-2 text-xs text-badge-info">
                  {interpolate(text.connectorsOpenedHint, { name: row.name })}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
};
