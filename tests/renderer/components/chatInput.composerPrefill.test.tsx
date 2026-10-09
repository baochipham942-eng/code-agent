// @vitest-environment jsdom
//
// 预填的接收半：store 里有句子时 ChatInput 要接住（填进输入框 + 聚焦），
// 且只填不发。发起半（专家团快捷句点击 → setPendingComposerPrefill）由
// ExpertPanel.test.tsx 钉死；两半都在才叫「用户路通」。

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useComposerPrefill } from '../../../src/renderer/components/features/chat/ChatInput/useComposerPrefill';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';

describe('useComposerPrefill', () => {
  beforeEach(() => {
    useComposerStore.setState({ pendingComposerPrefill: null });
  });

  it('挂载时没有预填就不动输入框', () => {
    const apply = vi.fn();
    const focusComposer = vi.fn();
    renderHook(() => useComposerPrefill(apply, focusComposer));

    expect(apply).not.toHaveBeenCalled();
    expect(focusComposer).not.toHaveBeenCalled();
  });

  it('来一次预填就填一次句子并聚焦，消费后清空（不残留、不重放）', () => {
    const apply = vi.fn();
    const focusComposer = vi.fn();
    renderHook(() => useComposerPrefill(apply, focusComposer));

    act(() => { useComposerStore.getState().setPendingComposerPrefill({ text: '帮我围绕这个主题定一套内容战役方案' }); });
    expect(apply).toHaveBeenCalledWith('帮我围绕这个主题定一套内容战役方案');
    expect(focusComposer).toHaveBeenCalledTimes(1);
    expect(useComposerStore.getState().pendingComposerPrefill).toBeNull();
  });

  it('同句连点靠 nonce 各触发一次（对象引用每次都是新的）', () => {
    const apply = vi.fn();
    renderHook(() => useComposerPrefill(apply, vi.fn()));

    act(() => { useComposerStore.getState().setPendingComposerPrefill({ text: '同一句' }); });
    act(() => { useComposerStore.getState().setPendingComposerPrefill({ text: '同一句' }); });
    expect(apply).toHaveBeenCalledTimes(2);
  });
});
