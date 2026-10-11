// ============================================================================
// ConnectorsOnboardingStep —— 首启「连上你平时用的工具」步（模型步之后、
// 绑键步之前；不塞进 ONBOARDING_STEPS，避免改漏斗契约，与 voiceHotkey 同模式）。
// 只列既有连接器的常驻行；Connect 走既有 openCapabilitySettingsTarget 深链
// （能力中心 connectors tab + focus 横幅），不在此重做授权/安装/权限流。
// ============================================================================

import React, { useState } from 'react';
import { CalendarDays, ListChecks, Mail } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useAppStore } from '../../stores/appStore';
import { Button } from '../primitives';
import { ConnectorLogo } from '../features/connectors/ConnectorLogo';

interface ConnectorsOnboardingStepProps {
  disabled?: boolean;
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
}) => {
  const { t } = useI18n();
  const text = t.onboarding;
  const openCapabilitySettingsTarget = useAppStore((state) => state.openCapabilitySettingsTarget);
  const [openedId, setOpenedId] = useState<string | null>(null);

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
          return (
            <div
              key={id}
              data-onboarding-connector={id}
              className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3"
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
                  onClick={() => {
                    setOpenedId(id);
                    openCapabilitySettingsTarget({ kind: 'connector', id });
                  }}
                >
                  {text.connectorConnect}
                </Button>
              </div>
              {openedId === id ? (
                <p className="mt-2 text-xs text-badge-info">{text.connectorsOpenedHint}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
};
