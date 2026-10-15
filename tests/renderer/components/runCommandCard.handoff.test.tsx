// @vitest-environment jsdom
// `!run` 卡「发给 Neo」交接链路（N-IACT-RUN-HANDOFF-NEO）：
// - completed / refused / failed 卡片出现「发给 Neo」按钮；denied（用户自己拒的）、
//   无会话的本地 refused、idle、running 不出现；
// - 点击 dispatch 一条 iact:handoff（正文 = 命令 + 运行情况的汇报），ChatInput 监听后
//   onSend 走普通发送路径，不套 chip 确认模板（正文本身已是汇报，不是新指令）；
// - 双击只发一条（store 落交接标记在派发之前）；发过之后按钮变禁用的「已发给 Neo」；
//   重跑同一张卡重新放开交接入口；
// - 不点不发：跑完之后 onSend 零调用、零 iact:handoff 派发（无自动注入）。

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

const COMPLETED = { status: 'completed' as const, output: 'ok', exitCode: 0 };

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

// runCommandState 是 module 级单例：用例间不重置，靠唯一 messageId 保证组合 key 不串
let renderSeq = 0;

async function renderRunCard(content: string, messageId = `assistant-${++renderSeq}`) {
  const utils = render(<MessageContent content={content} isUser={false} messageId={messageId} />);
  const card = await waitFor(() => {
    const el = utils.container.querySelector('[data-iact-run-command], [data-iact-run-inert]');
    expect(el).toBeTruthy();
    return el?.parentElement as HTMLElement;
  });
  return { ...utils, card };
}

function handoffEvents(dispatchSpy: Mock): string[] {
  return dispatchSpy.mock.calls
    .map(([ev]) => ev as Event)
    .filter((ev) => ev.type === 'iact:handoff')
    .map((ev) => (ev as CustomEvent<string>).detail);
}

