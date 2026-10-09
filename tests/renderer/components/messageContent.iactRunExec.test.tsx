// @vitest-environment jsdom
// IACT !run 执行链路（N-IACT-RUN-EXEC-UI）：点击按钮 → agent 域 runInteractiveCommand
// （当前 sessionId + 载荷串逐字节原样，可见链接文字绝不参与），running / completed /
// refused / denied / failed 就地渲染在按钮下方；输出只存组件内存（零 store / storage
// 写入，重挂载即消失），且点击永远不会变成聊天消息（无 iact:run 监听、onSend 不动）。

import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import ipcService, { DomainInvokeError } from '../../../src/renderer/services/ipcService';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import { ChatInput } from '../../../src/renderer/components/features/chat/ChatInput';
import { runHref } from './encodeRunCommand';

// 每个用例重新 spyOn：afterEach 的 restoreAllMocks 会把 spy 还原回原实现，
// 模块级只建一次的 spy 在第二个用例起就与 ipcService 脱钩（假红）。
let runInvoke: Mock<typeof ipcService.invokeDomain>;

const COMPLETED = { status: 'completed' as const, output: 'ok', exitCode: 0 };
const COMMAND = ` echo "你好: (a)'b"*+x% `;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function makeSession(id: string): SessionWithMeta {
  return {
    id,
    title: id,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
  } as SessionWithMeta;
}

function resetCapabilityStore(): void {
  useBundledCapabilityStore.setState({
    installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
    states: [],
    loaded: true,
    error: null,
  });
}

