// 连续同因失败折叠（N-UI-AGENT-ERROR-REPEAT-COLLAPSE）的投影层验收：
// 折叠是渲染期从消息列表推导的（TraceNode.agentErrorRun），不落库、不新增持久化
// 字段——重载历史（对同一份持久化消息重新投影）必须得到同样结果。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentErrorCategory, Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

let seq = 0;
function userMsg(content = '再写一段，直接给正文'): Message {
  seq += 1;
  return { id: `user-${seq}`, role: 'user', content, timestamp: seq * 100 };
}
function errMsg(category: AgentErrorCategory): Message {
  seq += 1;
  return {
    id: `assistant-${seq}`,
    role: 'assistant',
    content: '',
    timestamp: seq * 100,
    metadata: { agentError: { category, rawMessage: 'provider error', timestamp: seq * 100 } },
  };
}
function okMsg(content = '这是这一轮的正文回复。'): Message {
  seq += 1;
  return { id: `assistant-${seq}`, role: 'assistant', content, timestamp: seq * 100 };
}
function toolMsg(): Message {
  seq += 1;
  return {
    id: `assistant-${seq}`,
    role: 'assistant',
    content: '',
    timestamp: seq * 100,
    toolCalls: [{ id: `tc-${seq}`, name: 'bash', arguments: { command: 'ls' } }],
  };
}

/** 承载失败消息错误卡的节点（按消息顺序），供折叠推导结果断言 */
function errorNodes(messages: Message[]) {
  return projectTurns(messages, 'session-1', false)
    .turns.flatMap((turn) => turn.nodes)
    .filter((n) => n.metadata?.agentError);
}

