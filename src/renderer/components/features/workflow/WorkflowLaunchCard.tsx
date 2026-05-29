// ============================================================================
// WorkflowLaunchCard —— dynamic-workflow 启动审批卡（P3b）
// ============================================================================
// workflow 跑前展示静态预览（phases / 扇出量 / 动写）+ 4 维度成本（费用/网络/上下文泄露/
// 后台占用），等用户 approve/reject。挂在消息流底部，仅有 pending 审批请求时显示。
// 决策经 IPC 回传 main 的 WorkflowLaunchApprovalGate（approve/reject → resolve workflow 工具）。
// ============================================================================

import React, { useState } from 'react';
import { GitBranch, Cpu, Globe, Shield, Clock, AlertTriangle } from 'lucide-react';
import { useWorkflowStore } from '../../../stores/workflowStore';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';

function DimensionRow({ icon, label, text, warn }: { icon: React.ReactNode; label: string; text: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2 px-3 py-1.5">
      <div className={`pt-0.5 ${warn ? 'text-amber-400' : 'text-zinc-500'}`}>{icon}</div>
      <div className="min-w-0 flex-1">
        <span className="text-zinc-400">{label}</span>
        <span className={`ml-2 ${warn ? 'text-amber-300' : 'text-zinc-300'}`}>{text}</span>
      </div>
    </div>
  );
}

export function WorkflowLaunchCard() {
  const request = useWorkflowStore((s) => s.pendingLaunchRequest());
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);

  if (!request) return null;

  const handleApprove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await ipcService.invoke(IPC_CHANNELS.WORKFLOW_APPROVE_LAUNCH, {
        requestId: request.id,
        feedback: feedback.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (busy) return;
    const reason = feedback.trim() || '用户取消';
    setBusy(true);
    try {
      await ipcService.invoke(IPC_CHANNELS.WORKFLOW_REJECT_LAUNCH, {
        requestId: request.id,
        feedback: reason,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full shrink-0 px-4">
      <div className="mx-auto max-w-3xl rounded-lg border border-cyan-700/50 bg-zinc-900/95 backdrop-blur-sm shadow-xl text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700/40">
          <GitBranch size={14} className="text-cyan-400" />
          <span className="text-zinc-200 font-medium">确认启动 workflow</span>
          {request.goal && <span className="text-zinc-500 truncate max-w-[45%]" title={request.goal}>· {request.goal}</span>}
        </div>

        {/* 静态预览：phases + 扇出量 */}
        <div className="px-3 py-2 border-b border-zinc-700/40 space-y-1.5">
          {request.phases.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-zinc-500">阶段</span>
              {request.phases.map((p) => (
                <span key={p} className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{p}</span>
              ))}
            </div>
          )}
          <div className="text-zinc-500">
            约 <span className="text-zinc-300">{request.estimatedAgentCalls}</span> 个子 agent 调用
            {request.fanoutSites > 0 && <> · <span className="text-zinc-300">{request.fanoutSites}</span> 处并行/流水扇出</>}
          </div>
        </div>

        {/* 4 维度 */}
        <div className="border-b border-zinc-700/40 py-1">
          <DimensionRow icon={<Cpu size={12} />} label="费用" text={request.dimensions.cost} warn={!request.budgetTokens} />
          <DimensionRow icon={<Globe size={12} />} label="网络" text={request.dimensions.network} />
          <DimensionRow icon={<Shield size={12} />} label="上下文" text={request.dimensions.contextLeak} />
          <DimensionRow icon={<Clock size={12} />} label="后台" text={request.dimensions.background} warn={request.writeHint} />
        </div>

        {request.writeHint && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-amber-300 border-b border-zinc-700/40">
            <AlertTriangle size={12} className="shrink-0" />
            <span>脚本含可写文件 / 跑命令的子 agent，并行写共享工作树有覆盖风险</span>
          </div>
        )}

        {/* 决策区 */}
        <div className="px-3 py-2 space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="可选说明（拒绝时作为原因）"
            rows={2}
            className="w-full resize-none rounded border border-zinc-700 bg-zinc-800/60 px-2 py-1 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleReject}
              disabled={busy}
              className="rounded border border-red-700/50 px-3 py-1 text-red-300 hover:bg-red-900/30 disabled:opacity-50 transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleApprove}
              disabled={busy}
              className="rounded bg-emerald-600/90 px-3 py-1 text-white hover:bg-emerald-600 disabled:opacity-50 transition-colors"
            >
              开始执行
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
