import React, { useState } from 'react';
import { GitBranch, ChevronDown, ChevronRight } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { SwarmLaunchRequest, SwarmLaunchTaskPreview } from '@shared/contract/swarm';
import ipcService from '../../../services/ipcService';

// 给每个 agent 分配一种稳定颜色（按 task.id hash），让用户像 Codex 截图里
// "Heisenberg (绿) / Rawls (紫)" 那样一眼区分不同 worker。
const AGENT_COLORS = [
  'text-emerald-400',
  'text-purple-400',
  'text-cyan-400',
  'text-amber-400',
  'text-pink-400',
  'text-blue-400',
] as const;

function agentColorFor(taskId: string): string {
  let hash = 0;
  for (let i = 0; i < taskId.length; i++) {
    hash = (hash * 31 + taskId.charCodeAt(i)) | 0;
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

// Codex-style 完整 prompt 展示行，默认折叠 4 行，可点击展开看完整。
const TaskPromptBlock: React.FC<{ task: SwarmLaunchTaskPreview; colorClass: string }> = ({ task, colorClass }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="mt-1.5 flex items-start gap-1 text-left text-zinc-400 hover:text-zinc-200 transition-colors w-full"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={12} className="mt-0.5 flex-shrink-0" /> : <ChevronRight size={12} className="mt-0.5 flex-shrink-0" />}
        <span className="text-[11px]">
          Created <span className={`font-semibold ${colorClass}`}>{task.role}</span> with the instructions
        </span>
      </button>
      <div className={`mt-1.5 text-xs leading-5 text-zinc-400 whitespace-pre-wrap ${expanded ? '' : 'line-clamp-4'}`}>
        {task.task}
      </div>
    </div>
  );
};

export const LaunchRequestCard: React.FC<{ request: SwarmLaunchRequest }> = ({ request }) => {
  const [feedback, setFeedback] = useState(request.feedback || '');
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const badgeClass =
    request.status === 'pending'
      ? 'bg-amber-500/15 text-amber-300'
      : request.status === 'approved'
        ? 'bg-emerald-500/15 text-emerald-300'
        : 'bg-red-500/15 text-red-300';

  const handleApprove = async () => {
    setSubmitting('approve');
    setError(null);
    try {
      const success = await ipcService.invoke(IPC_CHANNELS.SWARM_APPROVE_LAUNCH, {
        requestId: request.id,
        feedback: feedback.trim() || undefined,
      });
      if (!success) {
        setError('启动确认失败，当前请求可能已被处理。');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动确认失败');
    } finally {
      setSubmitting(null);
    }
  };

  const handleReject = async () => {
    const trimmed = feedback.trim();
    if (!trimmed) {
      setError('取消编排时需要填写原因。');
      return;
    }

    setSubmitting('reject');
    setError(null);
    try {
      const success = await ipcService.invoke(IPC_CHANNELS.SWARM_REJECT_LAUNCH, {
        requestId: request.id,
        feedback: trimmed,
      });
      if (!success) {
        setError('取消失败，当前请求可能已被处理。');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '取消失败');
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
      <div className="flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-primary-400" />
        <div className="text-sm text-zinc-100">并行编排启动确认</div>
        <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] ${badgeClass}`}>
          {request.status === 'pending' ? '待确认' : request.status === 'approved' ? '已启动' : '已取消'}
        </span>
      </div>

      <div className="mt-2 text-xs leading-5 text-zinc-400">{request.summary}</div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
          Agent <span className="ml-1 text-zinc-200">{request.agentCount}</span>
        </div>
        <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
          依赖 <span className="ml-1 text-cyan-300">{request.dependencyCount}</span>
        </div>
        <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
          写权限 <span className="ml-1 text-amber-300">{request.writeAgentCount}</span>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {request.tasks.map((task) => {
          const agentColor = agentColorFor(task.id);
          return (
            <div key={task.id} className="rounded-lg border border-white/[0.04] bg-zinc-900/70 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className={`rounded-full bg-zinc-700/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide font-semibold ${agentColor}`}>
                  {task.role}
                </span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                    task.writeAccess
                      ? 'bg-amber-500/15 text-amber-300'
                      : 'bg-emerald-500/15 text-emerald-300'
                  }`}
                >
                  {task.writeAccess ? '可写' : '只读'}
                </span>
                {task.dependsOn && task.dependsOn.length > 0 && (
                  <span className="text-[10px] text-cyan-300">
                    依赖 {task.dependsOn.join(', ')}
                  </span>
                )}
              </div>
              <TaskPromptBlock task={task} colorClass={agentColor} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {task.tools.slice(0, 4).map((tool) => (
                  <span
                    key={`${task.id}-${tool}`}
                    className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500"
                  >
                    {tool}
                  </span>
                ))}
                {task.tools.length > 4 && (
                  <span className="text-[10px] text-zinc-600">+{task.tools.length - 4}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {request.status === 'pending' && (
        <div className="mt-3 space-y-2">
          <textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="可选说明；取消编排时填写原因"
            className="min-h-[72px] w-full resize-y rounded-lg border border-zinc-700 bg-zinc-900/80 px-2.5 py-2 text-xs text-zinc-200 placeholder-zinc-600 outline-none transition-colors focus:border-primary-500/40"
          />
          {error && <div className="text-xs text-red-400">{error}</div>}
          <div className="flex items-center gap-2">
            <button
              onClick={handleApprove}
              disabled={submitting !== null}
              className="rounded-md bg-emerald-500/15 px-2.5 py-1.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting === 'approve' ? '启动中…' : '开始执行'}
            </button>
            <button
              onClick={handleReject}
              disabled={submitting !== null}
              className="rounded-md bg-red-500/15 px-2.5 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting === 'reject' ? '取消中…' : '取消编排'}
            </button>
          </div>
        </div>
      )}

      {request.feedback && request.status !== 'pending' && (
        <div className="mt-2 rounded bg-zinc-900/80 px-2 py-1.5 text-xs text-zinc-400">
          {request.feedback}
        </div>
      )}
    </div>
  );
};

export default LaunchRequestCard;
