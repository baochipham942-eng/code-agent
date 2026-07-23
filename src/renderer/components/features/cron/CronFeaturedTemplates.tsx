import React, { useState } from 'react';
import type { CronJobDefinition } from '@shared/contract';
import { Check, Loader2, Sparkles } from 'lucide-react';
import { useCronStore } from '../../../stores/cronStore';
import { FEATURED_CRON_TEMPLATES, type CronTemplate } from './cronTemplates';
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
  const { jobs, createJob, updateJob } = useCronStore();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleEnable = async (
    template: CronTemplate,
    existingJob: CronJobDefinition | undefined,
  ) => {
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
          return (
            <button /* ds-allow:button: 推荐自动化卡片承载多行信息，primitive 的居中动作按钮布局不适配 */
              key={template.id}
              type="button"
              onClick={() => handleEnable(template, existingJob)}
              disabled={isPending || isEnabled}
              aria-label={`${isEnabled ? '已开启' : '开启'}${template.name}`}
              data-testid={`cron-featured-${template.id}`}
              className="group flex min-h-24 items-center gap-3 rounded-xl border border-zinc-700/80 bg-zinc-900/80 p-3 text-left transition-colors hover:border-amber-400/50 hover:bg-zinc-900 disabled:cursor-default disabled:border-emerald-500/30 disabled:bg-emerald-500/5"
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
          );
        })}
      </div>
    </section>
  );
};

export default CronFeaturedTemplates;
