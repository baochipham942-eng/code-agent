// @vitest-environment jsdom
// ============================================================================
// activeAgentId per-session 收敛（三层一致性批③ S3）
// ----------------------------------------------------------------------------
// 此前 activeAgentId 是 localStorage 全局单值（'app:activeAgentId'），
// /agent 选择跨会话残留：会话 A 选 Explorer，会话 B 的每次发送都静默带上
// preferredAgentId=explorer。收敛为 per-session map（'app:activeAgentIdBySession'），
// 会话切换/创建/删除各自同步；legacy 全局 key 一次性丢弃（无法归属会话）。
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const LEGACY_KEY = 'app:activeAgentId';
const SESSION_MAP_KEY = 'app:activeAgentIdBySession';

describe('appStore activeAgentId per-session', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ activeAgentId: null, activeAgentSessionKey: null });
  });

  it('setActiveAgentId 写入当前会话作用域，切换会话后不残留', () => {
    const s = useAppStore.getState();
    s.syncActiveAgentForSession('session-a');
    useAppStore.getState().setActiveAgentId('explore');
    expect(useAppStore.getState().activeAgentId).toBe('explore');

    useAppStore.getState().syncActiveAgentForSession('session-b');
    expect(useAppStore.getState().activeAgentId).toBeNull();

    useAppStore.getState().syncActiveAgentForSession('session-a');
    expect(useAppStore.getState().activeAgentId).toBe('explore');
  });

  it('per-session 选择持久化到 localStorage map', () => {
    useAppStore.getState().syncActiveAgentForSession('session-a');
    useAppStore.getState().setActiveAgentId('coder');

    const stored = JSON.parse(localStorage.getItem(SESSION_MAP_KEY) || '{}') as Record<string, string>;
    expect(stored['session-a']).toBe('coder');
  });

  it('清除选择（null）同时从 map 移除', () => {
    useAppStore.getState().syncActiveAgentForSession('session-a');
    useAppStore.getState().setActiveAgentId('coder');
    useAppStore.getState().setActiveAgentId(null);

    expect(useAppStore.getState().activeAgentId).toBeNull();
    const stored = JSON.parse(localStorage.getItem(SESSION_MAP_KEY) || '{}') as Record<string, string>;
    expect(stored['session-a']).toBeUndefined();
  });

  it('legacy 全局 key 在会话同步时被丢弃（跨会话残留 bug 根源）', () => {
    localStorage.setItem(LEGACY_KEY, 'explore');
    useAppStore.getState().syncActiveAgentForSession('session-a');

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(useAppStore.getState().activeAgentId).toBeNull();
  });

  it('draft（无会话）期间的选择在会话创建时继承（inheritCurrent）', () => {
    useAppStore.getState().syncActiveAgentForSession(null);
    useAppStore.getState().setActiveAgentId('coder');
    expect(useAppStore.getState().activeAgentId).toBe('coder');

    useAppStore.getState().syncActiveAgentForSession('session-new', { inheritCurrent: true });
    expect(useAppStore.getState().activeAgentId).toBe('coder');
    const stored = JSON.parse(localStorage.getItem(SESSION_MAP_KEY) || '{}') as Record<string, string>;
    expect(stored['session-new']).toBe('coder');
  });

  it('会话删除时清理对应 map 条目', () => {
    useAppStore.getState().syncActiveAgentForSession('session-a');
    useAppStore.getState().setActiveAgentId('coder');
    useAppStore.getState().syncActiveAgentForSession('session-b');

    useAppStore.getState().clearActiveAgentForSession('session-a');
    const stored = JSON.parse(localStorage.getItem(SESSION_MAP_KEY) || '{}') as Record<string, string>;
    expect(stored['session-a']).toBeUndefined();

    useAppStore.getState().syncActiveAgentForSession('session-a');
    expect(useAppStore.getState().activeAgentId).toBeNull();
  });

  it('同步到 null 会话（清空当前会话）→ 选择归零', () => {
    useAppStore.getState().syncActiveAgentForSession('session-a');
    useAppStore.getState().setActiveAgentId('coder');

    useAppStore.getState().syncActiveAgentForSession(null);
    expect(useAppStore.getState().activeAgentId).toBeNull();
  });
});
