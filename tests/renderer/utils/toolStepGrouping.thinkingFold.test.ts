// ============================================================================
// 过渡轮 thinking 收纳进 tool_group
// 背景：Think 模式下每轮推理产生一个"无正文、纯 thinking"的过渡节点，
// 此前它会打断相邻工具的聚合（[tool][thinking][tool] → 两个组 + 独立 thinking 行），
// 满屏 "▶ thinking" 且流式期间反复成组/拆组导致跳动。
// 现在：过渡节点被吸收进前面的 tool buffer，相邻工具合并为一个组，
// thinking 挂在组上由 ToolStepGroup 内部弱化展示。
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { TraceNode } from '@shared/contract/trace';
import { groupAdjacentToolCalls } from '../../../src/renderer/utils/toolStepGrouping';

let nextId = 0;
function toolNode(name: string): TraceNode {
  nextId += 1;
  return {
    id: `tool-${nextId}`,
    type: 'tool_call',
    content: '',
    timestamp: nextId,
    toolCall: { id: `call-${nextId}`, name, args: {} },
  } as TraceNode;
}

function thinkingNode(thinking: string, extra: Partial<TraceNode> = {}): TraceNode {
  nextId += 1;
  return {
    id: `assistant-${nextId}`,
    type: 'assistant_text',
    content: '',
    timestamp: nextId,
    thinking,
    ...extra,
  } as TraceNode;
}

function textNode(content: string): TraceNode {
  nextId += 1;
  return {
    id: `assistant-${nextId}`,
    type: 'assistant_text',
    content,
    timestamp: nextId,
  } as TraceNode;
}

describe('groupAdjacentToolCalls — 过渡 thinking 收纳', () => {
  it('absorbs thinking-only nodes between tool calls into one merged group', () => {
    const result = groupAdjacentToolCalls([
      toolNode('ToolSearch'),
      thinkingNode('先找截图工具'),
      toolNode('Bash'),
      thinkingNode('截好了，开始分析'),
      toolNode('image_analyze'),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('tool_group');
    if (result[0].kind === 'tool_group') {
      expect(result[0].tools.map((n) => n.toolCall?.name)).toEqual([
        'ToolSearch', 'Bash', 'image_analyze',
      ]);
      expect(result[0].thinkingNodes?.map((n) => n.thinking)).toEqual([
        '先找截图工具', '截好了，开始分析',
      ]);
    }
  });

  it('keeps thinking-only nodes standalone when no preceding tool buffer exists', () => {
    const result = groupAdjacentToolCalls([
      thinkingNode('开场思考'),
      toolNode('Bash'),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('node');
    expect(result[1].kind).toBe('tool_group');
  });

  it('keeps nodes with real content standalone and splits the group', () => {
    const result = groupAdjacentToolCalls([
      toolNode('Bash'),
      textNode('中段说明文字'),
      toolNode('Read'),
    ]);

    expect(result.map((d) => d.kind)).toEqual(['tool_group', 'node', 'tool_group']);
  });

  it('keeps thinking nodes carrying a model decision chip standalone', () => {
    const result = groupAdjacentToolCalls([
      toolNode('Bash'),
      thinkingNode('带路由决策的思考', {
        modelDecision: { provider: 'xiaomi' } as TraceNode['modelDecision'],
      }),
      toolNode('Read'),
    ]);

    expect(result.map((d) => d.kind)).toEqual(['tool_group', 'node', 'tool_group']);
  });

  it('does not let hoisted turn-timeline nodes (hook/skill banners) split the group', () => {
    nextId += 1;
    const hookNode = {
      id: `timeline-${nextId}`,
      type: 'assistant_text',
      content: '',
      timestamp: nextId,
      turnTimeline: { kind: 'hook_activity' },
    } as unknown as TraceNode;

    const result = groupAdjacentToolCalls([
      toolNode('Bash'),
      hookNode,
      toolNode('Read'),
    ]);

    const groups = result.filter((d) => d.kind === 'tool_group');
    expect(groups).toHaveLength(1);
    if (groups[0].kind === 'tool_group') {
      expect(groups[0].tools).toHaveLength(2);
    }
  });
});
