// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatInputSessionScope } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSessionScope';
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