async function renderRunCard(content: string) {
  const utils = render(<MessageContent content={content} isUser={false} messageId="assistant-1" />);
  const commandEl = await waitFor(() => {
    const el = utils.container.querySelector('[data-iact-run-command], [data-iact-run-inert]');
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  const button = commandEl.parentElement?.querySelector('button') as HTMLButtonElement | null;
  expect(button).toBeTruthy();
  return { ...utils, button: button as HTMLButtonElement };
}

describe('IACT !run 执行链路', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [makeSession('session-1')], currentSessionId: 'session-1', messages: [] });
    resetCapabilityStore();
    runInvoke = vi.spyOn(ipcService, 'invokeDomain').mockResolvedValue(COMPLETED);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [] });
  });

  // (a) 载荷逐字节原样 + 当前 sessionId；链接文字绝不是发送内容
  it('click calls runInteractiveCommand once with the byte-exact payload and session id', async () => {
    const { button } = await renderRunCard(`[运行这段](${runHref(COMMAND)})`);

    fireEvent.click(button);
    await waitFor(() => expect(runInvoke).toHaveBeenCalledTimes(1));
    expect(runInvoke.mock.calls[0]).toHaveLength(3);
    expect(runInvoke.mock.calls[0][0]).toBe(IPC_DOMAINS.AGENT);
    expect(runInvoke.mock.calls[0][1]).toBe('runInteractiveCommand');
    expect(runInvoke.mock.calls[0][2]).toEqual({ sessionId: 'session-1', command: COMMAND });
  });

  it('when link text differs from the payload, the link text is never what is sent', async () => {
    const label = '查看类型检查';
    const command = 'npm run typecheck';
    const { button } = await renderRunCard(`[${label}](${runHref(command)})`);

    fireEvent.click(button);
    await waitFor(() => expect(runInvoke).toHaveBeenCalledTimes(1));
    const payload = runInvoke.mock.calls[0][2] as { sessionId: string; command: string };
    expect(payload).toEqual({ sessionId: 'session-1', command });
    expect(payload.command).not.toBe(label);
    expect(JSON.stringify(payload.command)).toBe(JSON.stringify(command));
  });

  // (b) 五态就地渲染
  it('renders the running state with approval hint and a disabled button', async () => {
    const gate = deferred<unknown>();
    runInvoke.mockReturnValue(gate.promise as Promise<never>);
    const { button, container } = await renderRunCard(`[跑](${runHref('sleep 1')})`);

    fireEvent.click(button);
    await waitFor(() => expect(container.querySelector('[data-iact-run-status="running"]')).toBeTruthy());
    expect(container.textContent).toContain('运行中…');
    expect(container.textContent).toContain('如需确认，会先弹出审批卡片');
    expect((container.querySelector('[data-iact-run-status="running"]') as HTMLElement).textContent).toContain('运行中…');
    expect(button.disabled).toBe(true);
    expect(container.querySelector('[data-iact-run-output]')).toBeNull();

    gate.resolve(COMPLETED);
    await waitFor(() => expect(container.querySelector('[data-iact-run-status="completed"]')).toBeTruthy());
    expect(button.disabled).toBe(false);
  });

  it('renders completed with output and exit code; non-zero exit is failed-style', async () => {
    runInvoke.mockResolvedValue({ status: 'completed', output: '第一行\n第二行', exitCode: 0 });
    const { button, container } = await renderRunCard(`[跑](${runHref('echo ok')})`);

    fireEvent.click(button);
    await waitFor(() => expect(container.querySelector('[data-iact-run-status="completed"]')).toBeTruthy());
    const output = container.querySelector('[data-iact-run-output]') as HTMLElement;
    expect(output.textContent).toBe('第一行\n第二行');
    expect(output.className).toContain('max-h-');
    expect(output.className).toContain('overflow-auto');
    expect(container.querySelector('[data-iact-run-exit="0"]')?.textContent).toContain('退出码 0');
    expect((container.querySelector('[data-iact-run-status="completed"]') as HTMLElement).querySelector('.text-badge-danger')).toBeNull();

    // 非零退出码：按 failed 样式呈现
    runInvoke.mockResolvedValue({ status: 'completed', output: 'boom', exitCode: 2 });
    fireEvent.click(button);
    await waitFor(() => expect(container.querySelector('[data-iact-run-exit="2"]')).toBeTruthy());
    const failedStatusRow = container.querySelector('[data-iact-run-status="completed"]') as HTMLElement;
    expect(failedStatusRow.querySelector('.text-badge-danger')).toBeTruthy();
    expect(failedStatusRow.querySelector('[data-iact-run-exit="2"]')?.textContent).toContain('退出码 2');
  });

  it.each([
    ['refused', '命令被安全规则拦下', '未执行：被安全规则拦下'],
    ['denied', '你在审批卡上点了拒绝', '已拒绝：这次没有执行'],
    ['failed', '进程启动失败', '运行失败'],
  ] as const)('renders %s with its reason', async (status, reason, label) => {
    runInvoke.mockResolvedValue({ status, output: '', reason });
    const { button, container } = await renderRunCard(`[跑](${runHref('whatever')})`);

    fireEvent.click(button);
    await waitFor(() => expect(container.querySelector(`[data-iact-run-status="${status}"]`)).toBeTruthy());
    expect(container.textContent).toContain(label);
    expect(container.querySelector('[data-iact-run-reason]')?.textContent).toBe(reason);
  });

  it('renders any output alongside a failure status', async () => {
    runInvoke.mockResolvedValue({ status: 'failed', output: '跑了半截的输出', reason: '超时' });
    const { button, container } = await renderRunCard(`[跑](${runHref('slow.sh')})`);

    fireEvent.click(button);
    await waitFor(() => expect(container.querySelector('[data-iact-run-status="failed"]')).toBeTruthy());
    expect(container.textContent).toContain('运行失败');
    expect(container.querySelector('[data-iact-run-reason]')?.textContent).toBe('超时');
    expect(container.querySelector('[data-iact-run-output]')?.textContent).toBe('跑了半截的输出');
  });

  it('a rejected IPC promise renders failed with the error message', async () => {
    runInvoke.mockRejectedValue(new Error('IPC 通道断了'));
    const { button, container } = await renderRunCard(`[跑](${runHref('echo hi')})`);

    fireEvent.click(button);
    await waitFor(() => expect(container.querySelector('[data-iact-run-status="failed"]')).toBeTruthy());
    expect(container.querySelector('[data-iact-run-reason]')?.textContent).toBe('IPC 通道断了');
  });

  it('a new click after finish re-runs and replaces the previous output', async () => {
    runInvoke.mockResolvedValueOnce({ status: 'completed', output: '旧输出', exitCode: 0 });
    const { button, container } = await renderRunCard(`[跑](${runHref('echo hi')})`);

    fireEvent.click(button);
    await waitFor(() => expect(container.querySelector('[data-iact-run-output]')?.textContent).toBe('旧输出'));

    runInvoke.mockResolvedValueOnce({ status: 'completed', output: '新输出', exitCode: 0 });
    fireEvent.click(button);
    await waitFor(() => expect(container.querySelector('[data-iact-run-output]')?.textContent).toBe('新输出'));
    expect(container.textContent).not.toContain('旧输出');
    expect(runInvoke).toHaveBeenCalledTimes(2);
  });

  // (c) running 期间双击只发起一次
  it('double click while running invokes only once', async () => {
    const gate = deferred<unknown>();
    runInvoke.mockReturnValue(gate.promise as Promise<never>);
    const { button } = await renderRunCard(`[跑](${runHref('sleep 5')})`);

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(runInvoke).toHaveBeenCalledTimes(1);

    gate.resolve(COMPLETED);
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  // (d) 没有当前会话：不发 IPC，就地 refused
  it('no session id means no IPC call and an in-place refused state', async () => {
    useSessionStore.setState({ currentSessionId: null });
    const { button, container } = await renderRunCard(`[跑](${runHref('echo hi')})`);

    fireEvent.click(button);
    await waitFor(() => expect(container.querySelector('[data-iact-run-status="refused"]')).toBeTruthy());
    expect(container.querySelector('[data-iact-run-reason]')?.textContent).toContain('当前没有进行中的会话');
    expect(runInvoke).not.toHaveBeenCalled();
  });

  // (e) 输出只在内存：零 storage / store 写入，重挂载即消失
  it('persists nothing: zero storage and store writes, output gone after remount', async () => {
    runInvoke.mockResolvedValue({ status: 'completed', output: '不留痕的输出', exitCode: 0 });
    const first = await renderRunCard(`[跑](${runHref('echo hi')})`);

    const localSetItem = vi.spyOn(window.localStorage, 'setItem');
    const sessionSetItem = vi.spyOn(window.sessionStorage, 'setItem');
    // 会话与消息同库（sessionStore 同时持有 sessions 与 messages），setState 一并盯住
    const storeSetState = vi.spyOn(useSessionStore, 'setState');
    try {
      fireEvent.click(first.button);
      await waitFor(() => expect(first.container.querySelector('[data-iact-run-output]')?.textContent).toBe('不留痕的输出'));
      expect(localSetItem).not.toHaveBeenCalled();
      expect(sessionSetItem).not.toHaveBeenCalled();
      expect(storeSetState).not.toHaveBeenCalled();
    } finally {
      localSetItem.mockRestore();
      sessionSetItem.mockRestore();
      storeSetState.mockRestore();
    }

    first.unmount();
    const second = await renderRunCard(`[跑](${runHref('echo hi')})`);
    expect(second.container.querySelector('[data-iact-run-output]')).toBeNull();
    expect(second.container.querySelector('[data-iact-run-status]')).toBeNull();
    expect(second.container.querySelector('[data-iact-run-command]')?.textContent).toBe('echo hi');
  });

  // (f) 点击永不变成聊天消息：没有 iact:run 监听，onSend 不被调用
  it('clicking never sends a chat message and no iact:run listener exists', async () => {
    // ChatInput 挂载还会发别的域读（agent tree 等）：按 jsdom 下的真实形状拒掉
    // （DomainInvokeError，与真 ipcService 在无 domainAPI 时一致），只放行本测试
    // 关心的两条，避免把「运行结果」灌进无关读取把渲染图弄崩。
    runInvoke.mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') return Promise.resolve([]);
      if (domain === IPC_DOMAINS.AGENT && action === 'runInteractiveCommand') return Promise.resolve(COMPLETED);
      return Promise.reject(new DomainInvokeError('INTERNAL_ERROR', `${domain}:${action} failed`));
    });
    const onSend = vi.fn(() => true);
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    const view = render(
      <>
        <ChatInput onSend={onSend} />
        <MessageContent content={`[跑一下](${runHref('echo hi')})`} isUser={false} messageId="assistant-1" />
      </>,
    );
    const commandEl = await waitFor(() => {
      const el = view.container.querySelector('[data-iact-run-command]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const button = commandEl.parentElement?.querySelector('button') as HTMLButtonElement;
    expect(button).toBeTruthy();

    expect(addEventListenerSpy.mock.calls.filter(([type]) => type === 'iact:run')).toHaveLength(0);
    fireEvent.click(button);
    await waitFor(() => expect(view.container.querySelector('[data-iact-run-status="completed"]')).toBeTruthy());

    // 事件桥已拆：就算有人手动补发 iact:run，也不会有任何监听把它变成聊天消息
    window.dispatchEvent(new CustomEvent('iact:run', { detail: 'echo injected' }));
    const runCalls = runInvoke.mock.calls.filter(([, action]) => action === 'runInteractiveCommand');
    expect(runCalls).toHaveLength(1);
    expect(onSend).not.toHaveBeenCalled();
    addEventListenerSpy.mockRestore();
  });
});
