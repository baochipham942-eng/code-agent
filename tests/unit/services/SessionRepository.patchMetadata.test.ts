// Codex audit R1-MED1：metadata 整列替换 read-modify-write race
// → key 级同步补丁 API（单次同步调用内读-合并-写，对其他 JS 调用方原子）
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';

function createFakeDb(initialMetadata: string | null, rowExists = true) {
  const state = { metadata: initialMetadata, modelProvider: 'xiaomi', modelName: 'mimo-v2.5-pro', updatedAt: 1, writes: 0 };
  const db = {
    prepare: (sql: string) => ({
      get: () => (rowExists ? { metadata: state.metadata } : undefined),
      run: (...params: unknown[]) => {
        state.writes += 1;
        if (sql.includes('SET metadata')) {
          const [metadata, provider, model, updatedAt] = params as [string, string | null, string | null, number];
          state.metadata = metadata;
          if (provider) state.modelProvider = provider;
          if (model) state.modelName = model;
          state.updatedAt = updatedAt;
        }
        return { changes: rowExists ? 1 : 0 };
      },
      all: () => [],
    }),
    transaction: (fn: (...args: unknown[]) => unknown) => fn,
  };
  return { db, state };
}

function makeRepo(db: unknown) {
  return new SessionRepository(db as never);
}

describe('SessionRepository.patchSessionMetadata', () => {
  it('merges patch keys into existing metadata, preserving other keys', () => {
    const { db, state } = createFakeDb(JSON.stringify({ foo: 1 }));
    const repo = makeRepo(db);

    const ok = repo.patchSessionMetadata('s1', { modelOverride: { provider: 'zhipu', model: 'glm-5', setAt: 9 } }, { updatedAt: 42 });

    expect(ok).toBe(true);
    expect(JSON.parse(state.metadata!)).toEqual({
      foo: 1,
      modelOverride: { provider: 'zhipu', model: 'glm-5', setAt: 9 },
    });
    expect(state.updatedAt).toBe(42);
  });

  it('null value deletes the key', () => {
    const { db, state } = createFakeDb(JSON.stringify({ foo: 1, modelOverride: { provider: 'zhipu', model: 'glm-5' } }));
    const repo = makeRepo(db);

    expect(repo.patchSessionMetadata('s1', { modelOverride: null }, { updatedAt: 42 })).toBe(true);
    expect(JSON.parse(state.metadata!)).toEqual({ foo: 1 });
  });

  it('deleting an absent key is a no-op without a write (no timestamp churn)', () => {
    const { db, state } = createFakeDb(JSON.stringify({ foo: 1 }));
    const repo = makeRepo(db);

    expect(repo.patchSessionMetadata('s1', { modelOverride: null }, { updatedAt: 42 })).toBe(true);
    expect(state.writes).toBe(0);
    expect(state.updatedAt).toBe(1);
  });

  it('optionally writes model columns in the same atomic call', () => {
    const { db, state } = createFakeDb(null);
    const repo = makeRepo(db);

    repo.patchSessionMetadata(
      's1',
      { modelOverride: { provider: 'zhipu', model: 'glm-5', setAt: 9 } },
      { modelConfig: { provider: 'zhipu', model: 'glm-5' }, updatedAt: 42 },
    );

    expect(state.modelProvider).toBe('zhipu');
    expect(state.modelName).toBe('glm-5');
  });

  it('returns false when the session row does not exist', () => {
    const { db } = createFakeDb(null, false);
    const repo = makeRepo(db);

    expect(repo.patchSessionMetadata('gone', { modelOverride: null })).toBe(false);
  });
});
