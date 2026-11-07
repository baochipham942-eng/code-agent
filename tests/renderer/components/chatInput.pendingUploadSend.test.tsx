// @vitest-environment jsdom
//
// FB-579 回归：上传中点发送 / 回车不许被静默吞掉。
// 修复前：canSubmit 要求 !isUploading，上传中的提交直接 return——按钮看着能点，
// 点了却什么都不发生（无 /api/run、草稿留在输入框、无提示）。13 字节文件的
// 附件处理也要走一次 getPathForFile 往返，新会话刚建立的几秒里能拖到秒级。
// 修复后：提交先挂起（「正在上传，完成后自动发送」），上传结束自动重放并发带
// 附件；失败不发并告知；等待期间改草稿 / 删附件作废；连点不双发。

import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import type { MessageAttachment } from '../../../src/shared/contract';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const toastSpy = vi.hoisted(() => ({
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  show: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: toastSpy }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

import { ChatInput, type ChatInputHandle } from '../../../src/renderer/components/features/chat/ChatInput';
import ipcService from '../../../src/renderer/services/ipcService';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const realCreateSession = useSessionStore.getState().createSession;

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

function showSession(session: SessionWithMeta): void {
  useSessionStore.setState({
    sessions: [session],
    currentSessionId: session.id,
    messages: [],
    createSession: realCreateSession,
  });
}

function resetCapabilityStore(): void {
  useBundledCapabilityStore.setState({
    installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
    states: [],
    loaded: true,
    error: null,
  });
}

/** 上传闸门：getPathForFile 挂在手动 resolve 的 Promise 上，模拟慢上传 */
let resolveGetPath: ((path: string) => void) | null = null;

function pickFile(container: HTMLElement, file: File): void {
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!fileInput) throw new Error('file input not found');
  Object.defineProperty(fileInput, 'files', { value: [file] });
  fireEvent.change(fileInput);
}

const TEXT = '看下这个文件';

function typeDraft(ref: React.RefObject<ChatInputHandle | null>, content: string): void {
  act(() => { ref.current!.setDraft({ content }); });
}

/** 真实打字路径：编辑区追加文本节点 + input 事件（不replace整棵树，保住已有 chip 挂载点） */
function typeIntoEditor(text: string): void {
  const editor = screen.getByTestId('chat-composer-textarea');
  act(() => {
    editor.appendChild(document.createTextNode(text));
    fireEvent.input(editor);
  });
}

function clickSend(): void {
  // 编辑区本身也带 sendAria 标签，按按钮角色精确定位
  fireEvent.click(screen.getByRole('button', { name: zh.chatInput.sendAria }));
}

function uploadStatus(): HTMLElement | null {
  return screen.queryByTestId('composer-upload-status');
}

beforeEach(() => {
  resetCapabilityStore();
  showSession(makeSession('session-upload'));
  resolveGetPath = null;
  vi.spyOn(ipcService, 'getPathForFile').mockImplementation(() => new Promise<string>((resolve) => {
    resolveGetPath = resolve;
  }));
  // 未知 domain/action 交给真实实现（jsdom 无桥 → 抛错），别用 {} 假成功喂坏消费方
  const realInvokeDomain = ipcService.invokeDomain.bind(ipcService);
  vi.spyOn(ipcService, 'invokeDomain').mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') return Promise.resolve([]);
    return realInvokeDomain(domain, action);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    messages: [],
    createSession: realCreateSession,
  });
  resetCapabilityStore();
  toastSpy.warning.mockClear();
});

