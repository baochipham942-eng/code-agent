// ADR-068 刀 4：断流续接的词表消费 —— host 落库的 [连接中断]/[生成中断] 正文标记（刀 3）
// 进 StreamInterruptionReason 稳定枚举；重载视图剥裸协议标记、断点段正文保留（不 suppression），
// cancelled/session-switch 的既有 suppression 行为零漂移；DecisionSlot 文案按词表派生。
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { resolveStreamInterruptionOutcomeKey, outcomeWordsZh } from '../../../src/renderer/i18n/outcomeWords';
import {
  deriveStreamInterruptionReason,
  streamInterruptionReasonFromContent,
  stripStreamBreakMarker,
} from '../../../src/renderer/utils/streamInterruptionPresentation';

const BREAK_PARTIAL: Message = {
  id: 'a1',
  role: 'assistant',
  content: 'PART1__断点片段。\n\n[连接中断 — 部分回答已保留]',
  timestamp: 2_000,
};

const ERROR_PARTIAL: Message = {
  id: 'a1e',
  role: 'assistant',
  content: '会沉没的片段。\n\n[生成中断 — 部分回答已保留]',
  timestamp: 2_000,
};

describe('断流标记 → StreamInterruptionReason 词表（ADR-068 刀 3 落库 / 刀 4 消费）', () => {
  it('两个断流标记都识别为 stream-break；既有 cancelled/session-switch 词表零漂移', () => {
    expect(streamInterruptionReasonFromContent(BREAK_PARTIAL.content)).toBe('stream-break');
    expect(streamInterruptionReasonFromContent(ERROR_PARTIAL.content)).toBe('stream-break');
    // 破折号全角/半角与空白都容错（对齐 SESSION_SWITCH_MARKER 的既有口径）
    expect(streamInterruptionReasonFromContent('片段\n\n[连接中断-部分回答已保留]')).toBe('stream-break');
    expect(streamInterruptionReasonFromContent('被打停止\n\n[cancelled]')).toBe('user');
    expect(streamInterruptionReasonFromContent('中断\n\n[未完成 — 切换会话中断]')).toBe('session-switch');
    expect(streamInterruptionReasonFromContent('正常回答')).toBeNull();
  });

  it('stripStreamBreakMarker：剥掉尾部标记与前导空白；无标记原样返回', () => {
    expect(stripStreamBreakMarker(BREAK_PARTIAL.content)).toBe('PART1__断点片段。');
    expect(stripStreamBreakMarker('片段\n\n[生成中断 — 部分回答已保留]\n')).toBe('片段');
    expect(stripStreamBreakMarker('正文中间[连接中断 — 部分回答已保留]不算尾部')).toBe(
      '正文中间[连接中断 — 部分回答已保留]不算尾部',
    );
    expect(stripStreamBreakMarker('普通正文')).toBe('普通正文');
  });

  it('耗尽态 DecisionSlot 的中断原因由落库标记派生：backward 扫描命中 stream-break', () => {
    expect(deriveStreamInterruptionReason([
      { id: 'u1', role: 'user', content: '写一段', timestamp: 1_000 },
      BREAK_PARTIAL,
    ])).toBe('stream-break');
    // 既有默认/取消路径零漂移
    expect(deriveStreamInterruptionReason([
      { id: 'u1', role: 'user', content: '写一段', timestamp: 1_000 },
      { id: 'a1', role: 'assistant', content: '被打停止\n\n[cancelled]', timestamp: 2_000 },
    ])).toBe('user');
  });

  it('词表闭环：stream-break → interrupted-stream-break，四个受众文案非空', () => {
    expect(resolveStreamInterruptionOutcomeKey('stream-break')).toBe('interrupted-stream-break');
    const copy = outcomeWordsZh.outcomeWords['interrupted-stream-break'];
    for (const audience of ['timeline', 'badge', 'detail', 'notification'] as const) {
      expect(copy[audience].label.trim()).not.toBe('');
      expect(copy[audience].reason.trim()).not.toBe('');
    }
  });
});

describe('重载视图投影：断点段保留 + 裸标记不上屏（ADR-068 刀 4）', () => {
  it('stream-break 断点段：正文保留（剥标记）+ metadata 带稳定枚举——真实答案的前半段不许消失', () => {
    const projection = projectTurns([
      { id: 'u1', role: 'user', content: '写一段', timestamp: 1_000 },
      BREAK_PARTIAL,
      { id: 'a2', role: 'assistant', content: 'PART2__续答正文。', timestamp: 3_000 },
    ], 'session-1', false);

    const textNodes = projection.turns.flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'assistant_text');
    expect(textNodes).toHaveLength(2);
    // 断点段：内容剥掉裸协议标记，中断语义进 metadata（样式行按枚举渲染）
    expect(textNodes[0].content).toBe('PART1__断点片段。');
    expect(textNodes[0].metadata?.streamInterruptionReason).toBe('stream-break');
    expect(textNodes[0].content).not.toContain('[');
    // 续答段不受影响
    expect(textNodes[1].content).toBe('PART2__续答正文。');
  });

  it('cancelled 中断消息的既有 suppression 行为零漂移（不因词表扩展误放开）', () => {
    const projection = projectTurns([
      { id: 'u1', role: 'user', content: '写一段', timestamp: 1_000 },
      { id: 'a1', role: 'assistant', content: '半截回答\n\n[cancelled]', timestamp: 2_000 },
    ], 'session-1', false);

    const textNodes = projection.turns.flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'assistant_text');
    expect(textNodes).toHaveLength(0); // cancelled 维持原规则：唯一信号由中断呈现承载
  });
});
