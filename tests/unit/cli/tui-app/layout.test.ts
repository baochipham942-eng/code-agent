// ============================================================================
// tui-app/layout.ts — 钉顶行布局预算分配 单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  allocateLiveBudget,
  editorVisualRows,
  messageLineCost,
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
  it('assistant = markdown 行数 + margin', () => {
    // 纯文本段落，宽 20：27 字符 reflow 后 2 行 + 1 margin = 3
    const cost = messageLineCost(assistant('hello world foo bar baz qux'), 20);
    expect(cost).toBe(3);
  });

  it('thinking 运行中 = 标题 + 尾部 ≤3 行 + margin', () => {
    expect(messageLineCost(thinking(2), 80)).toBe(1 + 2 + 1);
    expect(messageLineCost(thinking(10), 80)).toBe(1 + 3 + 1);
  });

  it('tool_group 单行 + margin', () => {
    expect(messageLineCost(toolGroup(), 80)).toBe(2);
  });
});

describe('allocateLiveBudget', () => {
  it('预算充足：全量分配', () => {
    const messages = [assistant('短'), toolGroup()];
    const allocation = allocateLiveBudget(messages, 80, 100);
    expect(allocation.get('a1')).toBe(2);
    expect(allocation.get('t1')).toBe(2);
  });

  it('预算不足：从最旧开始砍，最旧一条截尾', () => {
    const messages = [assistant('第一行\n第二行\n第三行\n第四行'), toolGroup()];
    // tool_group 要 2 行，assistant 全量要 5 行；给 4 → assistant 只剩 2
    const allocation = allocateLiveBudget(messages, 80, 4);
    expect(allocation.get('t1')).toBe(2);
    expect(allocation.get('a1')).toBe(2);
  });

  it('预算为 0：空分配', () => {
    const allocation = allocateLiveBudget([assistant('x')], 80, 0);
    expect(allocation.size).toBe(0);
  });

  it('最新优先：中间消息被淘汰', () => {
    const messages = [toolGroup(), { ...assistant('新'), id: 'a2' }];
    const allocation = allocateLiveBudget(messages, 80, 2);
    expect(allocation.has('a2')).toBe(true);
    expect(allocation.has('t1')).toBe(false);
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
