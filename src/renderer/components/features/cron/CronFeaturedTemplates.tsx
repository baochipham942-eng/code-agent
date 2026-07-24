import React, { useMemo, useState } from 'react';
import type { CronJobDefinition } from '@shared/contract';
import { Check, Loader2, Sparkles } from 'lucide-react';
import { useCronStore } from '../../../stores/cronStore';
import { useAppStore } from '../../../stores/appStore';
import { useMcpServerStates } from '../../../hooks/useMcpServerStates';
import { useI18n } from '../../../hooks/useI18n';
import {
  FEATURED_CRON_TEMPLATES,
  getMissingTemplateConnectors,
  getTemplateConnectorStatuses,
  type CronTemplate,
  type TemplateConnectorStatus,
} from './cronTemplates';
import { buildCronJobInput } from './types';

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
      setError(err instanceof Error ? err.message : '开启失败，请稍后重试');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section
      className="shrink-0 border-b border-amber-500/20 bg-gradient-to-r from-amber-500/10 via-zinc-950 to-zinc-950 px-5 py-4"
      data-testid="cron-featured-templates"
    >
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-amber-300" />
        <div>
          <h3 className="text-sm font-medium text-zinc-100">推荐自动化</h3>
          <p className="mt-0.5 text-xs text-zinc-500">无需填写，点一下即可按默认时间开始</p>
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

          return (
            <div
              key={template.id}
              className={`group flex min-h-24 flex-col gap-1.5 rounded-xl border p-3 transition-colors ${cardStateClassName}`}
            >
              <button /* ds-allow:button: 推荐自动化卡片承载多行信息，primitive 的居中动作按钮布局不适配 */
                type="button"
                onClick={() => handleEnable(template, existingJob)}
                disabled={isPending || isEnabled}
                aria-label={`${isEnabled ? '已开启' : '开启'}${template.name}`}
                data-testid={`cron-featured-${template.id}`}
                className="flex w-full items-center gap-3 text-left disabled:cursor-default"
              >
                <span className="text-2xl" aria-hidden="true">{template.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-zinc-100">{template.name}</span>
                  <span className="mt-1 block text-xs text-zinc-400">{template.description}</span>
                  <span className="mt-1.5 block text-[11px] text-amber-300/90">
                    {template.scheduleLabel}
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-zinc-300 group-hover:text-amber-200">
                  {isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : isEnabled ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-300" />
                      已开启
                    </>
                  ) : (
                    existingJob ? '重新开启' : '开启'
                  )}
                </span>
              </button>

              {connectorStatuses.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pl-9" data-testid={`cron-featured-${template.id}-connectors`}>
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
                <div className="flex flex-wrap items-center gap-1.5 pl-9 text-[11px] text-amber-300">
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

