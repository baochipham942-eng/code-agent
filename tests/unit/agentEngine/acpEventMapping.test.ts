import { describe, expect, it } from 'vitest';
import {
  AcpToolCallTracker,
  mapAcpSessionUpdate,
} from '../../../src/host/services/agentEngine/acpEventMapping';

// 样本全部逐字取自 2026-08-27 对 Kimi Code CLI 0.38.0 的真机抓包
// （code-agent-private-archive/docs/evidence/2026-08-27-N-ACP-CLIENT-原始抓包-kimi-0.38.0.ndjson）
const SAMPLES = {
  agentMessage: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } },
  agentThought: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'User' } },
  userMessage: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '回答 OK 两个字，不要调用任何工具。' } },
  toolCall: {
    sessionUpdate: 'tool_call',
    toolCallId: '1:tool_gH2kgkJ4ZBGxf7uA7mRylizH',
    title: 'Write',
    kind: 'edit',
    status: 'pending',
  },
  toolCallUpdate: {
    sessionUpdate: 'tool_call_update',
    toolCallId: '1:tool_gH2kgkJ4ZBGxf7uA7mRylizH',
    status: 'completed',
  },
  usage: { sessionUpdate: 'usage_update', used: 37900, size: 1048576 },
  sessionInfo: { sessionUpdate: 'session_info_update', title: '回答 OK 两个字，不要调用任何工具。' },
} as const;

describe('mapAcpSessionUpdate', () => {
  it('maps agent_message_chunk to assistant content text', () => {
    expect(mapAcpSessionUpdate(SAMPLES.agentMessage)).toEqual({ kind: 'text', text: 'OK' });
  });

  it('maps agent_thought_chunk to the reasoning channel, not content', () => {
    expect(mapAcpSessionUpdate(SAMPLES.agentThought)).toEqual({ kind: 'reasoning', text: 'User' });
  });

  /**
   * 🔴 这条是本文件最重要的断言，也是反向变异的靶子。
   *
   * session/load 回放历史时 agent 会把**用户自己**说过的话作为 user_message_chunk 送回来
   * （08-27 抓包实证：load 一次回放 9 条，其中 3 条是 user_message_chunk）。
   * 一旦它被当成 text 映射，用户的输入就会以助手身份重新渲染一遍——
   * 每次续接会话都复读一次用户的原话。它必须停在 ignored。
   */
  it('never turns replayed user_message_chunk into assistant text', () => {
    const mapped = mapAcpSessionUpdate(SAMPLES.userMessage);
    expect(mapped).toEqual({ kind: 'ignored', sessionUpdate: 'user_message_chunk' });
    expect(mapped?.kind).not.toBe('text');
  });

  it('carries toolCallId, title, kind and status through tool_call', () => {
    expect(mapAcpSessionUpdate(SAMPLES.toolCall)).toEqual({
      kind: 'tool_call',
      toolCallId: '1:tool_gH2kgkJ4ZBGxf7uA7mRylizH',
      title: 'Write',
      toolKind: 'edit',
      status: 'pending',
    });
  });

  it('keeps tool_call_update on the same toolCallId so status can advance', () => {
    expect(mapAcpSessionUpdate(SAMPLES.toolCallUpdate)).toEqual({
      kind: 'tool_call',
      toolCallId: '1:tool_gH2kgkJ4ZBGxf7uA7mRylizH',
      status: 'completed',
    });
  });

  it('maps usage_update to the usage channel', () => {
    expect(mapAcpSessionUpdate(SAMPLES.usage)).toEqual({ kind: 'usage', used: 37900, size: 1048576 });
  });

  it('reports recognised-but-unconsumed updates as ignored rather than dropping them silently', () => {
    expect(mapAcpSessionUpdate(SAMPLES.sessionInfo)).toEqual({
      kind: 'ignored',
      sessionUpdate: 'session_info_update',
    });
  });

  it('separates protocol garbage (null) from recognised-but-unconsumed (ignored)', () => {
    expect(mapAcpSessionUpdate(undefined)).toBeNull();
    expect(mapAcpSessionUpdate({})).toBeNull();
    expect(mapAcpSessionUpdate({ sessionUpdate: 42 })).toBeNull();
  });

  it('does not emit empty text deltas for content blocks that carry no text', () => {
    expect(mapAcpSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } }))
      .toEqual({ kind: 'ignored', sessionUpdate: 'agent_message_chunk' });
  });
});

describe('AcpToolCallTracker', () => {
  it('remembers the last non-empty title for a toolCallId across title-less updates', () => {
    const tracker = new AcpToolCallTracker();
    const first = mapAcpSessionUpdate(SAMPLES.toolCall);
    const later = mapAcpSessionUpdate(SAMPLES.toolCallUpdate);
    if (first?.kind !== 'tool_call' || later?.kind !== 'tool_call') throw new Error('unexpected mapping');

    expect(tracker.observe(first)).toBe('Write');
    // 抓包实测：中间十几条 tool_call_update 的 title 全是 null，台账不能因此丢掉工具名。
    expect(tracker.observe(later)).toBe('Write');
  });

  it('falls back to the toolCallId when no title was ever seen', () => {
    const tracker = new AcpToolCallTracker();
    expect(tracker.observe({ kind: 'tool_call', toolCallId: 'tool_x' })).toBe('tool_x');
  });

  it('treats only completed/failed as terminal', () => {
    expect(AcpToolCallTracker.isTerminal('completed')).toBe(true);
    expect(AcpToolCallTracker.isTerminal('failed')).toBe(true);
    expect(AcpToolCallTracker.isTerminal('in_progress')).toBe(false);
    expect(AcpToolCallTracker.isTerminal(undefined)).toBe(false);
  });
});
