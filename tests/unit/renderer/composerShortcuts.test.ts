import { describe, it, expect } from 'vitest';
import {
  computeSlashMenuValue,
  shouldTriggerBareComposerShortcut,
} from '../../../src/renderer/utils/composerShortcuts';

describe('computeSlashMenuValue (T2 — 打开 slash 菜单不丢已输入文本)', () => {
  it('空输入时插入 /', () => {
    expect(computeSlashMenuValue('')).toBe('/');
  });
  it('已以 / 开头时保持不变', () => {
    expect(computeSlashMenuValue('/dep')).toBe('/dep');
  });
  it('非空且非 / 开头时不覆盖已输入文本(核心回归)', () => {
    expect(computeSlashMenuValue('hello world')).toBe('hello world');
    expect(computeSlashMenuValue('https://x/y')).toBe('https://x/y');
  });
});

describe('shouldTriggerBareComposerShortcut (T2 — 裸键只在空输入时拦截)', () => {
  it('composer 未聚焦 → 不拦截(让 / 正常输入)', () => {
    expect(shouldTriggerBareComposerShortcut({ composerFocused: false, value: '' })).toBe(false);
  });
  it('聚焦 + 空输入 → 触发命令', () => {
    expect(shouldTriggerBareComposerShortcut({ composerFocused: true, value: '' })).toBe(true);
  });
  it('聚焦 + 已有文本(即使光标行首) → 不拦截，避免菜单开但输入非 slash 的不一致态', () => {
    expect(shouldTriggerBareComposerShortcut({ composerFocused: true, value: 'foo' })).toBe(false);
  });
  it('聚焦 + 输入中途 → 不拦截(让 / 正常输入)', () => {
    expect(shouldTriggerBareComposerShortcut({ composerFocused: true, value: 'and' })).toBe(false);
  });
});
