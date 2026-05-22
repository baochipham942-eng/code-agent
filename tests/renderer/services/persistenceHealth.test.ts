import { describe, expect, it } from 'vitest';
import {
  getPersistenceWarningText,
  shouldShowPersistenceWarning,
} from '../../../src/renderer/services/persistenceHealth';
import type { PersistenceHealth } from '../../../src/shared/contract';

const unavailable = {
  status: 'unavailable',
  mode: 'memory',
  durable: false,
  message: '历史持久化不可用，当前只会话内有效。',
  checkedAt: 10,
} satisfies PersistenceHealth;

const available = {
  status: 'available',
  mode: 'database',
  durable: true,
  message: '历史会持久化到本机数据库。',
  checkedAt: 20,
} satisfies PersistenceHealth;

describe('persistence health renderer helpers', () => {
  it('shows warnings only for non-durable persistence', () => {
    expect(shouldShowPersistenceWarning(unavailable)).toBe(true);
    expect(shouldShowPersistenceWarning(available)).toBe(false);
    expect(shouldShowPersistenceWarning(null)).toBe(false);
  });

  it('keeps a clear fallback warning when health text is missing', () => {
    expect(getPersistenceWarningText(unavailable)).toBe('历史持久化不可用，当前只会话内有效。');
    expect(getPersistenceWarningText(null)).toBe('历史持久化不可用，当前只会话内有效。');
  });
});
