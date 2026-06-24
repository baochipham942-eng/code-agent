import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import type { Session } from '../../../src/shared/contract';

describe('sessionStore per-session design-active flag', () => {
  beforeEach(() => {
    useSessionStore.setState({ designActiveSessions: new Set<string>() });
  });

  it('marks a session active and isolates per session', () => {
    useSessionStore.getState().markSessionDesignActive('s1');
    expect(useSessionStore.getState().isSessionDesignActive('s1')).toBe(true);
    expect(useSessionStore.getState().isSessionDesignActive('s2')).toBe(false);
  });

  it('clears the active flag for a session', () => {
    useSessionStore.getState().markSessionDesignActive('s1');
    useSessionStore.getState().clearSessionDesignActive('s1');
    expect(useSessionStore.getState().isSessionDesignActive('s1')).toBe(false);
  });

  it('is idempotent when marking the same session twice', () => {
    useSessionStore.getState().markSessionDesignActive('s1');
    expect(() => useSessionStore.getState().markSessionDesignActive('s1')).not.toThrow();
    expect(useSessionStore.getState().isSessionDesignActive('s1')).toBe(true);
    expect(useSessionStore.getState().designActiveSessions.size).toBe(1);
  });

  it('returns false for null or undefined session ids', () => {
    expect(useSessionStore.getState().isSessionDesignActive(null)).toBe(false);
    expect(useSessionStore.getState().isSessionDesignActive(undefined)).toBe(false);
  });
});

// M1：删除/归档会话时清掉 design-active 标记 + 释放画布属主，避免悬空状态。
describe('sessionStore design-active + canvas owner cleanup on delete/archive', () => {
  const mockDomainInvoke = vi.fn();

  function makeSession(id: string): Session {
    return { id, title: id, createdAt: 0, updatedAt: 0, messageCount: 0 } as unknown as Session;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDomainInvoke.mockResolvedValue({ success: true, data: {} });
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
      electronAPI: { invoke: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn() },
    };
    useSessionStore.setState({
      sessions: [makeSession('s1'), makeSession('s2')],
      currentSessionId: 's2', // 删非当前，避免触发 switchSession
      designActiveSessions: new Set<string>(['s1']),
    });
    useDesignCanvasStore.setState({ nodes: [], connectors: [], shapes: [], runDir: null, ownerSessionId: 's1' });
  });

  it('deleteSession clears design-active flag for the deleted session', async () => {
    await useSessionStore.getState().deleteSession('s1');
    expect(useSessionStore.getState().isSessionDesignActive('s1')).toBe(false);
  });

  it('deleteSession releases canvas owner when the deleted session owned the canvas', async () => {
    useDesignCanvasStore.setState({ ownerSessionId: 's1' });
    await useSessionStore.getState().deleteSession('s1');
    expect(useDesignCanvasStore.getState().ownerSessionId).toBeNull();
  });

  it('archiveSession clears design-active flag for the archived session', async () => {
    await useSessionStore.getState().archiveSession('s1');
    expect(useSessionStore.getState().isSessionDesignActive('s1')).toBe(false);
  });

  it('archiveSession releases canvas owner when the archived session owned the canvas', async () => {
    useDesignCanvasStore.setState({ ownerSessionId: 's1' });
    await useSessionStore.getState().archiveSession('s1');
    expect(useDesignCanvasStore.getState().ownerSessionId).toBeNull();
  });
});
