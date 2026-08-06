import { describe, expect, it } from 'vitest';
import { shortSessionIdForFileName } from '../../../src/shared/utils/id';

/**
 * 回归：导出文件名曾用 sessionId.slice(0, 8)，而 Neo 的 id 形如
 * `session_<时间戳>_<hash>`，前 8 位恒为 `session_`。两个不同会话导出到同一
 * 目录会静默互相覆盖（真机实测：297KB 的包被 5.9KB 的包盖掉）。
 */
describe('shortSessionIdForFileName', () => {
  it('区分同前缀的不同会话', () => {
    const a = shortSessionIdForFileName('session_1785817007068_bb5753c3');
    const b = shortSessionIdForFileName('session_1785678897223_92bd8012');
    expect(a).not.toBe(b);
    expect(a).toBe('bb5753c3');
    expect(b).toBe('92bd8012');
  });

  it('产出的片段只含文件名安全字符，且不含点或路径分隔符', () => {
    for (const id of [
      'session_1785817007068_bb5753c3',
      '550e8400-e29b-41d4-a716-446655440000',
      'migrated-abc12345-def67890',
      'session/../../etc/passwd',
      'sess:2*?<>|"3',
    ]) {
      expect(shortSessionIdForFileName(id)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('对退化输入给出稳定占位而不是空串', () => {
    expect(shortSessionIdForFileName('')).toBe('session');
    expect(shortSessionIdForFileName('///')).toBe('session');
  });

  it('短 id 原样保留', () => {
    expect(shortSessionIdForFileName('abc123')).toBe('abc123');
    expect(shortSessionIdForFileName('sess-2')).toBe('sess-2');
  });
});
