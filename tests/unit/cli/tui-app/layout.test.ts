// ============================================================================
// tui-app/layout.ts — 钉顶行布局预算分配 单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  editorVisualRows,
  hitLiveToolGroup,
  messageLineCost,
  partitionScrollback,
  planDynamicLayout,
} from '../../../../src/cli/tui-app/layout';
import type { ChatMessage } from '../../../../src/cli/tui-app/events';
import { createEditorState, insertText } from '../../../../src/cli/tui-app/editorState';

function assistant(text: string): ChatMessage {
  return { id: 'a1', kind: 'assistant', text, streaming: true };
}

function toolGroup(): ChatMessage {
  return {
    id: 't1',
    kind: 'tool_group',
    name: 'read_file',
    activeVerb: 'Reading',
    doneVerb: 'Read',
    groupNoun: 'file',
    calls: [{
      id: 'c1', name: 'read_file', activeVerb: 'Reading', doneVerb: 'Read',
      summary: '/a.ts', status: 'running', startedAt: 0,
    }],
    status: 'running',
  };
}

function thinking(lineCount: number): ChatMessage {
  return {
    id: 'th1',
    kind: 'thinking',
    text: Array.from({ length: lineCount }, (_, i) => `思考 ${i}`).join('\n'),
    startedAt: 0,
  };
}

describe('messageLineCost', () => {
  it('assistant = markdown 行数 + marginTop 1', () => {
    // 纯文本段落，宽 20：27 字符 reflow 后 2 行 + 1 = 3
    const cost = messageLineCost(assistant('hello world foo bar baz qux'), 20);
    expect(cost).toBe(3);
  });

  it('thinking 运行中 = 标题 + 尾部 ≤3 行 + marginTop 1', () => {
    expect(messageLineCost(thinking(2), 80)).toBe(1 + 2 + 1);
    expect(messageLineCost(thinking(10), 80)).toBe(1 + 3 + 1);
  });

  it('tool_group 单行 + marginTop 1', () => {
    expect(messageLineCost(toolGroup(), 80)).toBe(2);
  });
});

describe('allocateLiveBudget（经 planDynamicLayout 验证分配语义）', () => {
  it('预算充足：全量分配', () => {
    const messages = [assistant('短'), toolGroup()];
    const plan = planDynamicLayout(messages, 80, 100, 6);
    expect(plan.height).toBe(100);
    expect(plan.allocation.get('a1')).toBe(2);
    expect(plan.allocation.get('t1')).toBe(2);
  });

  it('预算不足：从最旧开始砍，最旧一条截尾', () => {
    const messages = [assistant('```\n第一行\n第二行\n第三行\n第四行\n```'), toolGroup()];
    const plan = planDynamicLayout(messages, 80, 44, 40);
    expect(plan.height).toBe(44);
    expect(plan.allocation.get('t1')).toBe(2);
    expect(plan.allocation.get('a1')).toBe(2);
  });

  it('预算为 0：空分配', () => {
    const plan = planDynamicLayout([assistant('x')], 80, 40, 40);
    expect(plan.allocation.size).toBe(0);
  });

  it('最新优先：中间消息被淘汰', () => {
    const messages = [toolGroup(), { ...assistant('新'), id: 'a2' }];
    // 预算 2（rows 42 - chrome 40）：a2 全量 2 行吃满，t1 被淘汰
    const plan = planDynamicLayout(messages, 80, 42, 40);
    expect(plan.allocation.has('a2')).toBe(true);
    expect(plan.allocation.has('t1')).toBe(false);
  });
});

describe('editorVisualRows', () => {
  it('单行 1 行，多行/超宽累加且封顶 maxRows', () => {
    let state = createEditorState();
    expect(editorVisualRows(state, 76, 10)).toBe(1);
    state = insertText(state, 'a\nb\nc');
    expect(editorVisualRows(state, 76, 10)).toBe(3);
    state = insertText(state, '\nd\ne\nf\ng\nh\ni\nj\nk\nl');
    expect(editorVisualRows(state, 76, 10)).toBe(10);
  });
});

