// ============================================================================
// advance → goal run 提案解析单测（P4 合流，docs/designs/swarm-goal.md §3.2）
// ============================================================================

import { describe, it, expect } from 'vitest';
import { parseAdvanceGoalProposal } from '../../../../src/main/services/roleAssets/roleProactivity';

describe('parseAdvanceGoalProposal', () => {
  it('提取 <goal> + <verify> 双标记', () => {
    const out = '我要修复测试。\n<goal>把 src/auth 测试修绿</goal>\n<verify>npm test -- src/auth</verify>\n<decision>advance</decision>';
    expect(parseAdvanceGoalProposal(out)).toEqual({ goal: '把 src/auth 测试修绿', verify: 'npm test -- src/auth' });
  });

  it('只有 <goal>（无 verify）→ verify 缺省', () => {
    const out = '<goal>把这段重构得更可读</goal>\n<decision>advance</decision>';
    expect(parseAdvanceGoalProposal(out)).toEqual({ goal: '把这段重构得更可读' });
  });

  it('无 <goal> 标记 → null（按普通 advance 处理，不发起 goal run）', () => {
    expect(parseAdvanceGoalProposal('我直接做完了。<decision>advance</decision>')).toBeNull();
  });

  it('空 <goal> → null', () => {
    expect(parseAdvanceGoalProposal('<goal>   </goal><decision>advance</decision>')).toBeNull();
  });

  it('trim 前后空白', () => {
    const out = '<goal>\n  跑通构建  \n</goal><verify>\n  npm run build \n</verify>';
    expect(parseAdvanceGoalProposal(out)).toEqual({ goal: '跑通构建', verify: 'npm run build' });
  });

  it('多行 goal 内容（[\\s\\S] 匹配换行）', () => {
    const out = '<goal>第一行\n第二行</goal>';
    expect(parseAdvanceGoalProposal(out)?.goal).toBe('第一行\n第二行');
  });
});
