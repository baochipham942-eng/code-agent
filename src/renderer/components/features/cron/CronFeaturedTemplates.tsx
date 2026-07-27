// ============================================================================
// CronFeaturedTemplates —— 自动化页首的推荐模板卡（一键开启，无需填写）。
// 图标不用 emoji（渲染破损、风格漂移）：统一 lucide 图标 + 品牌瓦片
// （--brand-primary color-mix 派生，与侧栏新任务/NeoBrandMark 同一配方）；
// 「开启」是卡片唯一主操作，统一走 Button primitive 品牌主按钮。
// ============================================================================

import React, { useMemo, useState } from 'react';
import type { CronJobDefinition } from '@shared/contract';
import { CalendarClock, CalendarRange, Check, ClipboardCheck, Sparkles, type LucideIcon } from 'lucide-react';
import { useCronStore } from '../../../stores/cronStore';
import { useAppStore } from '../../../stores/appStore';
import { useMcpServerStates } from '../../../hooks/useMcpServerStates';
import { useI18n } from '../../../hooks/useI18n';
import { Button } from '../../primitives/Button';
import {
  FEATURED_CRON_TEMPLATES,
  getMissingTemplateConnectors,
  getTemplateConnectorStatuses,
  type CronTemplate,
  type TemplateConnectorStatus,
} from './cronTemplates';
import { buildCronJobInput } from './types';

/** 模板 id → lucide 图标；未登记的模板（测试桩、未来新增）回退 Sparkles */
const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  'daily-lookahead': CalendarClock,
  'daily-review': ClipboardCheck,
  'weekly-review': CalendarRange,
};

function findExistingJob(
  template: CronTemplate,
  jobs: CronJobDefinition[],
): CronJobDefinition | undefined {
  const draft = template.generate({});
  return jobs.find(
    (job) =>
      job.name === draft.name &&
      job.action.type === 'agent' &&
      job.action.prompt === draft.agentPrompt,
  );
}

export const CronFeaturedTemplates: React.FC = () => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const { jobs, createJob, updateJob } = useCronStore();
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const mcpServerStates = useMcpServerStates();
  const connectedConnectorIds = useMemo(
    () => new Set(
      mcpServerStates
        .filter((server) => server.status === 'connected')
        .map((server) => server.config.name),
    ),
    [mcpServerStates],
  );
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gateHint, setGateHint] = useState<{ templateId: string; missing: TemplateConnectorStatus[] } | null>(null);

  const handleEnable = async (
    template: CronTemplate,
    existingJob: CronJobDefinition | undefined,
  ) => {
    const missing = getMissingTemplateConnectors(
      getTemplateConnectorStatuses(template, connectedConnectorIds),
    );
    setGateHint(missing.length > 0 ? { templateId: template.id, missing } : null);
    setPendingId(template.id);
    setError(null);
    try {
      if (existingJob) {
        await updateJob(existingJob.id, { enabled: true });
      } else {
        await createJob(buildCronJobInput(template.generate({})));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : cc.templateEnableFailed);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section
      /* 2026-07-27 审美关：整块 amber 渐变强调条降噪成中性区（对标 WorkBuddy 的模板区）。
         彩色只留 Sparkles 图标——推荐是常驻内容，不是要你立刻处理的告警。 */
      className="shrink-0 border-b border-zinc-800 bg-zinc-900/40 px-6 py-4"
      data-testid="cron-featured-templates"
    >
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-amber-300" />
        <div>
          <h3 className="text-sm font-medium text-zinc-100">{cc.templatesTitle}</h3>
          <p className="mt-0.5 text-xs text-zinc-500">{cc.templatesSubtitle}</p>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {FEATURED_CRON_TEMPLATES.map((template) => {
          const existingJob = findExistingJob(template, jobs);
          const isEnabled = existingJob?.enabled === true;
          const isPending = pendingId === template.id;
          const connectorStatuses = getTemplateConnectorStatuses(template, connectedConnectorIds);
          const cardStateClassName = isPending || isEnabled
            ? 'border-emerald-500/30 bg-emerald-500/5'
            : 'border-zinc-700/80 bg-zinc-900/80 hover:border-amber-400/50 hover:bg-zinc-900';
          const TemplateIcon = TEMPLATE_ICONS[template.id] ?? Sparkles;
          const enableLabel = isEnabled
            ? cc.templateEnabled
            : existingJob
              ? cc.templateReenable
              : cc.templateEnable;

          return (
            <div
              key={template.id}
              className={`flex min-h-24 flex-col gap-1.5 rounded-xl border p-3 transition-colors ${cardStateClassName}`}
            >
              <div className="flex w-full items-center gap-3">
                {/* 品牌瓦片与侧栏新任务/NeoBrandMark 同一配方（--brand-primary color-mix 派生） */}
                <span
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md"
                  style={{
                    color: 'var(--brand-primary)',
                    background: 'color-mix(in srgb, var(--brand-primary) 18%, transparent)',
                    boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brand-primary) 42%, transparent)',
                  }}
                  aria-hidden="true"
                >
                  <TemplateIcon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-zinc-100">{template.name}</span>
                  <span className="mt-1 block text-xs text-zinc-400">{template.description}</span>
                  <span className="mt-1.5 block text-[11px] text-amber-300/90">
                    {template.scheduleLabel}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant={isEnabled ? 'secondary' : 'primary'}
                  onClick={() => handleEnable(template, existingJob)}
                  disabled={isEnabled}
                  loading={isPending}
                  leftIcon={isEnabled ? <Check className="h-3.5 w-3.5" /> : undefined}
                  aria-label={`${enableLabel}${template.name}`}
                  data-testid={`cron-featured-${template.id}`}
                >
                  {enableLabel}
                </Button>
              </div>

              {connectorStatuses.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pl-12" data-testid={`cron-featured-${template.id}-connectors`}>
                  {connectorStatuses.map((status) => (
                    <span key={status.id} className="inline-flex items-center gap-1 text-[11px]">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${status.connected ? 'bg-emerald-400' : 'bg-zinc-600'}`}
                        aria-hidden="true"
                      />
                      <span className={status.connected ? 'text-emerald-300' : 'text-zinc-500'}>
                        {status.label}{status.connected ? `·${cc.connectorConnected}` : `·${cc.connectorNotConnected}`}
                      </span>
                    </span>
                  ))}
                </div>
              )}

              {gateHint?.templateId === template.id && (
                <div className="flex flex-wrap items-center gap-1.5 pl-12 text-[11px] text-amber-300">
                  <span>
                    {cc.connectorNeededHint.replace(
                      '{name}',
                      gateHint.missing.map((status) => status.label).join('、'),
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => openSettingsTab('mcp')}
                    className="underline decoration-dotted hover:text-amber-200"
                  >
                    {cc.connectorConnectAction}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};
