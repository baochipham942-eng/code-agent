import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_OVERRIDE_METADATA_KEY,
  clearPersistedModelOverride,
  persistModelOverride,
  readPersistedModelOverride,
  rehydrateModelOverrideFromSession,
} from '../../../src/host/session/modelOverridePersistence';
import { getModelSessionState, resetModelSessionState } from '../../../src/host/session/modelSessionState';

const sessionManagerMocks = vi.hoisted(() => ({
  patchSessionMetadata: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManagerMocks,
}));

describe('modelOverridePersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelSessionState();
    sessionManagerMocks.patchSessionMetadata.mockResolvedValue(true);
  });

  afterEach(() => {
    resetModelSessionState();
  });

  describe('readPersistedModelOverride', () => {
    it('returns null for missing session / missing marker / malformed marker', () => {
      expect(readPersistedModelOverride(null)).toBeNull();
      expect(readPersistedModelOverride({ id: 's1' })).toBeNull();
      expect(readPersistedModelOverride({ id: 's1', metadata: {} })).toBeNull();
      expect(
        readPersistedModelOverride({ id: 's1', metadata: { [MODEL_OVERRIDE_METADATA_KEY]: 'oops' } }),
      ).toBeNull();
      expect(
        readPersistedModelOverride({ id: 's1', metadata: { [MODEL_OVERRIDE_METADATA_KEY]: { provider: 'zhipu' } } }),
      ).toBeNull();
    });

    it('parses a valid marker including optional fields', () => {
      const parsed = readPersistedModelOverride({
        id: 's1',
        metadata: {
          [MODEL_OVERRIDE_METADATA_KEY]: {
            provider: 'zhipu',
            model: 'glm-5',
            temperature: 0.3,
            maxTokens: 4096,
            adaptive: false,
            setAt: 1234,
          },
        },
      });
      expect(parsed).toEqual({
        provider: 'zhipu',
        model: 'glm-5',
        temperature: 0.3,
        maxTokens: 4096,
        adaptive: false,
        setAt: 1234,
      });
    });
  });

  describe('persistModelOverride', () => {
    it('patches the marker key and model columns atomically, returning persisted=true', async () => {
      const ok = await persistModelOverride('s1', { provider: 'zhipu', model: 'glm-5' });

      expect(ok).toBe(true);
      expect(sessionManagerMocks.patchSessionMetadata).toHaveBeenCalledTimes(1);
      const [sessionId, patch, options] = sessionManagerMocks.patchSessionMetadata.mock.calls[0];
      expect(sessionId).toBe('s1');
      expect(patch[MODEL_OVERRIDE_METADATA_KEY]).toMatchObject({ provider: 'zhipu', model: 'glm-5' });
      expect(typeof patch[MODEL_OVERRIDE_METADATA_KEY].setAt).toBe('number');
      expect(options.modelConfig).toEqual({ provider: 'zhipu', model: 'glm-5' });
    });

    it('does not write model columns for adaptive (auto-routing) overrides', async () => {
      await persistModelOverride('s1', { provider: 'zhipu', model: 'glm-5', adaptive: true });

      const [, patch, options] = sessionManagerMocks.patchSessionMetadata.mock.calls[0];
      expect(options.modelConfig).toBeUndefined();
      expect(patch[MODEL_OVERRIDE_METADATA_KEY]).toMatchObject({ adaptive: true });
    });

    it('returns false without throwing when session is missing or DB fails (audit R1-HIGH2)', async () => {
      sessionManagerMocks.patchSessionMetadata.mockResolvedValue(false);
      expect(await persistModelOverride('gone', { provider: 'zhipu', model: 'glm-5' })).toBe(false);

      sessionManagerMocks.patchSessionMetadata.mockRejectedValue(new Error('db down'));
      expect(await persistModelOverride('s1', { provider: 'zhipu', model: 'glm-5' })).toBe(false);
    });

    it('serializes persist/clear per session — DB ops apply in call order (audit R1-HIGH1)', async () => {
      const applied: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      sessionManagerMocks.patchSessionMetadata
        .mockImplementationOnce(async (...args: unknown[]) => {
          await firstGate; // 模拟慢写
          applied.push(`persist:${JSON.stringify((args[1] as Record<string, unknown>)[MODEL_OVERRIDE_METADATA_KEY] ?? null)}`);
          return true;
        })
        .mockImplementationOnce(async (...args: unknown[]) => {
          applied.push(`clear:${JSON.stringify((args[1] as Record<string, unknown>)[MODEL_OVERRIDE_METADATA_KEY] ?? null)}`);
          return true;
        });

      const p1 = persistModelOverride('s1', { provider: 'zhipu', model: 'glm-5' });
      const p2 = clearPersistedModelOverride('s1');
      releaseFirst();
      await Promise.all([p1, p2]);

      expect(applied[0]).toContain('persist:');
      expect(applied[1]).toBe('clear:null');
    });
  });

  describe('clearPersistedModelOverride', () => {
    it('patches the marker key to null', async () => {
      const ok = await clearPersistedModelOverride('s1');

      expect(ok).toBe(true);
      const [sessionId, patch] = sessionManagerMocks.patchSessionMetadata.mock.calls[0];
      expect(sessionId).toBe('s1');
      expect(patch).toEqual({ [MODEL_OVERRIDE_METADATA_KEY]: null });
    });

    it('returns false when session is missing or DB fails', async () => {
      sessionManagerMocks.patchSessionMetadata.mockRejectedValue(new Error('db down'));
      expect(await clearPersistedModelOverride('s1')).toBe(false);
    });
  });

  describe('rehydrateModelOverrideFromSession', () => {
    it('repopulates the in-memory map from a persisted marker', () => {
      const restored = rehydrateModelOverrideFromSession({
        id: 's1',
        metadata: {
          [MODEL_OVERRIDE_METADATA_KEY]: { provider: 'zhipu', model: 'glm-5', adaptive: false, setAt: 1 },
        },
      });

      expect(restored).toMatchObject({ provider: 'zhipu', model: 'glm-5' });
      expect(getModelSessionState().getOverride('s1')).toMatchObject({ provider: 'zhipu', model: 'glm-5' });
    });

    it('leaves untouched sessions that never switched (creation snapshot only)', () => {
      // sessions.model_provider/model_name 是建会话快照——没有 metadata 标记就不回灌，
      // 否则老会话会被钉死在建会话时的默认模型上。
      const restored = rehydrateModelOverrideFromSession({
        id: 's1',
        modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      } as never);

      expect(restored).toBeNull();
      expect(getModelSessionState().getOverride('s1')).toBeNull();
    });

    it('never overwrites a fresher in-memory override', () => {
      getModelSessionState().setOverride('s1', { provider: 'deepseek', model: 'deepseek-chat' });

      const restored = rehydrateModelOverrideFromSession({
        id: 's1',
        metadata: { [MODEL_OVERRIDE_METADATA_KEY]: { provider: 'zhipu', model: 'glm-5', setAt: 1 } },
      });

      expect(restored).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
      expect(getModelSessionState().getOverride('s1')).toMatchObject({ provider: 'deepseek' });
    });

    it('restores adaptive (auto-routing) mode', () => {
      const restored = rehydrateModelOverrideFromSession({
        id: 's1',
        metadata: { [MODEL_OVERRIDE_METADATA_KEY]: { provider: 'zhipu', model: 'glm-5', adaptive: true, setAt: 1 } },
      });

      expect(restored?.adaptive).toBe(true);
    });
  });
});
