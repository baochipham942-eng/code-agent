// @vitest-environment jsdom
// ============================================================================
// composer 上下文分槽：会话 ⟂ 空间 ⟂ 草稿
// ----------------------------------------------------------------------------
// 产品负责人 2026-08-05 真机反馈：
// 1) 空间/草稿发起会话后 pin/专家/技能要移交到新会话
// 2) 会话配置不得漏进空间页；回会话要还原
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_SCOPE_KEY,
  emptyComposerSlot,
  isDraftOrSpaceScopeKey,
  planScopeHandoffToSession,
  sessionScopeKey,
  spaceScopeKey,
} from '../../../src/renderer/stores/composerScopeModel';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const setSessionPinMock = vi.fn(async (sessionId: string, itemIds: string[]) => ({
  sessionId,
  itemIds,
  addedAt: Date.now(),
}));

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  setSessionPin: (sessionId: string, itemIds: string[]) => setSessionPinMock(sessionId, itemIds),
  getSessionPin: vi.fn(),
  listLibraryItems: vi.fn(async () => []),
}));

function resetComposer() {
  useComposerStore.setState({
    workingDirectory: null,
    routingMode: 'auto',
    targetAgentIds: [],
    browserSessionMode: 'none',
    selectedSkillIds: [],
    selectedConnectorIds: [],
    selectedMcpServerIds: [],
    turnCapabilityScopeMode: 'auto',
    selectedTeamRecipeId: null,
    standbyExcludedMemberKeys: [],
    pendingCommand: null,
    pendingPinItemIds: [],
    pendingActiveAgentId: null,
    activeScopeKey: DRAFT_SCOPE_KEY,
    slots: {},
    hydratedSessionId: null,
  });
  useAppStore.setState({
    activeAgentId: null,
    activeAgentSessionKey: null,
    previewTabs: [],
    activePreviewTabId: null,
  });
  localStorage.clear();
  setSessionPinMock.mockClear();
}

describe('composerScopeModel pure helpers', () => {
  it('builds stable scope keys', () => {
    expect(sessionScopeKey('s1')).toBe('session:s1');
    expect(spaceScopeKey('proj-a')).toBe('space:proj-a');
    expect(spaceScopeKey(null)).toBe('space:none');
    expect(spaceScopeKey('  ')).toBe('space:none');
    expect(isDraftOrSpaceScopeKey(DRAFT_SCOPE_KEY)).toBe(true);
    expect(isDraftOrSpaceScopeKey(spaceScopeKey('p'))).toBe(true);
    expect(isDraftOrSpaceScopeKey(sessionScopeKey('s'))).toBe(false);
  });

  it('plans handoff: moves live choices to session slot and clears source', () => {
    const sourceLive = emptyComposerSlot({
      selectedSkillIds: ['skill-a'],
      pendingPinItemIds: ['lib-1', 'lib-2'],
      pendingActiveAgentId: 'expert-x',
      turnCapabilityScopeMode: 'manual',
    });
    const plan = planScopeHandoffToSession({
      slots: {},
      sourceKey: spaceScopeKey('proj-1'),
      sourceLive,
      newSessionId: 'sess-new',
    });

    expect(plan.sessionKey).toBe('session:sess-new');
    expect(plan.pinItemIds).toEqual(['lib-1', 'lib-2']);
    expect(plan.activeAgentId).toBe('expert-x');
    expect(plan.sessionSlot.selectedSkillIds).toEqual(['skill-a']);
    expect(plan.sessionSlot.pendingPinItemIds).toEqual([]);
    expect(plan.sessionSlot.pendingActiveAgentId).toBeNull();
    expect(plan.nextSlots[spaceScopeKey('proj-1')]).toEqual(emptyComposerSlot());
    expect(plan.nextSlots['session:sess-new']?.selectedSkillIds).toEqual(['skill-a']);
  });
});

