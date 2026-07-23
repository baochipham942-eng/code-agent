import React from 'react';
import { Clock, Wrench, Zap } from 'lucide-react';
import type { SwarmAgentState } from '@shared/contract/swarm';
import type { SwarmRunAgentRecord } from '@shared/contract/swarmTrace';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { RoleInitialAvatar } from '../expert/RoleInitialAvatar';
import { Modal } from '../../primitives/Modal';

type RecordData = Pick<SwarmRunAgentRecord, 'dispatchedTask' | 'finalOutput' | 'finalOutputTruncated' | 'finalOutputArchiveItemId' | 'durationMs' | 'tokensIn' | 'tokensOut' | 'toolCalls' | 'costUsd'>;

function duration(ms?: number | null): string {
  if (!ms) return '—';
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

export const AgentWorkRecordDialog: React.FC<{
  agent: SwarmAgentState;
  record?: RecordData | null;
  loading?: boolean;
  onBack: () => void;
}> = ({ agent, record, loading = false, onBack }) => {
  const { t } = useI18n();
  const openWorkspacePreview = useAppStore((state) => state.openWorkspacePreview);
  const output = record?.finalOutput ?? agent.finalOutput;
  const task = record?.dispatchedTask ?? agent.dispatchedTask;
  const tokens = record ? record.tokensIn + record.tokensOut : (agent.tokenUsage?.input ?? 0) + (agent.tokenUsage?.output ?? 0);
  const toolCalls = record?.toolCalls ?? agent.toolCalls ?? 0;
  const cost = record?.costUsd ?? agent.cost ?? 0;
  const elapsed = record?.durationMs ?? (agent.startTime ? (agent.endTime ?? Date.now()) - agent.startTime : null);

  return (
    <Modal isOpen onClose={onBack} title={t.expert.workRecord.title} size="xl" className="max-h-[85vh]" footer={<button /* ds-allow:button: subagent 工作记录的唯一底部返回动作 */ type="button" onClick={onBack} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-700">{t.expert.workRecord.backToChat}</button>}>
      <section data-testid="agent-work-record">
        <header className="flex items-center gap-3 border-b border-zinc-800 px-1 pb-3">
          <RoleInitialAvatar roleId={agent.role || agent.id} name={agent.name || agent.role} />
          <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold text-zinc-100">{agent.name || agent.id}</h2><p className="truncate text-xs text-zinc-400">{agent.role}</p></div>
        </header>
        <div className="space-y-4 overflow-y-auto py-4 text-sm">
          {loading ? <p className="text-zinc-400">{t.expert.workRecord.loading}</p> : <>
            <RecordSection title={t.expert.workRecord.receivedTask} testId="agent-work-task">{task || t.expert.workRecord.noTask}</RecordSection>
            <RecordSection title={t.expert.workRecord.activity} testId="agent-work-activity"><span className="inline-flex items-center gap-1"><Wrench className="h-3.5 w-3.5" />{t.expert.workRecord.tools.replace('{count}', String(toolCalls))}</span><span className="ml-3 inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{duration(elapsed)}</span><span className="ml-3">{t.expert.workRecord.iterations.replace('{count}', String(agent.iterations))}</span></RecordSection>
            <RecordSection title={t.expert.workRecord.output} testId="agent-work-output"><pre className="whitespace-pre-wrap break-words font-sans text-zinc-200">{output || t.expert.workRecord.noOutput}</pre>{record?.finalOutputTruncated && record.finalOutputArchiveItemId ? <div className="mt-2 flex items-center gap-2 text-xs text-amber-300"><span>{t.expert.workRecord.archived}</span><button /* ds-allow:button: 归档入口与截断提示同一紧凑行 */ type="button" onClick={() => openWorkspacePreview(record.finalOutputArchiveItemId)} className="text-violet-300 hover:text-violet-100">{t.expert.workRecord.openArchive}</button></div> : null}</RecordSection>
            <RecordSection title={t.expert.workRecord.usage} testId="agent-work-usage"><span className="inline-flex items-center gap-1"><Zap className="h-3.5 w-3.5" />{tokens}</span><span className="ml-3">${cost.toFixed(4)}</span></RecordSection>
          </>}
        </div>
      </section>
    </Modal>
  );
};

const RecordSection: React.FC<{ title: string; testId: string; children: React.ReactNode }> = ({ title, testId, children }) => <section data-testid={testId}><h3 className="mb-1 text-xs font-medium text-zinc-400">{title}</h3><div className="rounded-lg bg-zinc-950/60 px-3 py-2 text-xs leading-relaxed text-zinc-300">{children}</div></section>;
