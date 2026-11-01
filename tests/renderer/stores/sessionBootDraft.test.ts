// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  composerDraftStorageKey,
  readComposerDraft,
} from '../../../src/renderer/components/features/chat/ChatInput/composerDraftStore';
import { openInitialSession } from '../../../src/renderer/stores/sessionBootDraft';

const mockDomainInvoke = vi.fn();

function wireSession(id: string, title: string, messageCount: number, updatedAt: number) {
  return {
    id,
    title,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt,
    messageCount,
    turnCount: messageCount,
  };
}

function storeDraft(sessionId: string | null, text: string) {
  localStorage.setItem(composerDraftStorageKey(sessionId, false)!, JSON.stringify({ v: 1, text }));
}

describe('cold boot lands on the session that holds the unsent draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    (globalThis as Record<string, unknown>).window = Object.assign(window, {
      domainAPI: { invoke: mockDomainInvoke },
    });
  });

  it('initializeSessionStore opens the blank draft session even when another session is newer', async () => {
    storeDraft('blank', 'long task description typed on the home box');
    const list = [wireSession('busy', '其他任务', 3, 20), wireSession('blank', '新对话', 0, 10)];
    mockDomainInvoke.mockImplementation(async (_d: string, action: string, payload?: { sessionId?: string }) => {
      if (action === 'list') return { success: true, data: list };
      if (action === 'load') {
        const found = list.find((s) => s.id === payload?.sessionId) ?? list[0];
        return { success: true, data: { ...found, messages: [], todos: [] } };
      }
      return { success: true, data: [] };
    });
    const { initializeSessionStore, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    await initializeSessionStore();
    expect(useSessionStore.getState().currentSessionId).toBe('blank');
  });

  it('re-sign-in at boot (auth change) also reopens the blank draft session', async () => {
    storeDraft('blank', 'draft typed before the account state flipped');
    const list = [wireSession('busy', '其他任务', 3, 20), wireSession('blank', '新对话', 0, 10)];
    mockDomainInvoke.mockImplementation(async (_d: string, action: string, payload?: { sessionId?: string }) => {
      if (action === 'list') return { success: true, data: list };
      if (action === 'load') {
        const found = list.find((s) => s.id === payload?.sessionId) ?? list[0];
        return { success: true, data: { ...found, messages: [], todos: [] } };
      }
      return { success: true, data: [] };
    });
    const { initializeSessionStore, reloadSessionsForAuthChange, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    await initializeSessionStore();
    await reloadSessionsForAuthChange({ principalChanged: true });
    expect(useSessionStore.getState().currentSessionId).toBe('blank');
  });

  it('initializeSessionStore keeps the newest session when no blank session holds a draft', async () => {
    storeDraft('busy', 'draft in a session that already has messages');
    const list = [wireSession('busy', '其他任务', 3, 20), wireSession('blank', '新对话', 0, 10)];
    mockDomainInvoke.mockImplementation(async (_d: string, action: string, payload?: { sessionId?: string }) => {
      if (action === 'list') return { success: true, data: list };
      if (action === 'load') {
        const found = list.find((s) => s.id === payload?.sessionId) ?? list[0];
        return { success: true, data: { ...found, messages: [], todos: [] } };
      }
      return { success: true, data: [] };
    });
    const { initializeSessionStore, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    await initializeSessionStore();
    expect(useSessionStore.getState().currentSessionId).toBe('busy');
  });

  it('with no sessions the home draft moves onto the created session and the home key is cleared', async () => {
    storeDraft(null, 'typed while no session existed');
    const switchSession = vi.fn();
    await openInitialSession({
      sessions: [], isBlank: () => true, switchSession, createSession: async () => ({ id: 'fresh' }),
    });
    expect(switchSession).not.toHaveBeenCalled();
    expect(readComposerDraft(composerDraftStorageKey('fresh', false))).toBe('typed while no session existed');
    expect(readComposerDraft(composerDraftStorageKey(null, false))).toBeNull();
  });

  it('never overwrites an existing draft on the created session', async () => {
    storeDraft(null, 'home text');
    storeDraft('fresh', 'session text');
    await openInitialSession({
      sessions: [], isBlank: () => true, switchSession: vi.fn(), createSession: async () => ({ id: 'fresh' }),
    });
    expect(readComposerDraft(composerDraftStorageKey('fresh', false))).toBe('session text');
  });

  it('skips blank sessions that hold no draft', async () => {
    storeDraft('b2', 'x');
    const switchSession = vi.fn();
    await openInitialSession({
      sessions: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }],
      isBlank: (s) => s.id !== 'b3',
      switchSession,
      createSession: vi.fn(),
    });
    expect(switchSession).toHaveBeenCalledWith('b2');
  });
});