describe('!run 卡「发给 Neo」交接', () => {
  let runInvoke: Mock<typeof ipcService.invokeDomain>;
  let dispatchSpy: Mock<typeof window.dispatchEvent>;

  beforeEach(() => {
    useSessionStore.setState({ sessions: [makeSession('session-1')], currentSessionId: 'session-1', messages: [] });
    resetCapabilityStore();
    runInvoke = vi.spyOn(ipcService, 'invokeDomain').mockResolvedValue(COMPLETED);
    dispatchSpy = vi.spyOn(window, 'dispatchEvent');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [] });
  });

  async function runToFinish(card: HTMLElement, hostResult: unknown = COMPLETED): Promise<void> {
    runInvoke.mockResolvedValue(hostResult);
    const runButton = card.querySelector('button:not([data-iact-run-handoff])') as HTMLButtonElement;
    fireEvent.click(runButton);
    const status = (hostResult as { status: string }).status;
    await waitFor(() => expect(card.querySelector(`[data-iact-run-status="${status}"]`)).toBeTruthy());
  }

  it('completed 卡有「发给 Neo」；点击派发一条 iact:handoff，正文含命令/状态/输出；发后按钮禁用成「已发给 Neo」', async () => {
    const { card } = await renderRunCard(`[跑](${runHref('echo hi')})`);
    await runToFinish(card, { status: 'completed', output: 'hi 输出', exitCode: 0 });

    const handoff = card.querySelector('[data-iact-run-handoff]') as HTMLButtonElement;
    expect(handoff).toBeTruthy();
    expect(handoff.textContent).toContain('发给 Neo');
    expect(handoff.title).toContain('Neo');

    fireEvent.click(handoff);
    const details = handoffEvents(dispatchSpy);
    expect(details).toHaveLength(1);
    expect(details[0]).toContain('echo hi');
    expect(details[0]).toContain('已运行');
    expect(details[0]).toContain('退出码 0');
    expect(details[0]).toContain('hi 输出');

    await waitFor(() => expect(card.querySelector('[data-iact-run-handoff]')?.textContent).toContain('已发给 Neo'));
    expect((card.querySelector('[data-iact-run-handoff]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('双击只派发一条 iact:handoff', async () => {
    const { card } = await renderRunCard(`[跑](${runHref('echo hi')})`);
    await runToFinish(card);
    const handoff = card.querySelector('[data-iact-run-handoff]') as HTMLButtonElement;
    fireEvent.click(handoff);
    fireEvent.click(handoff);
    fireEvent.click(handoff);
    expect(handoffEvents(dispatchSpy)).toHaveLength(1);
  });

  it.each([
    ['refused', { status: 'refused', output: '', reason: '命中硬毙清单' }],
    ['failed', { status: 'failed', output: '半截输出', reason: '超时' }],
  ] as const)('%s 卡也有交接按钮，正文写明没跑成与原因', async (status, hostResult) => {
    const { card } = await renderRunCard(`[跑](${runHref('whatever')})`);
    await runToFinish(card, hostResult);
    const handoff = card.querySelector('[data-iact-run-handoff]') as HTMLButtonElement;
    expect(handoff).toBeTruthy();
    fireEvent.click(handoff);
    const [detail] = handoffEvents(dispatchSpy);
    expect(detail).toContain(status === 'refused' ? '未执行' : '运行失败');
    expect(detail).toContain('whatever');
    expect(detail).toContain(hostResult.reason);
  });

  it('denied 卡与无会话的本地 refused 卡没有交接按钮', async () => {
    const { card } = await renderRunCard(`[跑](${runHref('echo hi')})`);
    await runToFinish(card, { status: 'denied', output: '', reason: '用户点了拒绝' });
    expect(card.querySelector('[data-iact-run-handoff]')).toBeNull();

    useSessionStore.setState({ currentSessionId: null });
    const noSession = await renderRunCard(`[跑](${runHref('echo lonely')})`);
    const runButton = noSession.card.querySelector('button:not([data-iact-run-handoff])') as HTMLButtonElement;
    fireEvent.click(runButton);
    await waitFor(() => expect(noSession.card.querySelector('[data-iact-run-status="refused"]')).toBeTruthy());
    expect(noSession.card.querySelector('[data-iact-run-handoff]')).toBeNull();
    expect(handoffEvents(dispatchSpy)).toHaveLength(0);
  });

  it('idle 与 running 没有交接按钮（先跑完才有结果可交接）', async () => {
    const { card } = await renderRunCard(`[跑](${runHref('sleep 5')})`);
    expect(card.querySelector('[data-iact-run-handoff]')).toBeNull();

    let resolveRun!: (value: unknown) => void;
    runInvoke.mockReturnValue(new Promise((res) => { resolveRun = res; }) as Promise<never>);
    fireEvent.click(card.querySelector('button:not([data-iact-run-handoff])') as HTMLButtonElement);
    await waitFor(() => expect(card.querySelector('[data-iact-run-status="running"]')).toBeTruthy());
    expect(card.querySelector('[data-iact-run-handoff]')).toBeNull();

    resolveRun(COMPLETED);
    await waitFor(() => expect(card.querySelector('[data-iact-run-handoff]')).toBeTruthy());
  });

  it('重跑同一张卡：交接入口重新放开，新结果可以再发一次', async () => {
    const { card } = await renderRunCard(`[跑](${runHref('echo hi')})`);
    await runToFinish(card, { status: 'completed', output: '第一轮', exitCode: 0 });
    fireEvent.click(card.querySelector('[data-iact-run-handoff]') as HTMLButtonElement);
    expect(handoffEvents(dispatchSpy)).toHaveLength(1);
    await waitFor(() => expect(card.querySelector('[data-iact-run-handoff]')?.textContent).toContain('已发给 Neo'));

    await runToFinish(card, { status: 'completed', output: '第二轮', exitCode: 0 });
    const again = card.querySelector('[data-iact-run-handoff]') as HTMLButtonElement;
    await waitFor(() => expect(again.disabled).toBe(false));
    expect(again.textContent).toContain('发给 Neo');
    fireEvent.click(again);
    const details = handoffEvents(dispatchSpy);
    expect(details).toHaveLength(2);
    expect(details[1]).toContain('第二轮');
  });

  // ChatInput 端到端：跑完不点，onSend 零调用（无自动注入）；点了走普通发送路径，
  // 不套 chip 确认模板
  it('iact:handoff 进 ChatInput：点前 onSend 零调用，点击后一次，正文是汇报而非 chip 模板', async () => {
    runInvoke.mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') return Promise.resolve([]);
      if (domain === IPC_DOMAINS.AGENT && action === 'runInteractiveCommand') {
        return Promise.resolve({ status: 'completed', output: 'ls 的输出', exitCode: 0 });
      }
      return Promise.reject(new DomainInvokeError('INTERNAL_ERROR', `${domain}:${action} failed`));
    });
    const onSend = vi.fn(() => true);

    const view = render(
      <>
        <ChatInput onSend={onSend} />
        <MessageContent content={`[跑](${runHref('ls -la')})`} isUser={false} messageId="assistant-handoff-e2e" />
      </>,
    );
    const card = await waitFor(() => {
      const el = view.container.querySelector('[data-iact-run-command]');
      expect(el).toBeTruthy();
      return el.parentElement as HTMLElement;
    });

    const runButton = card.querySelector('button:not([data-iact-run-handoff])') as HTMLButtonElement;
    fireEvent.click(runButton);
    await waitFor(() => expect(card.querySelector('[data-iact-run-status="completed"]')).toBeTruthy());

    // 跑完没点「发给 Neo」：什么都没进对话
    expect(onSend).not.toHaveBeenCalled();
    expect(handoffEvents(dispatchSpy)).toHaveLength(0);

    fireEvent.click(card.querySelector('[data-iact-run-handoff]') as HTMLButtonElement);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const envelope = onSend.mock.calls[0][0] as { content: string };
    expect(envelope.content).toContain('ls -la');
    expect(envelope.content).toContain('ls 的输出');
    expect(envelope.content).toContain('退出码 0');
    // 不套 chip 确认模板：正文不是「我选择了建议项…」的表态包装
    expect(envelope.content).not.toContain('我选择了建议项');

    // 双击后仍然只有一条
    fireEvent.click(card.querySelector('[data-iact-run-handoff]') as HTMLButtonElement);
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
