import { describe, expect, it } from 'vitest';
import type { TraceNode, TraceTurn } from '../../../src/shared/contract/trace';
import {
  TURN_RAIL_MIN_TURNS,
  buildTurnRailItems,
  getTurnFinalTextNode,
} from '../../../src/renderer/utils/turnRailItems';

function node(type: TraceNode['type'], content: string, extra: Partial<TraceNode> = {}): TraceNode {
  return { id: `${type}-${content.slice(0, 8)}-${Math.random()}`, type, content, timestamp: 1, ...extra };
}

function turn(turnNumber: number, nodes: TraceNode[]): TraceTurn {
  return { turnNumber, turnId: `turn-${turnNumber}`, nodes, status: 'completed', startTime: turnNumber };
}

describe('buildTurnRailItems', () => {
  it('每轮一项：用户那句做提示预览、最后一条有正文的 Neo 回复做结论预览', () => {
    const items = buildTurnRailItems([
      turn(1, [node('user', '把封面标题改成《8 月客户之声周报》'), node('assistant_text', ''), node('assistant_text', '标题已更新，封面和页眉同步改好。')]),
      turn(2, [node('user', '再加页码'), node('tool_call', 'Edit'), node('assistant_text', '页码加好了。')]),
    ]);
    expect(items).toEqual([
      { turnId: 'turn-1', turnNumber: 1, prompt: '把封面标题改成《8 月客户之声周报》', response: '标题已更新，封面和页眉同步改好。' },
      { turnId: 'turn-2', turnNumber: 2, prompt: '再加页码', response: '页码加好了。' },
    ]);
  });

  it('预览折叠换行并按 50 / 120 字截断加省略号', () => {
    const longPrompt = '一'.repeat(60);
    const longResponse = '二'.repeat(130);
    const [item] = buildTurnRailItems([
      turn(1, [node('user', `第一行\n\n  第二行  `), node('assistant_text', `结论第一行\n结论第二行`)]),
    ]);
    expect(item.prompt).toBe('第一行 第二行');
    expect(item.response).toBe('结论第一行 结论第二行');
    const [clipped] = buildTurnRailItems([turn(2, [node('user', longPrompt), node('assistant_text', longResponse)])]);
    expect(clipped.prompt).toBe(`${'一'.repeat(50)}…`);
    expect(clipped.response).toBe(`${'二'.repeat(120)}…`);
  });

  it('没有文字的轮（图片/命令）预览留空，由界面按序号显示', () => {
    const [item] = buildTurnRailItems([turn(3, [node('user', '   '), node('tool_call', 'Bash')])]);
    expect(item).toEqual({ turnId: 'turn-3', turnNumber: 3, prompt: '', response: '' });
  });

  it('语音派活轮的结论跳过带 voiceDispatch 的指令节点（与 TurnCard 折叠视图同口径）', () => {
    const dispatchNode = node('assistant_text', '改写后的派活指令', { metadata: { voiceDispatch: { workItemId: 'w1' } } as TraceNode['metadata'] });
    const voiceTurn = turn(4, [node('user', '帮我整理周报'), node('assistant_text', '整理好了'), dispatchNode]);
    expect(getTurnFinalTextNode(voiceTurn, true)?.content).toBe('整理好了');
    expect(getTurnFinalTextNode(voiceTurn, false)?.content).toBe('改写后的派活指令');
  });

  it('出现门槛是 8 轮（爸 09-02 定：短会话不需要导航）', () => {
    expect(TURN_RAIL_MIN_TURNS).toBe(8);
  });
});