describe('planDynamicLayout（全屏钉底布局）', () => {
  // system 消息成本 = ceil(文本显示宽/width) + 1（marginTop）
  const msg = (id: string, text: string) => ({
    id,
    kind: 'system' as const,
    tone: 'info' as const,
    text,
  });

  it('内容不满一屏：高度恒等于终端行高，消息全量不截断（留白在内容之上）', () => {
    // width=10：'x'*19 → 2 行 → 成本 3；'x'*29 → 3 行 → 成本 4
    const messages = [msg('a', 'x'.repeat(19)), msg('b', 'x'.repeat(29))];
    const plan = planDynamicLayout(messages, 10, 40, 6);
    expect(plan.height).toBe(40);
    expect(plan.allocation.get('a')).toBe(3);
    expect(plan.allocation.get('b')).toBe(4);
  });

  it('空消息：高度=终端行高（首屏输入区钉底）', () => {
    const plan = planDynamicLayout([], 10, 40, 5);
    expect(plan.height).toBe(40);
    expect(plan.allocation.size).toBe(0);
  });

  it('内容超高：满高 + 尾部预算分配', () => {
    // 每条成本 ceil(200/10)+1 = 21，两条 42 > 预算 34
    const messages = [msg('a', 'x'.repeat(200)), msg('b', 'x'.repeat(200))];
    const plan = planDynamicLayout(messages, 10, 40, 6);
    expect(plan.height).toBe(40);
    // 预算 34：最新的 b 全量 21，a 只分到 13（截尾）
    expect(plan.allocation.get('b')).toBe(21);
    expect(plan.allocation.get('a')).toBe(13);
  });

  it('恰好等于预算：全量不截断', () => {
    // 成本 ceil(330/10)+1 = 34 = 预算 34
    const messages = [msg('a', 'x'.repeat(330))];
    const plan = planDynamicLayout(messages, 10, 40, 6);
    expect(plan.height).toBe(40);
    expect(plan.allocation.get('a')).toBe(34);
  });
});

describe('partitionScrollback', () => {
  it('短会话全进 live，Static 为空（不上下各画一份）', () => {
    const messages = [assistant('短'), toolGroup()];
    const plan = planDynamicLayout(messages, 80, 40, 6);
    const { scrollback, live } = partitionScrollback(messages, plan.allocation);
    expect(scrollback).toEqual([]);
    expect(live.map((m) => m.id)).toEqual(['a1', 't1']);
  });

  it('被预算挤出的已封口消息才进 Static，与 live 无交集', () => {
    const oldUser: ChatMessage = { id: 'u1', kind: 'user', text: 'old' };
    const huge = assistant('```\n' + 'line\n'.repeat(40) + '```');
    const messages = [oldUser, huge];
    const plan = planDynamicLayout(messages, 80, 24, 8);
    const { scrollback, live } = partitionScrollback(messages, plan.allocation);
    const liveIds = new Set(live.map((m) => m.id));
    const scrollIds = new Set(scrollback.map((m) => m.id));
    expect([...liveIds].some((id) => scrollIds.has(id))).toBe(false);
    expect(scrollIds.has('u1') || liveIds.has('u1')).toBe(true);
  });

  it('从 live 区底部命中 tool_group', () => {
    const group: ChatMessage = {
      id: 't1',
      kind: 'tool_group',
      name: 'read_file',
      activeVerb: 'Reading',
      doneVerb: 'Read',
      groupNoun: 'file',
      calls: [{
        id: 'c1', name: 'read_file', activeVerb: 'Reading', doneVerb: 'Read',
        summary: '/a.ts', status: 'done', startedAt: 0,
      }],
      status: 'done',
    };
    const plan = planDynamicLayout([group], 80, 20, 6);
    const { live } = partitionScrollback([group], plan.allocation);
    expect(hitLiveToolGroup(14, live, plan.allocation, 20, 6)).toBe('t1');
    expect(hitLiveToolGroup(20, live, plan.allocation, 20, 6)).toBeNull();
  });

  it('流式中的 assistant 即使预算内也不进 Static', () => {
    const streaming = assistant('正在写');
    const plan = planDynamicLayout([streaming], 80, 40, 6);
    const { scrollback, live } = partitionScrollback([streaming], plan.allocation);
    expect(scrollback).toEqual([]);
    expect(live).toEqual([streaming]);
  });
});