describe('projectTurns 连续同因失败折叠', () => {
  it('3 次同因失败：前两轮 latest=false（灰字行），最新一轮 latest=true、runLength=3', () => {
    const messages = [
      userMsg(), errMsg('auth'),
      userMsg(), errMsg('auth'),
      userMsg(), errMsg('auth'),
    ];
    const nodes = errorNodes(messages);
    const runs = nodes.map((n) => n.agentErrorRun);
    expect(runs).toEqual([
      { runLength: 1, latest: false },
      { runLength: 2, latest: false },
      { runLength: 3, latest: true },
    ]);
  });

  it('A,A,B：换 category 结束前一段 → 灰字(A)、整卡(A)、整卡(B)', () => {
    const messages = [
      userMsg(), errMsg('auth'),
      userMsg(), errMsg('auth'),
      userMsg(), errMsg('network'),
    ];
    const runs = errorNodes(messages).map((n) => n.agentErrorRun);
    expect(runs).toEqual([
      { runLength: 1, latest: false },
      { runLength: 2, latest: true },
      { runLength: 1, latest: true },
    ]);
  });

  it('中间出现成功轮：连续段重置，前后两次失败都是单段最新', () => {
    const messages = [
      userMsg(), errMsg('auth'),
      userMsg(), okMsg(),
      userMsg(), errMsg('auth'),
    ];
    const runs = errorNodes(messages).map((n) => n.agentErrorRun);
    expect(runs).toEqual([
      { runLength: 1, latest: true },
      { runLength: 1, latest: true },
    ]);
  });

  it('重试成功后没有残留：失败轮保持单段最新，成功轮不带任何错误卡', () => {
    const messages = [userMsg(), errMsg('auth'), userMsg(), okMsg()];
    const nodes = errorNodes(messages);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].agentErrorRun).toEqual({ runLength: 1, latest: true });
  });

  it('rate_limited 是不同 category：打断 auth 连续段；rate_limited 自己也可成段（渲染层不折叠它）', () => {
    const messages = [
      userMsg(), errMsg('auth'),
      userMsg(), errMsg('rate_limited'),
      userMsg(), errMsg('auth'),
      userMsg(), errMsg('rate_limited'),
      userMsg(), errMsg('rate_limited'),
    ];
    const runs = errorNodes(messages).map((n) => n.agentErrorRun);
    expect(runs).toEqual([
      { runLength: 1, latest: true }, // auth 被 rate_limited 打断，自成一段
      { runLength: 1, latest: true }, // rate_limited（被后面的 auth 打断）
      { runLength: 1, latest: true }, // auth（前一段已被打断）
      { runLength: 1, latest: false }, // rate_limited 被 auth 打断后重新起段，又被下一个 rate_limited 延续
      { runLength: 2, latest: true }, // 连续两个 rate_limited 的最新一条
    ]);
  });

  it('轮中带 toolCalls 的消息不打断连续段——那一轮可能还会失败', () => {
    const messages = [
      userMsg(), errMsg('auth'),
      userMsg(), toolMsg(), errMsg('auth'),
    ];
    const runs = errorNodes(messages).map((n) => n.agentErrorRun);
    expect(runs).toEqual([
      { runLength: 1, latest: false },
      { runLength: 2, latest: true },
    ]);
  });

  it('重载一致性：对同一份持久化消息（全新对象身份）重新投影，折叠结果逐条相同', () => {
    const buildHistory = () => {
      seq = 0;
      return [
        userMsg('第一问'), errMsg('auth'),
        userMsg('第二问'), errMsg('auth'),
        userMsg('第三问'), okMsg(),
        userMsg('第四问'), errMsg('network'),
      ];
    };
    const first = projectTurns(buildHistory(), 'session-1', false);
    const second = projectTurns(buildHistory(), 'session-1', false);
    const runsOf = (p: typeof first) => p.turns
      .flatMap((t) => t.nodes)
      .filter((n) => n.metadata?.agentError)
      .map((n) => ({ messageId: n.messageId, run: n.agentErrorRun }));
    expect(runsOf(second)).toEqual(runsOf(first));
  });

  it('端到端渲染：3 次同因 → 2 行灰字 + 1 张 role=alert 整卡（含连续次数句）', () => {
    const messages = [
      userMsg(), errMsg('auth'),
      userMsg(), errMsg('auth'),
      userMsg(), errMsg('auth'),
    ];
    const html = errorNodes(messages)
      .map((node) => renderToStaticMarkup(React.createElement(TraceNodeRenderer, { node })))
      .join('\n');

    expect((html.match(/agent-error-muted-line/g) ?? []).length).toBe(2);
    expect((html.match(/role="alert"/g) ?? []).length).toBe(1);
    expect(html).toContain('没有回复 · 账号没通过授权');
    expect(html).toContain('密钥可能填错、过期，或者额度用完了。<span>连续 3 次都是这个原因，再发也不会好。</span>');
    // 整卡动作不受折叠影响：auth 仍是换个模型 + 检查账号，无重试
    expect(html).toContain('换个模型');
    expect(html).toContain('检查账号');
    expect(html).not.toContain('检查账号设置');
    expect(html).not.toContain('连续 2 次');
  });

  it('同一轮内的重复报错（web 双路径形状）只算一次：3 轮各两条 → 仍是 2 行灰字 + 1 张整卡，与重载后一致', () => {
    const messages = [
      userMsg(), errMsg('auth'), errMsg('auth'),
      userMsg(), errMsg('auth'), errMsg('auth'),
      userMsg(), errMsg('auth'), errMsg('auth'),
    ];
    const runs = errorNodes(messages).map((n) => n.agentErrorRun);
    expect(runs).toEqual([
      { runLength: 1, latest: false, duplicate: true }, // e1 同轮重复，不渲染
      { runLength: 1, latest: false }, // e1b 本轮失败代表，下一轮来后降为灰字行
      { runLength: 2, latest: false, duplicate: true }, // e2
      { runLength: 2, latest: false }, // e2b
      { runLength: 3, latest: false, duplicate: true }, // e3
      { runLength: 3, latest: true }, // e3b 段内最新，整卡报「连续 3 次」
    ]);

    const html = errorNodes(messages)
      .map((node) => renderToStaticMarkup(React.createElement(TraceNodeRenderer, { node })))
      .join('\n');
    expect((html.match(/agent-error-muted-line/g) ?? []).length).toBe(2);
    expect((html.match(/role="alert"/g) ?? []).length).toBe(1);
    expect(html).toContain('连续 3 次都是这个原因，再发也不会好。');
  });

  it('端到端渲染：A,A,B → 灰字(A) + 整卡(A) + 整卡(B)，只有段内最新的卡报连续次数', () => {
    const messages = [
      userMsg(), errMsg('auth'),
      userMsg(), errMsg('auth'),
      userMsg(), errMsg('network'),
    ];
    const html = errorNodes(messages)
      .map((node) => renderToStaticMarkup(React.createElement(TraceNodeRenderer, { node })))
      .join('\n');

    expect((html.match(/agent-error-muted-line/g) ?? []).length).toBe(1);
    expect((html.match(/role="alert"/g) ?? []).length).toBe(2);
    expect(html).toContain('连续 2 次都是这个原因，再发也不会好。');
    expect(html).toContain('暂时连不上模型服务');
  });
});
