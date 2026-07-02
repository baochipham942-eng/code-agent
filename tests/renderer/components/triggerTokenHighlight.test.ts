import { describe, expect, it } from 'vitest';
import { parseLeadingTriggerToken } from '../../../src/renderer/components/features/chat/MessageBubble/triggerTokenHighlight';

describe('parseLeadingTriggerToken（核心功能触发词着色）', () => {
  it('recognizes leading @neo (case-insensitive) and keeps the rest verbatim', () => {
    const parsed = parseLeadingTriggerToken('@neo 帮我查上海FDE最新薪资');
    expect(parsed).toMatchObject({ token: '@neo', kind: 'neo' });
    expect(parsed?.rest).toBe(' 帮我查上海FDE最新薪资');
    expect(parsed?.className).toContain('emerald');

    expect(parseLeadingTriggerToken('@Neo 做个事')?.token).toBe('@Neo');
  });

  it('recognizes /goal and /workflow with their own styles', () => {
    const goal = parseLeadingTriggerToken('/goal 跑通全部测试 --verify "npm test"');
    expect(goal).toMatchObject({ token: '/goal', kind: 'goal' });
    expect(goal?.className).toContain('amber');

    const workflow = parseLeadingTriggerToken('/workflow 扇出 5 个 agent 审代码');
    expect(workflow).toMatchObject({ token: '/workflow', kind: 'workflow' });
    // 彩虹渐变文字
    expect(workflow?.className).toContain('bg-clip-text');
    expect(workflow?.className).toContain('text-transparent');
  });

  it('preserves leading whitespace as prefix so the bubble text stays byte-identical', () => {
    const parsed = parseLeadingTriggerToken('  @neo 做事');
    expect(parsed?.prefix).toBe('  ');
    expect(`${parsed?.prefix}${parsed?.token}${parsed?.rest}`).toBe('  @neo 做事');
  });

  it('does not match mid-text mentions, partial words, or plain messages', () => {
    expect(parseLeadingTriggerToken('请 @neo 帮个忙')).toBeNull();
    expect(parseLeadingTriggerToken('@neophyte 是什么')).toBeNull();
    expect(parseLeadingTriggerToken('/goals 清单')).toBeNull();
    expect(parseLeadingTriggerToken('普通消息')).toBeNull();
    expect(parseLeadingTriggerToken('/workflowX')).toBeNull();
  });

  it('matches a bare token with no trailing text', () => {
    expect(parseLeadingTriggerToken('/workflow')?.kind).toBe('workflow');
    expect(parseLeadingTriggerToken('@neo')?.kind).toBe('neo');
  });
});