describe('composerStore scope switching', () => {
  beforeEach(() => {
    resetComposer();
  });

  it('switching to space does not leak session skills; returning restores them', () => {
    const store = useComposerStore.getState();
    store.hydrateFromSession('session-a', '/tmp/a');
    store.setSelectedSkillIds(['session-skill']);
    store.setSelectedConnectorIds(['mail']);
    expect(useComposerStore.getState().selectedSkillIds).toEqual(['session-skill']);

    // 切到空间：会话配置应收进槽，live 变空
    store.activateScope(spaceScopeKey('proj-1'), { workingDirectory: '/tmp/space' });
    const onSpace = useComposerStore.getState();
    expect(onSpace.activeScopeKey).toBe('space:proj-1');
    expect(onSpace.selectedSkillIds).toEqual([]);
    expect(onSpace.selectedConnectorIds).toEqual([]);
    expect(onSpace.workingDirectory).toBe('/tmp/space');

    // 空间自己配置
    useComposerStore.getState().setSelectedSkillIds(['space-skill']);
    expect(useComposerStore.getState().selectedSkillIds).toEqual(['space-skill']);

    // 回会话：会话原配置还原，空间配置不泄漏
    useComposerStore.getState().activateScope(sessionScopeKey('session-a'));
    const back = useComposerStore.getState();
    expect(back.activeScopeKey).toBe('session:session-a');
    expect(back.selectedSkillIds).toEqual(['session-skill']);
    expect(back.selectedConnectorIds).toEqual(['mail']);
    expect(back.workingDirectory).toBe('/tmp/a');

    // 再进空间：空间自己的配置还在
    useComposerStore.getState().activateScope(spaceScopeKey('proj-1'));
    expect(useComposerStore.getState().selectedSkillIds).toEqual(['space-skill']);
  });

  it('draft and session slots stay isolated', () => {
    const store = useComposerStore.getState();
    // 草稿选 skill
    store.setSelectedSkillIds(['draft-skill']);
    expect(store.activeScopeKey).toBe(DRAFT_SCOPE_KEY);

    store.hydrateFromSession('session-b', '/tmp/b');
    expect(useComposerStore.getState().selectedSkillIds).toEqual([]);
    useComposerStore.getState().setSelectedSkillIds(['sess-skill']);

    useComposerStore.getState().hydrateFromSession(null, null);
    expect(useComposerStore.getState().activeScopeKey).toBe(DRAFT_SCOPE_KEY);
    expect(useComposerStore.getState().selectedSkillIds).toEqual(['draft-skill']);
  });

  it('applySessionWorkbenchPreset still only mutates live state (no scope rebind)', () => {
    const store = useComposerStore.getState();
    store.hydrateFromSession('current-session', '/tmp/current');
    store.applySessionWorkbenchPreset({
      workingDirectory: '/tmp/reused',
      workbenchSnapshot: {
        summary: 'review',
        labels: ['review'],
        recentToolNames: [],
        routingMode: 'auto',
        skillIds: ['snap'],
        connectorIds: [],
        mcpServerIds: [],
      },
      workbenchProvenance: {
        capturedAt: Date.now(),
        workingDirectory: '/tmp/reused',
        routingMode: 'direct',
        targetAgentIds: ['agent-1'],
        selectedSkillIds: ['review-skill'],
        selectedConnectorIds: [],
        selectedMcpServerIds: [],
        // browserSessionMode 无浏览器会话时不写（类型只收 desktop|managed）
        executionIntent: {},
      },
    });

    expect(useComposerStore.getState()).toMatchObject({
      hydratedSessionId: 'current-session',
      activeScopeKey: 'session:current-session',
      workingDirectory: '/tmp/reused',
      routingMode: 'direct',
      targetAgentIds: ['agent-1'],
      selectedSkillIds: ['review-skill'],
    });
  });
});

describe('composerStore handoffActiveScopeToSession', () => {
  beforeEach(() => {
    resetComposer();
  });

  it('handoffs space selections including pin materialization and expert bind', async () => {
    const store = useComposerStore.getState();
    store.activateScope(spaceScopeKey('proj-space'));
    store.setSelectedSkillIds(['space-skill']);
    store.setPendingPinItemIds(['pin-1', 'pin-2']);
    // 空间上选专家：仅内存（activeAgentSessionKey=null）
    useAppStore.setState({ activeAgentSessionKey: null, activeAgentId: 'expert-z' });

    await store.handoffActiveScopeToSession('new-sess');

    const after = useComposerStore.getState();
    expect(after.activeScopeKey).toBe('session:new-sess');
    expect(after.hydratedSessionId).toBe('new-sess');
    expect(after.selectedSkillIds).toEqual(['space-skill']);
    expect(after.pendingPinItemIds).toEqual([]);
    // 发起槽已清空
    expect(after.slots[spaceScopeKey('proj-space')]).toEqual(emptyComposerSlot());

    expect(setSessionPinMock).toHaveBeenCalledWith('new-sess', ['pin-1', 'pin-2']);
    expect(useAppStore.getState().activeAgentId).toBe('expert-z');
    // bindAgentForSession 应写入 map
    const map = JSON.parse(localStorage.getItem('app:activeAgentIdBySession') || '{}') as Record<string, string>;
    expect(map['new-sess']).toBe('expert-z');
  });

  it('handoffs draft pin intent to new session', async () => {
    const store = useComposerStore.getState();
    expect(store.activeScopeKey).toBe(DRAFT_SCOPE_KEY);
    store.setPendingPinItemIds(['draft-pin']);
    store.setSelectedSkillIds(['draft-skill']);

    await store.handoffActiveScopeToSession('from-draft');

    expect(useComposerStore.getState().selectedSkillIds).toEqual(['draft-skill']);
    expect(setSessionPinMock).toHaveBeenCalledWith('from-draft', ['draft-pin']);
    expect(useComposerStore.getState().slots[DRAFT_SCOPE_KEY]).toEqual(emptyComposerSlot());
  });

  it('from session scope does not copy skills; just activates empty session slot', async () => {
    const store = useComposerStore.getState();
    store.hydrateFromSession('old-sess', '/tmp/old');
    store.setSelectedSkillIds(['old-skill']);

    await store.handoffActiveScopeToSession('brand-new');

    const after = useComposerStore.getState();
    expect(after.activeScopeKey).toBe('session:brand-new');
    expect(after.selectedSkillIds).toEqual([]);
    expect(setSessionPinMock).not.toHaveBeenCalled();
    // 旧会话槽仍保留
    expect(after.slots['session:old-sess']?.selectedSkillIds).toEqual(['old-skill']);
  });

  it('resetForSuccessfulSend keeps target agents in direct mode and clears team/command only', () => {
    const store = useComposerStore.getState();
    store.setRoutingMode('direct');
    store.setTargetAgentIds(['a1']);
    store.setSelectedTeamRecipeId('team-1');
    store.setPendingCommand({ id: 'goal', name: 'goal' } as never);

    store.resetForSuccessfulSend();

    expect(useComposerStore.getState()).toMatchObject({
      targetAgentIds: ['a1'],
      selectedTeamRecipeId: null,
      pendingCommand: null,
    });
  });
});
