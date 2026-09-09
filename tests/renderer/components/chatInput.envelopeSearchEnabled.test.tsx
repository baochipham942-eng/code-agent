// @vitest-environment jsdom
//
// #1102 真机复验抓出的漏接：searchEnabled 只接进了 ChatView.buildEnvelope
// （编辑/重发旁路），用户真实提交路径（ChatInput → useChatInputEnvelope）构造的
// envelope 根本不带该字段——host 端缺省补 true，OFF 永远无效。
// 本门钉死：composer 主路径构造的 envelope 必须携带 modeStore 提交时刻的 searchEnabled。

import { act, renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { useChatInputEnvelope } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputEnvelope';
import { composerEditModeState } from '../../../src/renderer/components/features/chat/ChatInput/composerEditMode';
import { useModeStore } from '../../../src/renderer/stores/modeStore';

function buildParams() {
  return {
    swarmAgents: [],
    agentEntries: [],
    activeAgentId: null,
    browserSession: { sessionActive: false } as never,
    voiceInputContext: null,
    buildContext: () => undefined,
    pendingPromptCommand: null,
    pendingAgentSelection: null,
  };
}

describe('useChatInputEnvelope · 同族逐轮设置随载荷', () => {
  it.each([
    ['transcript', { context: { voiceInput: { source: 'dictation' } } }, true],
    ['attachment', { attachments: [{ id: 'attachment-1' }] }, true],
    ['paste', { context: { memoryTainted: true } }, true],
    ['typed', {}, false],
  ])('preserves %s provenance through the actual queued-edit callback and re-submit', (_name, provenance, tainted) => {
    // Execute the shipped callback, with state setters at the boundary, then the
    // real envelope hook. This does not claim a mounted full-composer UI test.
    const source = readFileSync('src/renderer/components/features/chat/ChatInput/index.tsx', 'utf8');
    const callback = source.match(/onEdit=\{(\(input\) => \{[\s\S]*?\n {10}\})\}/)?.[1];
    expect(callback).toBeDefined();
    const inputMemoryTainted = { current: false };
    const setValue = vi.fn();
    const setVoiceInputContext = vi.fn();
    const edit = runInNewContext(`(${callback})`, {
      composerEditModeState, inputMemoryTainted, setValue, setVoiceInputContext,
      setEditingQueuedInputId: vi.fn(), pendingResendClientMessageIdRef: { current: null },
      setAttachments: vi.fn(), inputAreaRef: { current: { focus: vi.fn() } },
    });
    edit({ id: 'queued-1', envelope: { content: 'retained draft', ...provenance } });
    expect(setValue).toHaveBeenCalledWith('retained draft');
    expect(setVoiceInputContext).toHaveBeenCalledWith(null);
    const { result } = renderHook(() => useChatInputEnvelope({ ...buildParams(), inputMemoryTainted }));
    expect(result.current('retained draft, edited').context?.memoryTainted === true).toBe(tainted);
  });

  it('carries paste provenance at send time, including a stable builder reused after typing', () => {
    const inputMemoryTainted = { current: false };
    const { result } = renderHook(() => useChatInputEnvelope({ ...buildParams(), inputMemoryTainted }));
    expect(result.current('typed').context?.memoryTainted).toBeUndefined();
    inputMemoryTainted.current = true;
    expect(result.current('pasted then edited').context?.memoryTainted).toBe(true);
    inputMemoryTainted.current = false;
    expect(result.current('new clean draft').context?.memoryTainted).toBeUndefined();
  });

  it('envelope 携带 modeStore 提交时刻的 searchEnabled / thinkingEnabled（正负成对）', () => {
    const { result } = renderHook(() => useChatInputEnvelope(buildParams() as never));

    act(() => { useModeStore.getState().setWebSearchEnabled(false); });
    expect(result.current('OFF 消息').searchEnabled).toBe(false);

    // 同一个 builder 实例（依赖数组没变）也必须读到新值——防 useCallback 冻结快照回潮
    act(() => { useModeStore.getState().setWebSearchEnabled(true); });
    expect(result.current('ON 消息').searchEnabled).toBe(true);

    act(() => { useModeStore.getState().setThinkingEnabled(false); });
    expect(result.current('不思考消息').thinkingEnabled).toBe(false);

    act(() => { useModeStore.getState().setThinkingEnabled(true); });
    expect(result.current('思考消息').thinkingEnabled).toBe(true);
  });

  it('只在用户显式选择 effort 后携带 effortLevel，自动档留给 host analyzer', () => {
    const { result } = renderHook(() => useChatInputEnvelope(buildParams() as never));

    act(() => { useModeStore.getState().setAutomaticEffortLevel(); });
    expect(result.current('自动档消息').effortLevel).toBeUndefined();

    act(() => { useModeStore.getState().setEffortLevel('low'); });
    expect(result.current('显式低档消息').effortLevel).toBe('low');
  });
});
