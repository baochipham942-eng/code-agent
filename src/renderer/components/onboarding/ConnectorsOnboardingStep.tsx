// ============================================================================
// ConnectorsOnboardingStep —— 首启「连上你平时用的工具」步（模型步之后、
// 绑键步之前；不塞进 ONBOARDING_STEPS，避免改漏斗契约，与 voiceHotkey 同模式）。
// 只列既有连接器的常驻行。Connect 只记意图（受控 pendingConnectorId），
// 能力中心深链由 ModelOnboardingModal 在 onComplete 之后统一发——modal 还开着
// 时早发会被遮罩挡住，且 App 收尾的 setShowSettings(false) 会把面板再关上（返工 10-12）。
// ============================================================================

import React from 'react';
import { CalendarDays, ListChecks, Mail } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { interpolate } from '../../i18n/interpolate';
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

export const ConnectorsOnboardingStep: React.FC<ConnectorsOnboardingStepProps> = ({
  disabled = false,
  pendingConnectorId,
  onConnectIntent,
}) => {
  const { t } = useI18n();
  const text = t.onboarding;

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
                  disabled={disabled}
                  onClick={() => onConnectIntent(id)}
                >
                  {text.connectorConnect}
                </Button>
              </div>
              {pending ? (
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
