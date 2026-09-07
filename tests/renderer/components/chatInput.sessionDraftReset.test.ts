// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatInputSessionScope } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSessionScope';
import { composerEditModeState } from '../../../src/renderer/components/features/chat/ChatInput/composerEditMode';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

describe('切换会话清掉编辑重发 pending', () => {
  beforeEach(() => {
    useSessionStore.setState({ currentSessionId: 'session-A' } as never);
  });

  it('会话切换时触发草稿重置回调，pending id 不残留到下一会话', () => {
    const setValue = vi.fn();
    const setAttachments = vi.fn();
    const pending = { current: 'failed-bubble-id' as string | null };
    const { rerender } = renderHook(
      ({ sessionless }: { sessionless: boolean }) => useChatInputSessionScope(
        setValue,
        setAttachments,
        sessionless,
        () => { pending.current = null; },
      ),
      { initialProps: { sessionless: false } },
    );

    expect(pending.current).toBe('failed-bubble-id');

    act(() => {
      useSessionStore.setState({ currentSessionId: 'session-B' } as never);
    });
    rerender({ sessionless: false });

    expect(setValue).toHaveBeenCalledWith('');
    expect(setAttachments).toHaveBeenCalledWith([]);
    expect(pending.current).toBeNull();
  });
});

describe('失败重发与排队编辑互斥', () => {
  it('恢复失败草稿时清掉队列编辑 id', () => {
    expect(composerEditModeState({ kind: 'failed-resend', clientMessageId: 'failed-A' })).toEqual({
      editingQueuedInputId: null,
      pendingResendClientMessageId: 'failed-A',
    });
  });

  it('进入队列编辑时清掉待重发 id，避免提交把排队消息 C 覆盖成 A', () => {
    expect(composerEditModeState({ kind: 'queued-edit', queuedInputId: 'queued-C' })).toEqual({
      editingQueuedInputId: 'queued-C',
      pendingResendClientMessageId: null,
    });
  });

  it('C 排队编辑后再点 A 失败重发，是整体切换不是 merge，提交不会截获去改 C', () => {
    const queued = composerEditModeState({ kind: 'queued-edit', queuedInputId: 'queued-C' });
    expect(queued.editingQueuedInputId).toBe('queued-C');
    const afterFailedResend = composerEditModeState({ kind: 'failed-resend', clientMessageId: 'failed-A' });
    expect({ ...queued, ...afterFailedResend }).toEqual({
      editingQueuedInputId: null,
      pendingResendClientMessageId: 'failed-A',
    });
  });

  it('先失败重发 A 再排队编辑 C，pending 被清掉，下一次发送不会误用 A 的 id', () => {
    const failed = composerEditModeState({ kind: 'failed-resend', clientMessageId: 'failed-A' });
    const afterQueued = composerEditModeState({ kind: 'queued-edit', queuedInputId: 'queued-C' });
    expect({ ...failed, ...afterQueued }).toEqual({
      editingQueuedInputId: 'queued-C',
      pendingResendClientMessageId: null,
    });
  });

  it('ChatInput 两种模式入口都整体写入一对 id，不各自只写一半', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/features/chat/ChatInput/index.tsx'),
      'utf8',
    );
    expect(source).toContain("kind: 'failed-resend'");
    expect(source).toContain("kind: 'queued-edit'");
    expect(source.match(/setEditingQueuedInputId\(mode\.editingQueuedInputId\)/g)?.length).toBe(2);
    expect(source.match(/pendingResendClientMessageIdRef\.current = mode\.pendingResendClientMessageId/g)?.length).toBe(2);
  });
});
