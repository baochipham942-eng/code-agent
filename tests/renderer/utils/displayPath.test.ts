import { describe, expect, it } from 'vitest';
import { formatDisplayPath, middleEllipsis } from '../../../src/renderer/utils/displayPath';

describe('formatDisplayPath', () => {
  it('keeps short paths intact', () => {
    expect(formatDisplayPath('notes.md')).toBe('notes.md');
    expect(formatDisplayPath('src/index.ts')).toBe('src/index.ts');
  });

  it('prefers last two segments with a leading ellipsis', () => {
    expect(formatDisplayPath('/Users/me/project/docs/报告.md'))
      .toBe('…/docs/报告.md');
  });

  it('never tail-truncates the filename into …/artifacts/foo.m…', () => {
    const long = '/Users/linchen/Downloads/ai/code-agent/artifacts/overview-batch2-note.md';
    const shown = formatDisplayPath(long, 40);
    // 末尾必须是完整文件名或中段省略，不能是 `note.m…` 这种尾截断
    expect(shown.endsWith('…')).toBe(false);
    expect(shown).toMatch(/overview-batch2-note\.md$/);
    expect(shown).not.toMatch(/note\.m…$/);
    expect(shown).not.toMatch(/m…$/);
  });

  it('middle-ellipsizes an overlong bare filename while keeping ends', () => {
    const name = 'a'.repeat(30) + '-middle-' + 'b'.repeat(30) + '.md';
    const shown = formatDisplayPath(name, 24);
    expect(shown.includes('…')).toBe(true);
    expect(shown.startsWith('a')).toBe(true);
    expect(shown.endsWith('.md') || shown.endsWith('d')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(24);
  });
});

describe('middleEllipsis', () => {
  it('returns original when under budget', () => {
    expect(middleEllipsis('hello', 10)).toBe('hello');
  });

  it('splits budget across head and tail', () => {
    expect(middleEllipsis('abcdefghij', 7)).toBe('abc…hij');
  });
});
