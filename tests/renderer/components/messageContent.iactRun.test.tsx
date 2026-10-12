// @vitest-environment jsdom
// IACT !run：按钮执行 href 载荷 `!run?cmd=<percent-encoded>`，不用可见链接文字。
// 裸 !run / 坏编码 / 空 cmd 不渲染按钮。点击后的执行链路（agent 域 runInteractiveCommand）
// 细测见 messageContent.iactRunExec.test.tsx；这里钉住载荷逐字节进 IPC。

import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import ipcService from '../../../src/renderer/services/ipcService';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { parseRunHref } from '../../../src/renderer/components/features/chat/MessageBubble/runHref';
import { encodeRunCommand, runHref } from './encodeRunCommand';

const { MessageContent } = await import(
  '../../../src/renderer/components/features/chat/MessageBubble/MessageContent'
);

// 每个用例重新 spyOn：mockRestore/restoreAllMocks 会把 spy 还原回原实现，
// 模块级只建一次的 spy 在下一个用例起就与 ipcService 脱钩（假红）。
let runInvoke: Mock<typeof ipcService.invokeDomain>;

async function renderAssistant(content: string) {
  const utils = render(<MessageContent content={content} isUser={false} messageId="assistant-1" />);
  await waitFor(() => {
    expect(utils.container.querySelector('[data-iact-run-command], [data-iact-run-inert]')).toBeTruthy();
  });
  return utils;
}

describe('IACT !run payload', () => {
  beforeEach(() => {
    useSessionStore.setState({ currentSessionId: 'session-1' });
    runInvoke = vi.spyOn(ipcService, 'invokeDomain')
      .mockResolvedValue({ status: 'completed', output: '', exitCode: 0 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useSessionStore.setState({ currentSessionId: null });
  });

  it('quotes, spaces, Chinese, colon, and parentheses round-trip into the run payload', async () => {
    const command = ` echo "你好: (a)'b"*+x% `;
    const { container } = await renderAssistant(`[运行这段](${runHref(command)})`);

    expect(container.querySelector('[data-iact-run-command]')?.textContent).toBe(command);
    const button = container.querySelector('button');
    expect(button).toBeTruthy();
    fireEvent.click(button as HTMLButtonElement);
    expect(runInvoke).toHaveBeenCalledTimes(1);
    expect(runInvoke).toHaveBeenCalledWith(IPC_DOMAINS.AGENT, 'runInteractiveCommand', {
      sessionId: 'session-1',
      command,
    });
  });

  it('label differing from payload sends and displays the payload, not the label', async () => {
    const label = '查看类型检查';
    const command = 'npm run typecheck';
    const { container } = await renderAssistant(`[${label}](${runHref(command)})`);

    expect(container.querySelector('[data-iact-run-label]')?.textContent).toBe(label);
    expect(container.querySelector('[data-iact-run-command]')?.textContent).toBe(command);
    const button = container.querySelector('button');
    expect(button).toBeTruthy();
    expect(button?.textContent).not.toContain(label);
    fireEvent.click(button as HTMLButtonElement);
    expect(runInvoke).toHaveBeenCalledTimes(1);
    const payload = runInvoke.mock.calls[0][2] as { sessionId: string; command: string };
    expect(payload).toEqual({ sessionId: 'session-1', command });
    expect(payload.command).not.toBe(label);
  });

  it('bare !run and malformed percent-encoding render no button', async () => {
    const cases = [
      '[运行](!run)',
      '[运行](!run?cmd=%ZZ)',
      '[运行](!run?cmd=%E4%B8)',
      '[运行](!run?cmd=)',
      '[运行](!run?foo=bar)',
    ];
    for (const content of cases) {
      runInvoke.mockClear();
      const { container } = await renderAssistant(content);
      expect(container.querySelector('button'), content).toBeNull();
      expect(container.querySelector('a'), content).toBeNull();
      expect(container.querySelector('[data-iact-run-command]'), content).toBeNull();
      expect(container.querySelector('[data-iact-run-inert]')?.textContent, content).toBe('运行');
      expect(runInvoke, content).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('encoder and parser round-trip without trimming or turning + into space', () => {
    const command = ` echo "你好: (a)'b"*+x% `;
    expect(parseRunHref(runHref(command))).toBe(command);
    expect(parseRunHref('!run')).toBeNull();
    expect(parseRunHref('!run?cmd=')).toBeNull();
    expect(parseRunHref('!run?cmd=%ZZ')).toBeNull();
    expect(parseRunHref(`!run?cmd=${encodeRunCommand('a+b')}`)).toBe('a+b');
  });
});
