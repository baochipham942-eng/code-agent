// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  composerDraftStorageKey,
  readComposerDraft,
} from '../../../src/renderer/components/features/chat/ChatInput/composerDraftStore';
import { adoptHomeDraft, findBlankSessionWithDraft } from '../../../src/renderer/stores/sessionBootDraft';

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

  it('findBlankSessionWithDraft ignores blank sessions without a stored draft', () => {
    storeDraft('b2', 'x');
    const sessions = [{ id: 'b1', blank: true }, { id: 'b2', blank: true }, { id: 'b3', blank: false }];
    expect(findBlankSessionWithDraft(sessions, (s) => s.blank)?.id).toBe('b2');
    expect(findBlankSessionWithDraft([{ id: 'b1', blank: true }], (s) => s.blank)).toBeNull();
  });

  it('adoptHomeDraft moves the home draft onto the new session and clears the home key', () => {
    storeDraft(null, 'typed while no session existed');
    adoptHomeDraft('fresh');
    expect(readComposerDraft(composerDraftStorageKey('fresh', false))).toBe('typed while no session existed');
    expect(readComposerDraft(composerDraftStorageKey(null, false))).toBeNull();
  });

  it('adoptHomeDraft never overwrites an existing session draft', () => {
    storeDraft(null, 'home text');
    storeDraft('fresh', 'session text');
    adoptHomeDraft('fresh');
    expect(readComposerDraft(composerDraftStorageKey('fresh', false))).toBe('session text');
  });
});
