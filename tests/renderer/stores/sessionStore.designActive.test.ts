import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

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
