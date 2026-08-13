// @vitest-environment jsdom
//
// #1102 真机复验抓出的漏接：searchEnabled 只接进了 ChatView.buildEnvelope
// （编辑/重发旁路），用户真实提交路径（ChatInput → useChatInputEnvelope）构造的
// envelope 根本不带该字段——host 端缺省补 true，OFF 永远无效。
// 本门钉死：composer 主路径构造的 envelope 必须携带 modeStore 提交时刻的 searchEnabled。

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChatInputEnvelope } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputEnvelope';
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

describe('useChatInputEnvelope · 逐轮联网开关随载荷', () => {
  it('envelope 携带 modeStore 提交时刻的 searchEnabled（OFF/ON 成对）', () => {
    const { result } = renderHook(() => useChatInputEnvelope(buildParams() as never));

    act(() => { useModeStore.getState().setWebSearchEnabled(false); });
    expect(result.current('OFF 消息').searchEnabled).toBe(false);

    // 同一个 builder 实例（依赖数组没变）也必须读到新值——防 useCallback 冻结快照回潮
    act(() => { useModeStore.getState().setWebSearchEnabled(true); });
    expect(result.current('ON 消息').searchEnabled).toBe(true);
  });
});
