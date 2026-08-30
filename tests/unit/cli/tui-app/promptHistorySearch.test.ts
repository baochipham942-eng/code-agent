// ============================================================================
// PromptHistory.search（Ctrl+R 历史搜索）单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import { PromptHistory } from '../../../../src/cli/tui-app/editorState';

describe('PromptHistory.search', () => {
  it('空 query 返回全部（新的在前）', () => {
    const history = new PromptHistory();
    history.push('first');
    history.push('second');
    expect(history.search('')).toEqual(['second', 'first']);
  });

  it('子串匹配（大小写不敏感），新的在前', () => {
    const history = new PromptHistory();
    history.push('fix the Bug');
    history.push('unrelated');
    history.push('bugfix follow-up');
    expect(history.search('bug')).toEqual(['bugfix follow-up', 'fix the Bug']);
  });

  it('无匹配返回空数组', () => {
    const history = new PromptHistory();
    history.push('hello');
    expect(history.search('zzz')).toEqual([]);
  });

  it('query 只过滤，不影响 ↑↓ 浏览状态', () => {
    const history = new PromptHistory();
    history.push('a');
    history.push('b');
    history.search('a');
    expect(history.prev('')).toBe('b');
  });
});
