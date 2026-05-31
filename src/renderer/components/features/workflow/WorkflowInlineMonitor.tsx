// ============================================================================
// WorkflowInlineMonitor —— dynamic-workflow 进度树（消息流底部 sticky 浮层，P3a）
// ============================================================================
// 对标 Claude Code 的 /workflows 进度树：把 scriptRuntime 后台 run 的 ScriptRunEvent
// 流（经 'workflow:event' 通道 → workflowStore 折叠成 ScriptRunSnapshot）渲染成
// 「phase 分组 → 子 agent 5 态」的可见进度。与 SwarmInlineMonitor 并列挂在 ChatInput
// 之上，跟随消息流，不强迫用户切屏。
//
// 仅在有活跃（running）或失败（保留报错可见）的 workflow run 时渲染，不污染普通对话；
// 成功/取消的 run 收尾后隐藏（最终结果已进聊天）。多 run 时显示 activeRunId 指向的当前 run。
// ============================================================================

import React, { useState } from 'react';
import { GitBranch, ChevronUp, ChevronDown, Loader2, Check, X, Circle, MinusCircle, Zap, Square } from 'lucide-react';
import { useWorkflowStore } from '../../../stores/workflowStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import type { ScriptRunAgentSnapshot, ScriptRunAgentStatus, ScriptRunSnapshot } from '@shared/contract/scriptRun';

const NO_PHASE = '__no_phase__';

function StatusIcon({ status }: { status: ScriptRunAgentStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 size={12} className="text-emerald-400 animate-spin shrink-0" />;
    case 'done':
      return <Check size={12} className="text-zinc-500 shrink-0" />;
    case 'error':
      return <X size={12} className="text-red-400 shrink-0" />;
    case 'skipped':
      return <MinusCircle size={12} className="text-zinc-600 shrink-0" />;
    case 'queued':
    default:
      return <Circle size={12} className="text-amber-400 shrink-0" />;
  }
}

/** 把 agents 按 phase 分组，保持 snapshot.phases 的声明顺序，无 phase 的归 NO_PHASE 末组。 */
function groupByPhase(snap: ScriptRunSnapshot): Array<{ phase: string; agents: ScriptRunAgentSnapshot[] }> {
  const buckets = new Map<string, ScriptRunAgentSnapshot[]>();
  for (const a of snap.agents) {
    const key = a.phase ?? NO_PHASE;
    const arr = buckets.get(key) ?? [];
    arr.push(a);
    buckets.set(key, arr);
  }
  const ordered: Array<{ phase: string; agents: ScriptRunAgentSnapshot[] }> = [];
  for (const phase of snap.phases) {
    const agents = buckets.get(phase);
    if (agents) {
      ordered.push({ phase, agents });
      buckets.delete(phase);
    }
  }
  // phases 里没声明但 agent 自带的 phase（理论少见）+ 无 phase 桶，补在后面。
  for (const [phase, agents] of buckets) {
    ordered.push({ phase, agents });
  }
  return ordered;
}

export function WorkflowInlineMonitor() {
  // 会话隔离（Codex R1 HIGH#1）：只显示当前会话的 run，别串到别的会话视图。
  const currentSessionId = useSessionStore((s) => s.currentSessionId ?? undefined);
  // activeSnapshot 返回的快照对象在新事件到达时换引用 → Zustand 触发重渲染。
  const snap = useWorkflowStore((s) => s.activeSnapshot(currentSessionId));
  const [collapsed, setCollapsed] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  if (!snap) return null;
  // running / failed 显示（失败保留报错可见）；completed / cancelled / pending 不显示。
  if (snap.status !== 'running' && snap.status !== 'failed') return null;

  const groups = groupByPhase(snap);
  const durationSec = snap.startedAt
    ? Math.max(0, Math.round(((snap.finishedAt ?? Date.now()) - snap.startedAt) / 1000))
    : undefined;

  const handleCancel = async () => {
    if (cancelling || snap.status !== 'running') return;
    setCancelling(true);
    try {
      await ipcService.invoke(IPC_CHANNELS.WORKFLOW_CANCEL_RUN, {
        runId: snap.runId,
        sessionId: currentSessionId,
      });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="w-full shrink-0 px-4">
      <div className="mx-auto max-w-3xl rounded-lg border border-zinc-700/70 bg-zinc-900/95 backdrop-blur-sm shadow-xl text-xs">
        <div className="flex items-center gap-2 px-3 py-2">
          <GitBranch size={14} className={snap.status === 'failed' ? 'text-red-400' : 'text-cyan-400'} />
          <span className="text-zinc-300">workflow</span>
          {snap.goal && <span className="text-zinc-500 truncate max-w-[40%]" title={snap.goal}>· {snap.goal}</span>}
          <div className="ml-auto flex items-center gap-2 text-zinc-500">
            {snap.runningCount > 0 && <span className="text-emerald-400">{snap.runningCount} running</span>}
            {snap.doneCount > 0 && <span>{snap.doneCount} done</span>}
            {snap.errorCount > 0 && <span className="text-red-400">{snap.errorCount} error</span>}
            {durationSec !== undefined && <span>{durationSec}s</span>}
            {snap.status === 'running' && (
              <button
                type="button"
                onClick={handleCancel}
                disabled={cancelling}
                className="text-zinc-500 hover:text-red-300 disabled:opacity-50 transition-colors"
                title="取消 workflow"
              >
                <Square size={12} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-zinc-400 hover:text-zinc-200 transition-colors"
              title={collapsed ? '展开' : '折叠'}
            >
              {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </div>
        {!collapsed && (
          <div className="border-t border-zinc-700/40 max-h-64 overflow-y-auto py-1">
            {groups.length === 0 && (
              <div className="px-3 py-2 text-zinc-500 italic">
                {snap.currentPhase ? `phase: ${snap.currentPhase}` : '正在启动…'}
              </div>
            )}
            {groups.map(({ phase, agents }) => (
              <div key={phase} className="py-0.5">
                {phase !== NO_PHASE && (
                  <div className="px-3 py-1 text-zinc-500 font-medium uppercase tracking-wide text-[10px]">
                    {phase}
                  </div>
                )}
                {agents.map((a) => (
                  <WorkflowAgentRow key={a.id} agent={a} />
                ))}
              </div>
            ))}
            {snap.error && (
              <div className="px-3 py-1.5 text-red-400 border-t border-zinc-700/40 mt-1">
                {snap.error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkflowAgentRow({ agent }: { agent: ScriptRunAgentSnapshot }) {
  const detail = agent.status === 'error' ? agent.error : agent.resultPreview ?? agent.promptPreview;
  return (
    <div className="flex items-start gap-2 px-3 py-1 pl-5 hover:bg-zinc-800/40 transition-colors">
      <div className="pt-0.5">
        <StatusIcon status={agent.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`font-medium ${agent.status === 'error' ? 'text-red-300' : 'text-zinc-200'}`}>
            {agent.label}
          </span>
          {agent.model && <span className="text-zinc-600 text-[10px]">{agent.model}</span>}
          {agent.hasSchema && <span className="text-zinc-600 text-[10px]">judge</span>}
          {agent.cached && (
            <span
              className="inline-flex items-center gap-0.5 text-cyan-400/80 text-[10px]"
              title="resumable 重放命中缓存：结果来自上一次运行，未重新调用模型（0 token）"
            >
              <Zap size={9} className="shrink-0" />cached
            </span>
          )}
        </div>
        {detail && (
          <div className={`truncate ${agent.status === 'error' ? 'text-red-400/80' : 'text-zinc-500'}`} title={detail}>
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}