describe('上传中的提交不丢（FB-579）', () => {
  it('上传中点发送：挂起并提示，上传结束后带附件自动发出，草稿清空', async () => {
    const onSend = vi.fn(async (_envelope: ConversationEnvelope) => true);
    const ref = createRef<ChatInputHandle>();
    const { container } = render(<ChatInput ref={ref} onSend={onSend} />);

    // 13 字节文本文件：真实链路 file input → handleFileSelect → processFile → getPathForFile（挂起中）
    pickFile(container, new File(['hello\nworld\n'], 'notes.txt', { type: 'text/plain' }));
    await waitFor(() => expect(uploadStatus()).not.toBeNull());
    expect(uploadStatus()!.textContent).toContain(zh.chatInput.processingFiles);

    typeDraft(ref, TEXT);
    clickSend();

    // 提交没有丢也没有发：换挂起提示，草稿还在，onSend 未被调
    expect(onSend).not.toHaveBeenCalled();
    expect(uploadStatus()!.getAttribute('data-pending-send')).toBe('true');
    expect(uploadStatus()!.textContent).toContain(zh.chatInput.pendingSendUploadWaiting);
    expect(screen.getByTestId('chat-composer-textarea').getAttribute('data-plain-text')).toBe(TEXT);

    // 上传完成（路径返回 + FileReader 读文本落地附件）→ 自动发出，带附件
    await act(async () => { resolveGetPath!('/tmp/notes.txt'); });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const envelope = onSend.mock.calls[0][0];
    expect(envelope.content).toBe(TEXT);
    expect(envelope.attachments).toHaveLength(1);
    expect(envelope.attachments![0]!.name).toBe('notes.txt');
    expect(envelope.attachments![0]!.path).toBe('/tmp/notes.txt');

    // 发完收尾：挂起提示消失、草稿清空
    await waitFor(() => expect(uploadStatus()).toBeNull());
    expect(screen.getByTestId('chat-composer-textarea').getAttribute('data-plain-text')).toBe('');
    expect(toastSpy.warning).not.toHaveBeenCalled();
  });

  it('上传中按 Enter 同样挂起，结束后只发一次', async () => {
    const onSend = vi.fn(async (_envelope: ConversationEnvelope) => true);
    const ref = createRef<ChatInputHandle>();
    const { container } = render(<ChatInput ref={ref} onSend={onSend} />);

    pickFile(container, new File(['abc'], 'data.txt', { type: 'text/plain' }));
    typeDraft(ref, TEXT);
    fireEvent.keyDown(screen.getByTestId('chat-composer-textarea'), { key: 'Enter', keyCode: 13 });

    expect(onSend).not.toHaveBeenCalled();
    expect(uploadStatus()!.getAttribute('data-pending-send')).toBe('true');

    await act(async () => { resolveGetPath!('/tmp/data.txt'); });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const envelope = onSend.mock.calls[0][0];
    expect(envelope.attachments).toHaveLength(1);
  });

  it('连点两次只发一次', async () => {
    const onSend = vi.fn(async (_envelope: ConversationEnvelope) => true);
    const ref = createRef<ChatInputHandle>();
    const { container } = render(<ChatInput ref={ref} onSend={onSend} />);

    pickFile(container, new File(['abc'], 'data.txt', { type: 'text/plain' }));
    typeDraft(ref, TEXT);
    clickSend();
    clickSend();

    await act(async () => { resolveGetPath!('/tmp/data.txt'); });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // 再给一轮微任务，确认没有第二发
    await act(async () => { await Promise.resolve(); });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('上传失败：不发、草稿保留、明确告知', async () => {
    const onSend = vi.fn(async (_envelope: ConversationEnvelope) => true);
    const ref = createRef<ChatInputHandle>();
    const { container } = render(<ChatInput ref={ref} onSend={onSend} />);

    // 超限文件：processFile 返回 null（失败），走真实失败分支而非 mock 掉判定
    const bigFile = new File(['x'], 'big.txt', { type: 'text/plain' });
    Object.defineProperty(bigFile, 'size', { value: 10 * 1024 * 1024 + 1 });
    pickFile(container, bigFile);
    typeDraft(ref, TEXT);
    clickSend();
    expect(uploadStatus()!.getAttribute('data-pending-send')).toBe('true');

    await act(async () => { resolveGetPath!('/tmp/big.txt'); });
    await waitFor(() => expect(toastSpy.warning).toHaveBeenCalledWith(zh.chatInput.pendingSendUploadFailed));

    // 不发、草稿原样保留、挂起提示随上传结束消失
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-composer-textarea').getAttribute('data-plain-text')).toBe(TEXT);
    await waitFor(() => expect(uploadStatus()).toBeNull());
  });

  it('等待期间编辑草稿：挂起作废，上传结束后不发', async () => {
    const onSend = vi.fn(async (_envelope: ConversationEnvelope) => true);
    const ref = createRef<ChatInputHandle>();
    const { container } = render(<ChatInput ref={ref} onSend={onSend} />);

    pickFile(container, new File(['abc'], 'data.txt', { type: 'text/plain' }));
    typeDraft(ref, TEXT);
    clickSend();
    expect(uploadStatus()!.getAttribute('data-pending-send')).toBe('true');

    // 用户改了主意继续编辑
    typeDraft(ref, `${TEXT}（补充）`);
    expect(uploadStatus()!.getAttribute('data-pending-send')).not.toBe('true');

    await act(async () => { resolveGetPath!('/tmp/data.txt'); });
    await waitFor(() => expect(uploadStatus()).toBeNull());
    await act(async () => { await Promise.resolve(); });
    expect(onSend).not.toHaveBeenCalled();
    // 草稿保留的是编辑后的文本
    expect(screen.getByTestId('chat-composer-textarea').getAttribute('data-plain-text')).toContain('（补充）');
  });

  it('等待期间删除已有附件：挂起作废，上传结束后不发', async () => {
    const onSend = vi.fn(async (_envelope: ConversationEnvelope) => true);
    const ref = createRef<ChatInputHandle>();
    const existing: MessageAttachment = {
      id: 'att-existing', type: 'file', category: 'text', name: 'old.txt',
      size: 3, mimeType: 'text/plain', data: 'old',
    };
    const { container } = render(<ChatInput ref={ref} onSend={onSend} />);
    act(() => { ref.current!.addAttachments([existing]); });

    pickFile(container, new File(['abc'], 'data.txt', { type: 'text/plain' }));
    typeIntoEditor(TEXT);
    clickSend();
    expect(uploadStatus()!.getAttribute('data-pending-send')).toBe('true');

    // 删掉提交那一刻就在的附件（内联 file chip 的 ×）= 改变主意
    fireEvent.click(screen.getByLabelText(zh.chatInput.attachRemoveAria.replace('{name}', 'old.txt')));
    expect(uploadStatus()!.getAttribute('data-pending-send')).not.toBe('true');

    await act(async () => { resolveGetPath!('/tmp/data.txt'); });
    await waitFor(() => expect(uploadStatus()).toBeNull());
    await act(async () => { await Promise.resolve(); });
    expect(onSend).not.toHaveBeenCalled();
  });
});
