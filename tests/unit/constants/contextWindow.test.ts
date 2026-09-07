import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  getContextWindow,
  resolveContextWindow,
} from '../../../src/shared/constants/defaults';

describe('resolveContextWindow', () => {
  it('表内模型 known=true', () => {
    const resolved = resolveContextWindow('LongCat-2.0');
    expect(resolved.known).toBe(true);
    expect(resolved.tokens).toBe(getContextWindow('LongCat-2.0'));
    expect(resolved.tokens).not.toBeUndefined();
  });

  it('未知模型 known=false，tokens 走 128k 兜底', () => {
    const resolved = resolveContextWindow('definitely-not-in-the-table-xyz');
    expect(resolved.known).toBe(false);
    expect(resolved.tokens).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('显式配置窗口 known=true', () => {
    expect(resolveContextWindow('anything', undefined, 200000)).toEqual({
      tokens: 200000,
      known: true,
    });
  });
});
