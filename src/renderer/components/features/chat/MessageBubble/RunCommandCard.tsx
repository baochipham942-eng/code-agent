// ============================================================================
// RunCommandCard - IACT `!run` 载荷卡：展示 + 点击就地执行（N-IACT-RUN-EXEC-UI）
// ============================================================================
// - 点击走 agent 域 IPC `runInteractiveCommand`（真 Bash 管道 + 审批卡，见
//   src/host/app/interactiveRunCommand.ts），不再 dispatch iact:run、不再发聊天消息；
// - 载荷串原样下发（不 trim、不改写），可见链接文字永远不参与执行；
// - 输出只存组件 state（业主拍板 in-memory only）：不进 store / localStorage /
//   消息模型，重挂载即消失；
// - 裸 !run / 坏编码 / 空 cmd：不渲染按钮，只留等宽纯文本（旧消息 fail-closed）。

import { useState } from 'react';
import { Loader2, Terminal } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { useSessionStore } from '../../../../stores/sessionStore';

/** host 侧 runInteractiveCommand 的返回形状（src/host/app/interactiveRunCommand.ts） */
interface InteractiveRunResult {
  status: 'completed' | 'refused' | 'denied' | 'failed';
  output: string;
  exitCode?: number;
  reason?: string;
}

type RunCardPhase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'finished'; result: InteractiveRunResult };

/** IPC data 不可信（跨进程边界），按字段收窄，坏形状归 failed */
function normalizeRunResult(value: unknown): InteractiveRunResult {
  if (!value || typeof value !== 'object') {
    return { status: 'failed', output: '', reason: 'unexpected host response' };
  }
  const raw = value as Partial<InteractiveRunResult>;
  const status = raw.status === 'completed' || raw.status === 'refused'
    || raw.status === 'denied' || raw.status === 'failed' ? raw.status : 'failed';
  return {
    status,
    output: typeof raw.output === 'string' ? raw.output : '',
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
  };
}

export function RunCommandCard({ command, label }: { command: string | null; label?: string }) {
  const { t } = useI18n();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const [phase, setPhase] = useState<RunCardPhase>({ kind: 'idle' });

  if (command === null) {
    return (
      <span className="whitespace-pre-wrap break-all font-mono text-xs text-zinc-400" data-iact-run-inert="">{label ?? ''}</span>
    );
  }

  const handleRun = () => {
    if (phase.kind === 'running') return;
    // 没有当前会话就没有审批链可挂，直接就地 refused，不碰 IPC
    if (!currentSessionId) {
      setPhase({
        kind: 'finished',
        result: { status: 'refused', output: '', reason: t.deliveryExperience.runNoSession },
      });
      return;
    }
    const sessionId = currentSessionId;
    setPhase({ kind: 'running' });
    void (async () => {
      try {
        const data = await ipcService.invokeDomain<InteractiveRunResult>(
          IPC_DOMAINS.AGENT,
          'runInteractiveCommand',
          { sessionId, command },
        );
        setPhase({ kind: 'finished', result: normalizeRunResult(data) });
      } catch (error) {
        // IPC 层拒绝（DomainInvokeError 等）按 failed 呈现，错误消息透传
        setPhase({
          kind: 'finished',
          result: { status: 'failed', output: '', reason: error instanceof Error ? error.message : String(error) },
        });
      }
    })();
  };

  const finished = phase.kind === 'finished' ? phase.result : null;
  // completed 且退出码非零：命令跑过了但没跑成，按 failed 样式呈现退出码行
  const exitFailed = finished?.status === 'completed' && (finished.exitCode ?? 0) !== 0;
  const statusText = finished
    ? finished.status === 'completed' ? t.deliveryExperience.runStateCompleted
      : finished.status === 'refused' ? t.deliveryExperience.runStateRefused
      : finished.status === 'denied' ? t.deliveryExperience.runStateDenied
      : t.deliveryExperience.runStateFailed
    : null;

  return (
    <span className="my-2 inline-flex max-w-full flex-col gap-2 rounded-lg border border-zinc-700 bg-zinc-900 p-3 align-top">
      {label !== undefined && label !== command && (
        <span className="whitespace-pre-wrap break-all text-xs text-zinc-500" data-iact-run-label="">{label}</span>
      )}
      <span className="whitespace-pre-wrap break-all font-mono text-xs text-zinc-300" data-iact-run-command="">{command}</span>
      <button type="button" title={t.deliveryExperience.runHint} onClick={handleRun} disabled={phase.kind === 'running'}
        className="inline-flex w-fit items-center gap-2 rounded-md border border-zinc-600 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60">
        <Terminal className="h-3.5 w-3.5" />
        {/\bpython[23]?\b.*\.py\b/.test(command) ? t.deliveryExperience.runScript : t.deliveryExperience.runCommand}
      </button>
      {phase.kind === 'running' && (
        <span className="flex flex-col gap-0.5 text-xs" data-iact-run-status="running">
          <span className="flex items-center gap-1.5 text-zinc-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t.deliveryExperience.runStateRunning}
          </span>
          <span className="text-zinc-500">{t.deliveryExperience.runApprovalPending}</span>
        </span>
      )}
      {finished && (
        <span className="flex flex-col gap-1 text-xs" data-iact-run-status={finished.status}>
          <span className={exitFailed ? 'font-medium text-badge-danger' : 'font-medium text-zinc-300'}>
            {statusText}
            {finished.status === 'completed' && finished.exitCode !== undefined && (
              <span className="ml-1.5 text-zinc-500" data-iact-run-exit={finished.exitCode}>
                {t.deliveryExperience.runExitCode.replace('{code}', String(finished.exitCode))}
              </span>
            )}
          </span>
          {finished.reason !== undefined && finished.reason !== '' && (
            <span className="whitespace-pre-wrap break-all text-zinc-400" data-iact-run-reason="">{finished.reason}</span>
          )}
          {finished.output !== '' && (
            <span className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-300" data-iact-run-output="">{finished.output}</span>
          )}
        </span>
      )}
    </span>
  );
}
