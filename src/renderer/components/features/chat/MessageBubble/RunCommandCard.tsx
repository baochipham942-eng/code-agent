// ============================================================================
// RunCommandCard - IACT `!run` 载荷卡：展示 + 点击就地执行（N-IACT-RUN-EXEC-UI）
// ============================================================================
// - 点击走 agent 域 IPC `runInteractiveCommand`（真 Bash 管道 + 审批卡，见
//   src/host/app/interactiveRunCommand.ts），不再 dispatch iact:run、不再发聊天消息；
// - 载荷串原样下发（不 trim、不改写），可见链接文字永远不参与执行；
// - 执行状态存 runCommandState（内存 store，按 messageId+command 组合 key），
//   不落任何 storage / 消息模型：消息列表重渲染导致卡片 remount 也不丢
//   running/completed/output（2026-10-11 rework），页面刷新即清空；
// - 裸 !run / 坏编码 / 空 cmd：不渲染按钮，只留等宽纯文本（旧消息 fail-closed）。
// - 结果交接（N-IACT-RUN-HANDOFF-NEO）：completed/refused/failed 卡片多一个「发给 Neo」
//   按钮，点击把命令 + 运行情况组一条用户消息 dispatch iact:handoff（ChatInput 监听后
//   走普通发送路径，不套 chip 确认模板）；denied（用户自己拒的）与无会话的本地 refused
//   不给入口。交接状态存 handedOff（内存态，同 entries 一起刷新即清），双击只发一条。

import { Loader2, Send, Terminal } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { useSessionStore } from '../../../../stores/sessionStore';
import {
  markRunCommandHandedOff, refuseRunCommand, startRunCommand, useRunCommandHandedOff, useRunCommandPhase,
} from '../../../../stores/runCommandState';
import { Button } from '../../../primitives';
import { buildRunHandoffMessage, type RunHandoffStatus } from './runHandoffMessage';

export function RunCommandCard({ command, label, messageId }: { command: string | null; label?: string; messageId?: string }) {
  const { t } = useI18n();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const phase = useRunCommandPhase(messageId, command ?? '');
  const handedOff = useRunCommandHandedOff(messageId, command ?? '');

  if (command === null) {
    return (
      <span className="whitespace-pre-wrap break-all font-mono text-xs text-zinc-400" data-iact-run-inert="">{label ?? ''}</span>
    );
  }

  const handleRun = () => {
    if (phase.kind === 'running') return;
    // 没有当前会话就没有审批链可挂，直接就地 refused，不碰 IPC
    if (!currentSessionId) {
      refuseRunCommand(messageId, command, t.deliveryExperience.runNoSession, { noSession: true });
      return;
    }
    startRunCommand(messageId, command, currentSessionId);
  };

  const finished = phase.kind === 'finished' ? phase.result : null;
  // completed 且退出码非零：命令跑过了但没跑成，按 failed 样式呈现退出码行
  const exitFailed = finished?.status === 'completed' && (finished.exitCode ?? 0) !== 0;
  // denied 与无会话的本地 refused 没有可交接的内容：用户自己拒的 / 根本没挂上会话
  const handoffEligible = finished !== null
    && finished.status !== 'denied'
    && !(finished.status === 'refused' && finished.noSession === true);

  const handleHandoff = () => {
    if (!handoffEligible || finished === null) return;
    // 先在 store 落交接标记再派发：双击的同一 tick 里第二次调用返回 false，只发一条
    if (!markRunCommandHandedOff(messageId, command)) return;
    window.dispatchEvent(new CustomEvent('iact:handoff', {
      detail: buildRunHandoffMessage({
        command,
        // handoffEligible 已排除 denied 与无会话 refused，剩下正是三态
        status: finished.status as RunHandoffStatus,
        output: finished.output,
        exitCode: finished.exitCode,
        reason: finished.reason,
      }, t.deliveryExperience),
    }));
  };

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
          {handoffEligible && (
            <Button variant="secondary" size="sm" className="w-fit" data-iact-run-handoff=""
              title={t.deliveryExperience.runHandoffHint} disabled={handedOff} onClick={handleHandoff}
              leftIcon={<Send className="h-3.5 w-3.5" />}>
              {handedOff ? t.deliveryExperience.runHandoffSent : t.deliveryExperience.runHandoffButton}
            </Button>
          )}
        </span>
      )}
    </span>
  );
}
