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
import { GitBranch, ChevronUp, ChevronDown, Loader2, Check, X, Circle, MinusCircle } from 'lucide-react';
import { useWorkflowStore } from '../../../stores/workflowStore';
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
    if (buckets.has(phase)) {
      ordered.push({ phase, agents: buckets.get(phase)! });
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
  const activeRunId = useWorkflowStore((s) => s.activeRunId);
  const snap = useWorkflowStore((s) => (activeRunId ? s.runs[activeRunId] : undefined));
  const [collapsed, setCollapsed] = useState(false);

  if (!snap) return null;
  // running / failed 显示（失败保留报错可见）；completed / cancelled / pending 不显示。
  if (snap.status !== 'running' && snap.status !== 'failed') return null;

  const groups = groupByPhase(snap);
  const durationSec = snap.startedAt
    ? Math.max(0, Math.round(((snap.finishedAt ?? Date.now()) - snap.startedAt) / 1000))
    : undefined;

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
