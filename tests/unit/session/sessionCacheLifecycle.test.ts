import { describe, expect, it, vi } from 'vitest';

const lifecycleMocks = vi.hoisted(() => ({
  clearSessionCachePrompt: vi.fn(),
  clearSessionCacheHits: vi.fn(),
  releaseMemoryIndexSnapshot: vi.fn(),
  releaseToolSearchSession: vi.fn(),
}));

vi.mock('../../../src/host/agent/runtime/turnCostPersistence', () => ({
  clearSessionCachePrompt: lifecycleMocks.clearSessionCachePrompt,
}));

vi.mock('../../../src/host/model/cacheHitObservation', () => ({
  clearSessionCacheHits: lifecycleMocks.clearSessionCacheHits,
}));

vi.mock('../../../src/host/lightMemory/indexLoader', () => ({
  releaseMemoryIndexSnapshot: lifecycleMocks.releaseMemoryIndexSnapshot,
}));

vi.mock('../../../src/host/services/toolSearch/toolSearchService', () => ({
  getToolSearchService: () => ({ releaseSession: lifecycleMocks.releaseToolSearchSession }),
}));

import { clearSessionRuntimeCaches } from '../../../src/host/session/sessionCacheLifecycle';

describe('clearSessionRuntimeCaches', () => {
  it('releases the memory index snapshot with the other session caches', () => {
    clearSessionRuntimeCaches('session-ended');

    expect(lifecycleMocks.clearSessionCachePrompt).toHaveBeenCalledWith('session-ended');
    expect(lifecycleMocks.clearSessionCacheHits).toHaveBeenCalledWith('session-ended');
    expect(lifecycleMocks.releaseToolSearchSession).toHaveBeenCalledWith('session-ended');
    expect(lifecycleMocks.releaseMemoryIndexSnapshot).toHaveBeenCalledWith('session-ended');
  });
});
