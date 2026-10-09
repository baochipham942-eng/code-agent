// @vitest-environment jsdom

import React, { useRef, useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import type { Message } from '../../../src/shared/contract';

const askSideChat = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

vi.mock('../../../src/renderer/services/sideChatClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/sideChatClient')>();
  return { ...actual, askSideChat: (...args: unknown[]) => askSideChat(...args) };
});

const { SideChatRequestError } = await import('../../../src/renderer/services/sideChatClient');

import { InputArea, type InputAreaRef } from '../../../src/renderer/components/features/chat/ChatInput/InputArea';
import {
  useChatInputSubmit,
  type UseChatInputSubmitParams,
} from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';
import { dismissSideChat } from '../../../src/renderer/components/features/chat/sideChatFloaterState';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useStatusStore } from '../../../src/renderer/stores/statusStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';

const originalAddMessage = useSessionStore.getState().addMessage;

function makeParams(overrides: Partial<UseChatInputSubmitParams> = {}): UseChatInputSubmitParams {
  return {
    value: '',
    attachments: [],
    voiceInputContext: null,
    pendingAppshot: null,
    pendingPromptCommand: null,
    pendingAgentSelection: null,
    currentSessionId: 'session-1',
    isProcessing: false,
    disabled: false,
    isUploading: false,
    onSend: vi.fn().mockResolvedValue(true),
    onSteer: vi.fn().mockResolvedValue({ outcome: 'steered' }),
    agentEntries: [],
    buildEnvelope: (content, attachments): ConversationEnvelope => ({ content, attachments }),
    openAgentCommand: vi.fn(),
    addToInputHistory: vi.fn(),
    clearAppshot: vi.fn(),
    inputAreaRef: { current: null },
    setValue: vi.fn(),
    setAttachments: vi.fn(),
    setVoiceInputContext: vi.fn(),
    setPendingPromptCommand: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setScheduleComposerOpen: vi.fn(),
    openGoalConfirm: vi.fn(),
    closeGoalConfirm: vi.fn(),
    openSeedComposer: vi.fn(),
    setActiveAgentId: vi.fn(),
    ...overrides,
  };
}

function SubmitHarness({
  isProcessing = false,
  onSend = vi.fn().mockResolvedValue(true),
  initialValue = '/btw 旁边问一句',
  sessionId = 'session-1',
}: {
  isProcessing?: boolean;
  onSend?: UseChatInputSubmitParams['onSend'];
  initialValue?: string;
  sessionId?: string | null;
}) {
  const [value, setValue] = useState(initialValue);
  const inputAreaRef = useRef<InputAreaRef>(null);
  const { handleSubmit } = useChatInputSubmit(makeParams({
    value,
    setValue,
    isProcessing,
    disabled: isProcessing,
    onSend,
    inputAreaRef,
    currentSessionId: sessionId,
  }));

  return (
    <>
      <button type="button" onClick={() => setValue('/btw 旁边问一句')}>seed-btw</button>
      <InputArea
        ref={inputAreaRef}
        value={value}
        onChange={setValue}
        onSubmit={(opts) => { void handleSubmit(undefined, opts); }}
        onFileSelect={vi.fn()}
        isFocused={false}
        onFocusChange={vi.fn()}
        sideChatSessionId={sessionId}
      />
    </>
  );
}

function deferAnswer() {
  let resolveAsk: (value: string) => void = () => {};
  let rejectAsk: (error: Error) => void = () => {};
  const signals: AbortSignal[] = [];
  askSideChat.mockImplementation((_input: unknown, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<string>((resolve, reject) => {
      resolveAsk = resolve;
      rejectAsk = reject;
      signal.addEventListener('abort', () => reject(new Error('SIDE_CHAT_ABORTED')), { once: true });
    });
  });
  return {
    signals,
    resolve: (value: string) => resolveAsk(value),
    reject: (error: Error) => rejectAsk(error),
  };
}

async function submitBtw(): Promise<void> {
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  await screen.findByRole('dialog', { name: '只读侧聊' });
}

