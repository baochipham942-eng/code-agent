import { afterEach, describe, expect, it } from 'vitest';
import {
  getPersistenceHealth,
  setDbAvailable,
} from '../../../src/web/helpers/sessionCache';

afterEach(() => {
  setDbAvailable(false, new Error('test reset'));
});

describe('web session persistence health', () => {
  it('reports durable database persistence when DB is available', () => {
    setDbAvailable(true);

    expect(getPersistenceHealth()).toMatchObject({
      status: 'available',
      mode: 'database',
      durable: true,
      message: '历史会持久化到本机数据库。',
    });
  });

  it('reports memory-only fallback with the init failure reason', () => {
    setDbAvailable(false, new Error('native binding missing'));

    expect(getPersistenceHealth()).toMatchObject({
      status: 'unavailable',
      mode: 'memory',
      durable: false,
      message: '历史持久化不可用，当前只会话内有效。',
      reason: 'native binding missing',
    });
  });
});
