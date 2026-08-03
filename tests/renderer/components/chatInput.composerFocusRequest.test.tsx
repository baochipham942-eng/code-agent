// @vitest-environment jsdom
//
// store 那半（发不发聚焦请求）由 sessionStore.draftReuseFocus 钉死；
// 这里钉的是另一半——ChatInput 到底有没有接住这个信号。两半都在才叫「用户路通」。

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useComposerFocusRequest } from '../../../src/renderer/components/features/chat/ChatInput/useComposerFocusRequest';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('useComposerFocusRequest', () => {
  beforeEach(() => {
    useAppStore.setState({ composerFocusNonce: 0 });
  });

  it('挂载时不抢焦点（初始 nonce 为 0）', () => {
    const focusComposer = vi.fn();
    renderHook(() => useComposerFocusRequest(focusComposer));

    expect(focusComposer).not.toHaveBeenCalled();
  });

  it('每来一次聚焦请求就 focus 一次输入框', () => {
    const focusComposer = vi.fn();
    renderHook(() => useComposerFocusRequest(focusComposer));

    act(() => { useAppStore.getState().requestComposerFocus(); });
    expect(focusComposer).toHaveBeenCalledTimes(1);

    act(() => { useAppStore.getState().requestComposerFocus(); });
    expect(focusComposer).toHaveBeenCalledTimes(2);
  });
});
