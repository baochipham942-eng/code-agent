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
  getSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManagerMocks,
}));

describe('modelOverridePersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelSessionState();
    sessionManagerMocks.updateSession.mockResolvedValue(undefined);
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
    it('writes model columns and merges the metadata marker (preserving existing keys)', async () => {
      sessionManagerMocks.getSession.mockResolvedValue({
        id: 's1',
        metadata: { existing: 'keep' },
      });

      const ok = await persistModelOverride('s1', { provider: 'zhipu', model: 'glm-5' });

      expect(ok).toBe(true);
      expect(sessionManagerMocks.updateSession).toHaveBeenCalledTimes(1);
      const [sessionId, updates] = sessionManagerMocks.updateSession.mock.calls[0];
      expect(sessionId).toBe('s1');
      expect(updates.modelConfig).toEqual({ provider: 'zhipu', model: 'glm-5' });
      expect(updates.metadata.existing).toBe('keep');
      expect(updates.metadata[MODEL_OVERRIDE_METADATA_KEY]).toMatchObject({
        provider: 'zhipu',
        model: 'glm-5',
      });
      expect(typeof updates.metadata[MODEL_OVERRIDE_METADATA_KEY].setAt).toBe('number');
    });

    it('does not write model columns for adaptive (auto-routing) overrides', async () => {
      sessionManagerMocks.getSession.mockResolvedValue({ id: 's1' });

      await persistModelOverride('s1', { provider: 'zhipu', model: 'glm-5', adaptive: true });

      const [, updates] = sessionManagerMocks.updateSession.mock.calls[0];
      expect(updates.modelConfig).toBeUndefined();
      expect(updates.metadata[MODEL_OVERRIDE_METADATA_KEY]).toMatchObject({ adaptive: true });
    });

    it('returns false without throwing when session is missing or DB fails', async () => {
      sessionManagerMocks.getSession.mockResolvedValue(null);
      expect(await persistModelOverride('gone', { provider: 'zhipu', model: 'glm-5' })).toBe(false);
      expect(sessionManagerMocks.updateSession).not.toHaveBeenCalled();

      sessionManagerMocks.getSession.mockResolvedValue({ id: 's1' });
      sessionManagerMocks.updateSession.mockRejectedValue(new Error('db down'));
      expect(await persistModelOverride('s1', { provider: 'zhipu', model: 'glm-5' })).toBe(false);
    });
  });

  describe('clearPersistedModelOverride', () => {
    it('removes the marker while preserving other metadata keys', async () => {
      sessionManagerMocks.getSession.mockResolvedValue({
        id: 's1',
        metadata: { existing: 'keep', [MODEL_OVERRIDE_METADATA_KEY]: { provider: 'zhipu', model: 'glm-5', setAt: 1 } },
      });

      const ok = await clearPersistedModelOverride('s1');

      expect(ok).toBe(true);
      const [, updates] = sessionManagerMocks.updateSession.mock.calls[0];
      expect(updates.metadata.existing).toBe('keep');
      expect(MODEL_OVERRIDE_METADATA_KEY in updates.metadata).toBe(false);
    });

    it('is a no-op when no marker is persisted', async () => {
      sessionManagerMocks.getSession.mockResolvedValue({ id: 's1', metadata: { existing: 'keep' } });

      await clearPersistedModelOverride('s1');

      expect(sessionManagerMocks.updateSession).not.toHaveBeenCalled();
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
