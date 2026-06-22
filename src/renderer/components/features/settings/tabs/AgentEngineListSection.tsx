// ============================================================================
// AgentEngineListSection — 设置页「执行引擎」section
// ----------------------------------------------------------------------------
// 把执行引擎（native / codex / claude / mimo / kimi）独立成区，与「通用模型 provider」
// 平级。每个引擎卡片展示：label + 安装状态徽标 + 版本 + 计费模式标签 + 默认模型来源说明
// + （外部引擎）登录提示 + （未安装时）获取指引。文案全部走 i18n。
// 数据底座：window.domainAPI.invoke(AGENT_ENGINE, 'list' | 'detect') → AgentEngineDescriptor[]，
// 计费/兼容矩阵来自 @shared/constants/engineCompat（经 modelSwitcherHelpers 翻译）。
// 不在此处重造矩阵，不改引擎运行逻辑，只做展示 + 检测触发。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { Cpu, RefreshCw, Terminal } from 'lucide-react';
import type { AgentEngineDescriptor } from '@shared/contract/agentEngine';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { Button } from '../../../primitives';
import { SettingsSection } from '../SettingsLayout';
import { EngineBillingBadge } from '../../../StatusBar/modelSwitcherHelpers';
import { buildEngineSectionRows } from './agentEngineSectionHelpers';

const logger = createLogger('AgentEngineListSection');

export const AgentEngineListSection: React.FC = () => {
  const { t } = useI18n();
  const section = t.engineCompat.engineSection;
  const [descriptors, setDescriptors] = useState<AgentEngineDescriptor[] | null>(null);
  const [detecting, setDetecting] = useState(false);

  const loadEngines = useCallback(async (action: 'list' | 'detect') => {
    if (action === 'detect') setDetecting(true);
    try {
      const result = await ipcService.invokeDomain<AgentEngineDescriptor[]>(IPC_DOMAINS.AGENT_ENGINE, action);
      setDescriptors(Array.isArray(result) ? result : []);
    } catch (error) {
      logger.warn('Failed to load agent engines', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (action === 'detect') toast.error(section.detectFailed);
    } finally {
      if (action === 'detect') setDetecting(false);
    }
  }, [section.detectFailed]);

  useEffect(() => {
    let cancelled = false;
    ipcService.invokeDomain<AgentEngineDescriptor[]>(IPC_DOMAINS.AGENT_ENGINE, 'list')
      .then((result) => {
        if (!cancelled) setDescriptors(Array.isArray(result) ? result : []);
      })
      .catch((error: unknown) => {
        logger.warn('Failed to load agent engines', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!cancelled) setDescriptors([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = descriptors ? buildEngineSectionRows(descriptors, t) : [];

  return (
    <SettingsSection
      title={section.listTitle}
      description={section.listDescription}
      actions={
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void loadEngines('detect')}
          disabled={detecting}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${detecting ? 'animate-spin' : ''}`} />
          {detecting ? section.detecting : section.detectButton}
        </Button>
      }
    >
      <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
        {descriptors === null ? (
          <div className="px-3 py-4 text-sm text-zinc-500">{section.loading}</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-4 text-sm text-zinc-500">{section.empty}</div>
        ) : (
          <div className="divide-y divide-zinc-800/80">
            {rows.map((row) => (
              <div key={row.kind} className="px-3 py-3" data-engine-kind={row.kind}>
                <div className="flex flex-wrap items-center gap-2">
                  {row.kind === 'native' ? (
                    <Cpu className="h-4 w-4 shrink-0 text-zinc-400" />
                  ) : (
                    <Terminal className="h-4 w-4 shrink-0 text-zinc-400" />
                  )}
                  <span className="text-sm font-medium text-zinc-100">{row.label}</span>
                  <span
                    className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] ${row.installStateBadgeClass}`}
                    data-engine-install-state={row.installState}
                  >
                    {row.installStateLabel}
                  </span>
                  <EngineBillingBadge summary={row.billing} />
                </div>

                <p className="mt-1.5 text-xs text-zinc-500">{row.summary}</p>

                <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
                  {row.version ? (
                    <div className="flex gap-1.5">
                      <dt className="shrink-0 text-zinc-500">{section.versionLabel}</dt>
                      <dd className="truncate font-mono text-zinc-300" title={row.version}>{row.version}</dd>
                    </div>
                  ) : null}
                  {row.binaryPath ? (
                    <div className="flex gap-1.5">
                      <dt className="shrink-0 text-zinc-500">{section.binaryPathLabel}</dt>
                      <dd className="truncate font-mono text-zinc-400" title={row.binaryPath}>{row.binaryPath}</dd>
                    </div>
                  ) : null}
                  <div className="flex gap-1.5 sm:col-span-2">
                    <dt className="shrink-0 text-zinc-500">{section.defaultModelLabel}</dt>
                    <dd className="text-zinc-400">{row.defaultModelHint}</dd>
                  </div>
                </dl>

                {row.installHint ? (
                  <div className="mt-2 rounded border border-amber-500/20 bg-amber-500/[0.06] px-2 py-1.5 text-[11px] text-amber-200">
                    <span className="font-medium">{section.installHintTitle}：</span>
                    {row.installHint}
                  </div>
                ) : null}
                {row.loginHint ? (
                  <div className="mt-1.5 text-[11px] text-zinc-500">
                    <span className="font-medium text-zinc-400">{section.loginHintTitle}：</span>
                    {row.loginHint}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </SettingsSection>
  );
};
