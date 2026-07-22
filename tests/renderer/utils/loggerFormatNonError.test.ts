import { describe, expect, it } from 'vitest';
import { formatNonErrorValue } from '../../../src/renderer/utils/logger';

describe('formatNonErrorValue', () => {
  it('保留普通对象的正文（此前 String() 出 [object Object]）', () => {
    expect(formatNonErrorValue({ code: 8001, detail: 'team failed' }))
      .toBe('{"code":8001,"detail":"team failed"}');
  });

  it('字符串原样返回，不加引号', () => {
    expect(formatNonErrorValue('boom')).toBe('boom');
  });

  it('循环引用退回 String()，不抛', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatNonErrorValue(circular)).toBe('[object Object]');
  });
});
