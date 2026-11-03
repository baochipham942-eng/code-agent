// @vitest-environment jsdom
// N-STOP-ABANDON-ENTRY：停靠（user_stop 等）待「继续」的 run 在 resume-notice 行里加「放弃」。
// 这里钉的是渲染层契约：行何时出现、模态先于 IPC、确认才终态化、投影翻终态后行消失。
// 装配方式镜像 ChatView 的接线（同 durableResume.continueState.test.tsx 的 ParkedComposer 先例），
// composer 核心键（Stop/Continue）不在本单改动面，⑤ 只钉「没多出新的 composer 按钮」。
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipcInvoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: ipcInvoke, invokeDomain: vi.fn(async () => undefined) },
  invoke: ipcInvoke,
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: toastError },
}));

import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useI18n } from '../../../src/renderer/hooks/useI18n';
import {
  DurableResumeNotice,
  useAbandonParkedRun,
  useDurableContinueVisible,
} from '../../../src/renderer/components/features/chat/durableResume';
import { SendButton } from '../../../src/renderer/components/features/chat/ChatInput/SendButton';

const SESSION_ID = 'session-parked';
const PARKED = { mode: 'continue', canContinue: true, runId: 'run-parked-1' };

// 与 ChatView 相同的接线：mode 行 + 停靠行（带放弃）+ confirmDialog + composer。
function ParkedRow({ resume, turnActive }: {
  resume: { mode: string; canContinue: boolean; runId?: string } | undefined;
  turnActive: boolean;
}) {
  const { t } = useI18n();
  const show = useDurableContinueVisible(resume, turnActive);
  const abandon = useAbandonParkedRun(SESSION_ID, resume?.runId);
  return (
    <>
      {resume?.mode === 'auto-resuming' && <DurableResumeNotice text={t.chat.durableResumeNotice} />}
      {resume?.mode === 'queued' && <DurableResumeNotice text={t.chat.durableResumeQueuedNotice} />}
      {show && (
        <DurableResumeNotice text={t.chat.durableStoppedNotice} actions={
          <button type="button" className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200" onClick={abandon.onAbandon}>{t.chat.durableAbandon}</button>
        } />
      )}
      {abandon.confirmDialog}
      <SendButton hasContinuation={show} isProcessing={turnActive} onContinue={() => undefined} onStop={() => undefined} />
    </>
  );
}

function dialogConfirmButton(): HTMLElement {
  const dialog = screen.getByRole('dialog');
  return screen.getAllByRole('button', { name: /^(放弃|Abandon)$/ })
    .find((button) => dialog.contains(button))!;
}

describe('abandon entry in the durable resume notice row', () => {
  let loadSessions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    loadSessions = vi.fn(async () => undefined);
    useSessionStore.setState({ loadSessions } as never);
    ipcInvoke.mockReset().mockResolvedValue(undefined);
    toastError.mockClear();
  });

  it('① parked row carries the abandon button only for idle continue+canContinue; other modes show no abandon; active turn / not continuable hide the row', () => {
    const { rerender } = render(<ParkedRow resume={PARKED} turnActive={false} />);
    expect(screen.getAllByTestId('durable-resume-notice')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^(放弃|Abandon)$/ })).toBeTruthy();

    rerender(<ParkedRow resume={{ mode: 'auto-resuming', canContinue: false }} turnActive={false} />);
    expect(screen.getAllByTestId('durable-resume-notice')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^(放弃|Abandon)$/ })).toBeNull();

    rerender(<ParkedRow resume={{ mode: 'queued', canContinue: false }} turnActive={false} />);
    expect(screen.getAllByTestId('durable-resume-notice')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^(放弃|Abandon)$/ })).toBeNull();

    // 活跃轮（Stop 显示中）：停靠行整行不出现
    rerender(<ParkedRow resume={PARKED} turnActive={true} />);
    expect(screen.queryByTestId('durable-resume-notice')).toBeNull();
    expect(screen.queryByRole('button', { name: /^(放弃|Abandon)$/ })).toBeNull();

    // canContinue=false：同样不出现
    rerender(<ParkedRow resume={{ mode: 'continue', canContinue: false, runId: 'run-parked-1' }} turnActive={false} />);
    expect(screen.queryByTestId('durable-resume-notice')).toBeNull();
  });

  it('② abandon opens the danger modal and no cancel IPC fires; dialog Cancel closes it, still no IPC', () => {
    render(<ParkedRow resume={PARKED} turnActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^(放弃|Abandon)$/ }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/放弃这个已停止的任务|Abandon this stopped task/);
    // danger 变体：confirm 钮走 BUTTON_DANGER_CLASS（红底），不是 primary/warning
    expect(dialogConfirmButton().className).toContain('bg-red-600');
    expect(ipcInvoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^(取消|Cancel)$/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(ipcInvoke).not.toHaveBeenCalled();
  });

  it('③ confirm cancels exactly once with sessionId+runId then refreshes sessions; a rejected IPC toasts and the row stays', async () => {
    const { rerender } = render(<ParkedRow resume={PARKED} turnActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^(放弃|Abandon)$/ }));
    fireEvent.click(dialogConfirmButton());

    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledTimes(1));
    expect(ipcInvoke).toHaveBeenCalledWith('agent:cancel', { sessionId: SESSION_ID, runId: 'run-parked-1' });
    await waitFor(() => expect(loadSessions).toHaveBeenCalledWith({ silent: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('durable-resume-notice')).toBeTruthy();

    // IPC 拒绝：toast.error 带原始 message，停靠行不动（投影没翻终态）
    ipcInvoke.mockRejectedValueOnce(new Error('cancel route down'));
    rerender(<ParkedRow resume={PARKED} turnActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^(放弃|Abandon)$/ }));
    fireEvent.click(dialogConfirmButton());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('cancel route down'));
    expect(screen.getByTestId('durable-resume-notice')).toBeTruthy();
  });

  it('④ once the refreshed projection has no durableResume the row and abandon button disappear', () => {
    const { rerender } = render(<ParkedRow resume={PARKED} turnActive={false} />);
    expect(screen.getByTestId('durable-resume-notice')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^(放弃|Abandon)$/ })).toBeTruthy();

    rerender(<ParkedRow resume={undefined} turnActive={false} />);
    expect(screen.queryByTestId('durable-resume-notice')).toBeNull();
    expect(screen.queryByRole('button', { name: /^(放弃|Abandon)$/ })).toBeNull();
  });

  it('⑤ composer core actions unchanged: parked renders Continue, active turn renders Stop, abandon never lives in the composer', () => {
    const { rerender } = render(<ParkedRow resume={PARKED} turnActive={false} />);
    const composerContinue = screen.getByTestId('continue-run-button');
    expect(composerContinue).toBeTruthy();
    // 放弃钮挂在 notice 行内，不在 composer 按钮位上
    expect(composerContinue.closest('[data-testid="durable-resume-notice"]')).toBeNull();
    expect(screen.getByRole('button', { name: /^(放弃|Abandon)$/ }).closest('[data-testid="durable-resume-notice"]')).not.toBeNull();

    rerender(<ParkedRow resume={PARKED} turnActive={true} />);
    expect(screen.queryByTestId('continue-run-button')).toBeNull();
    expect(screen.getByRole('button', { name: /^(停止|Stop)$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(放弃|Abandon)$/ })).toBeNull();
  });
});