beforeEach(() => {
  dismissSideChat();
  askSideChat.mockReset();
  useSessionStore.setState({
    messages: [],
    currentSessionId: 'session-1',
    addMessage: originalAddMessage,
  });
  useStatusStore.setState({ isStreaming: false });
  useComposerStore.getState().setPendingCommand(null);
  window.codeAgentDomainAPI = undefined;
});

afterEach(() => {
  cleanup();
  dismissSideChat();
  useSessionStore.setState({
    messages: [],
    currentSessionId: null,
    addMessage: originalAddMessage,
  });
  window.codeAgentDomainAPI = undefined;
});

describe('side chat floater', () => {
  it('renders the dialog in the composer, then loading, answer, close, and Escape', async () => {
    const pending = deferAnswer();
    const onSend = vi.fn().mockResolvedValue(true);
    render(<SubmitHarness onSend={onSend} />);

    await submitBtw();
    const dialog = screen.getByRole('dialog', { name: '只读侧聊' });
    expect(dialog.className).toContain('bottom-full');
    expect(dialog.parentElement?.className).toContain('relative');
    expect(dialog.textContent).toContain('思考中…');
    expect(dialog.textContent).toContain('旁边问一句');
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve('42');
    });
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('42'));

    fireEvent.click(screen.getByRole('button', { name: '关闭侧聊' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'seed-btw' }));
    await submitBtw();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves sessionStore.messages untouched and never calls addMessage', async () => {
    const pending = deferAnswer();
    const seed = [{ id: 'm1', role: 'user', content: 'keep-me', timestamp: 1 }] as Message[];
    const addMessage = vi.fn((message: Message) => originalAddMessage(message));
    useSessionStore.setState({ messages: seed, currentSessionId: 'session-1', addMessage });
    const before = structuredClone(useSessionStore.getState().messages);

    render(<SubmitHarness />);
    await submitBtw();
    await act(async () => {
      pending.resolve('42');
    });
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('42'));
    fireEvent.click(screen.getByRole('button', { name: '关闭侧聊' }));

    expect(addMessage).not.toHaveBeenCalled();
    expect(useSessionStore.getState().messages).toEqual(before);
  });

  it('aborts a pending request on close and ignores a late answer', async () => {
    const pending = deferAnswer();
    const view = render(<SubmitHarness />);
    await submitBtw();
    expect(pending.signals.at(-1)?.aborted).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '关闭侧聊' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pending.signals.at(-1)?.aborted).toBe(true);

    await act(async () => {
      pending.resolve('late');
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).toBeNull();

    view.unmount();
    render(<SubmitHarness initialValue="" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not send or queue while the main run is streaming', async () => {
    deferAnswer();
    const onSend = vi.fn().mockResolvedValue(true);
    const domainInvoke = vi.fn();
    window.codeAgentDomainAPI = { invoke: domainInvoke } as typeof window.codeAgentDomainAPI;
    useStatusStore.setState({ isStreaming: true });

    render(<SubmitHarness isProcessing onSend={onSend} />);
    await submitBtw();

    expect(screen.getByRole('dialog').textContent).toContain('思考中…');
    expect(onSend).not.toHaveBeenCalled();
    expect(domainInvoke).not.toHaveBeenCalled();
    expect(useStatusStore.getState().isStreaming).toBe(true);
  });

  it('shows a localized failure cause with a retry way out, and retry re-sends the same question', async () => {
    const pending = deferAnswer();
    render(<SubmitHarness />);

    await submitBtw();
    await act(async () => {
      pending.reject(new SideChatRequestError('auth'));
    });

    const dialog = await waitFor(() => {
      const node = screen.getByRole('dialog');
      expect(node.textContent).toContain('模型没有响应：账号未通过授权');
      return node;
    });
    expect(dialog.textContent).not.toContain('侧聊没有完成');
    expect(askSideChat).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(askSideChat).toHaveBeenCalledTimes(2);
    const retryCall = askSideChat.mock.calls[1];
    expect(retryCall[0]).toEqual({ sessionId: 'session-1', question: '旁边问一句' });
    expect(screen.getByRole('dialog').textContent).toContain('思考中…');

    await act(async () => {
      pending.resolve('第二次成了');
    });
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('第二次成了'));
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('maps timeout and unknown causes to their own fallback wording', async () => {
    const pending = deferAnswer();
    const view = render(<SubmitHarness />);
    await submitBtw();
    await act(async () => {
      pending.reject(new SideChatRequestError('timeout'));
    });
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('请求超时'));
    expect(screen.getByRole('dialog').textContent).not.toContain('模型没有响应');

    fireEvent.click(screen.getByRole('button', { name: '关闭侧聊' }));
    view.unmount();

    const second = deferAnswer();
    render(<SubmitHarness />);
    await submitBtw();
    await act(async () => {
      second.reject(new SideChatRequestError('unknown'));
    });
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('侧聊没有完成'));
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('keeps the header row outside the scroll container and caps the body height to the space above the input', async () => {
    const pending = deferAnswer();
    render(<SubmitHarness />);
    await submitBtw();
    await act(async () => {
      pending.resolve('长答案'.repeat(40));
    });
    const dialog = await waitFor(() => screen.getByRole('dialog'));
    const body = dialog.querySelector<HTMLDivElement>('div.overflow-y-auto');
    expect(body).not.toBeNull();
    // 结构性质：标题行（X 所在行）在滚动容器外，不随正文滚动
    expect(screen.getByRole('button', { name: '关闭侧聊' }).closest('div.overflow-y-auto')).toBeNull();
    // 滚动容器有高度帽；jsdom 量不到布局（offsetParent null）时保持 60vh class 兜底、无内联覆盖
    expect(body?.className).toContain('max-h-[60vh]');
    expect(body?.style.maxHeight).toBe('');

    // 量得到布局时：正文帽 = min(60vh, 锚点上沿 − mb-2(8) − TitleBar 预留(56) − 标题行高)
    const anchor = document.createElement('div');
    document.body.append(anchor);
    Object.defineProperty(dialog, 'offsetParent', { get: () => anchor, configurable: true });
    const header = dialog.firstElementChild as HTMLElement;
    anchor.getBoundingClientRect = () => ({ top: 336.5 }) as DOMRect;
    header.getBoundingClientRect = () => ({ height: 42 }) as DOMRect;
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    try {
      window.dispatchEvent(new Event('resize'));
      await waitFor(() => expect(body?.style.maxHeight).toBe('230px')); // 336.5 - 8 - 56 - 42 = 230.5 → 230
      // 空间充裕时仍以 60vh 为帽（900 视口 → 540）
      anchor.getBoundingClientRect = () => ({ top: 800 }) as DOMRect;
      Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
      window.dispatchEvent(new Event('resize'));
      await waitFor(() => expect(body?.style.maxHeight).toBe('540px'));
      // 空间不足时保底 64px：正文不至于整块塌成只剩标题行
      anchor.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
      window.dispatchEvent(new Event('resize'));
      await waitFor(() => expect(body?.style.maxHeight).toBe('64px'));
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
      anchor.remove();
    }
  });

  it('reuses the context health popover shell and adds no new colour or z-index token', () => {
    const popover = readFileSync(
      resolve(__dirname, '../../../src/renderer/components/features/chat/ContextHealthDetailPopover.tsx'),
      'utf8',
    );
    const floater = readFileSync(
      resolve(__dirname, '../../../src/renderer/components/features/chat/SideChatFloater.tsx'),
      'utf8',
    );
    const shell = 'absolute bottom-full right-0 z-30 mb-2 w-[440px] max-w-[calc(100vw-2rem)] rounded-xl border border-border-hover bg-zinc-900/95 shadow-md dark:shadow-2xl backdrop-blur';
    expect(popover).toContain(shell);
    expect(floater).toContain(shell);
    const tokenRe = /(?:[\w-]+:)*(?:text|bg|border|ring|fill|stroke|from|to|via|shadow|z)-[^\s"'`]+/g;
    const popoverTokens = new Set(popover.match(tokenRe) ?? []);
    for (const token of floater.match(tokenRe) ?? []) {
      expect(popoverTokens.has(token), token).toBe(true);
    }
    expect(floater).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
