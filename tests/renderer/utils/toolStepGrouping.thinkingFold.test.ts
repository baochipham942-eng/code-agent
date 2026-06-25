// ============================================================================
// 思考节点一律按真实时序独立成行（彻底线性）
// 背景：Think 模式下每轮推理产生一个"无正文、纯 thinking"的过渡节点。
// 旧行为把它吸收进前面的 tool buffer、由 ToolStepGroup 折叠在工具列表「之后」展示，
// 导致"思考"视觉上排到了工具执行的下面（与思考的真实发生时序相悖）。
// 新行为（对齐 Codex/OpenHands/Cline）：思考不再被工具组吸收，始终作为独立行
// 按到达时序渲染——工具前的思考排在工具上方，工具间的思考分隔两个组。
// 连续且中间无思考的工具仍合并成一个组（降噪不受影响）。
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

describe('groupAdjacentToolCalls — 思考按时序独立成行', () => {
  it('工具之间的思考拆分工具组，思考作为独立行排在它所先于的工具之前', () => {
    const result = groupAdjacentToolCalls([
      toolNode('ToolSearch'),
      thinkingNode('先找截图工具'),
      toolNode('Bash'),
      thinkingNode('截好了，开始分析'),
      toolNode('image_analyze'),
    ]);

    // 线性顺序：组 → 思考 → 组 → 思考 → 组（思考绝不折叠进工具组之后）
    expect(result.map((d) => d.kind)).toEqual([
      'tool_group', 'node', 'tool_group', 'node', 'tool_group',
    ]);
    // 思考内容作为独立节点保留，且不再挂在任何 tool_group 上
    expect(result[1].kind === 'node' && result[1].node.thinking).toBe('先找截图工具');
    expect(result[3].kind === 'node' && result[3].node.thinking).toBe('截好了，开始分析');
    for (const d of result) {
      if (d.kind === 'tool_group') {
        expect('thinkingNodes' in d).toBe(false);
      }
    }
  });

  it('连续且中间无思考的工具仍合并成一个组（降噪不变）', () => {
    const result = groupAdjacentToolCalls([
      toolNode('Read'),
      toolNode('Grep'),
      toolNode('Glob'),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('tool_group');
    if (result[0].kind === 'tool_group') {
      expect(result[0].tools.map((n) => n.toolCall?.name)).toEqual(['Read', 'Grep', 'Glob']);
    }
  });

  it('工具前的思考保持独立行，排在工具上方', () => {
    const result = groupAdjacentToolCalls([
      thinkingNode('开场思考'),
      toolNode('Bash'),
    ]);

    expect(result.map((d) => d.kind)).toEqual(['node', 'tool_group']);
    expect(result[0].kind === 'node' && result[0].node.thinking).toBe('开场思考');
  });

  it('带正文的节点同样拆分工具组', () => {
    const result = groupAdjacentToolCalls([
      toolNode('Bash'),
      textNode('中段说明文字'),
      toolNode('Read'),
    ]);

    expect(result.map((d) => d.kind)).toEqual(['tool_group', 'node', 'tool_group']);
  });

  it('hoisted turn-timeline 节点（hook/skill 横幅）不打断工具聚合', () => {
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
