// @vitest-environment jsdom
// ============================================================================
// 预选团队 → 发第一句话即启动配方（这句话就是主题）
// ----------------------------------------------------------------------------
// 「＋ → 团队」选中只是预选（成员条先铺灰态名单），真正 launch 发生在发送那一刻。
// 这里钉三件事：走 launchRecipe 不走普通对话、预选态发完必须清、启动失败要把话还给用户。
// ============================================================================

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  launchRecipe: vi.fn(),
  launchTeamRecipe: vi.fn(),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({ invoke: mocks.invoke }));
vi.mock('../../../src/renderer/services/teamClient', () => ({ launchRecipe: mocks.launchRecipe, listRecipes: vi.fn() }));
vi.mock('../../../src/renderer/utils/launchTeamRecipe', () => ({ launchTeamRecipe: mocks.launchTeamRecipe }));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: mocks.toast }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { useChatInputSubmit, type UseChatInputSubmitParams } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';

const RECIPE = { id: 'r1', name: '上线评审', description: '', category: 'automation' as const, lead: { roleId: '牧之', briefTemplate: '汇总 {topic}' }, members: [{ roleId: '溯真', taskTemplate: '调研 {topic}' }] };

function makeParams(overrides: Partial<UseChatInputSubmitParams> = {}): UseChatInputSubmitParams {
  return {
    value: '帮我评审这次上线',
    attachments: [],
    voiceInputContext: null,
    pendingAppshot: null,
    pendingPromptCommand: null,
    pendingAgentSelection: null,
    currentSessionId: 'session-1',
    isProcessing: false,
    disabled: false,
    isUploading: false,
    onSend: vi.fn(),
    agentEntries: [],
    buildEnvelope: vi.fn(),
    openAgentCommand: vi.fn(),
    addToInputHistory: vi.fn(),
    clearAppshot: vi.fn(),
    inputAreaRef: { current: { focus: vi.fn() } } as React.RefObject<any>,
    setValue: vi.fn(),
    setAttachments: vi.fn(),
    setVoiceInputContext: vi.fn(),
    setPendingPromptCommand: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setScheduleComposerOpen: vi.fn(),
    openGoalConfirm: vi.fn(),
    closeGoalConfirm: vi.fn(),
    openSeedComposer: vi.fn(),
    setActiveAgentId: vi.fn(),
    ...overrides,
  };
}

async function submit(params: UseChatInputSubmitParams) {
  const { result } = renderHook(() => useChatInputSubmit(params));
  await act(async () => {
    await result.current.handleSubmit({ preventDefault: vi.fn() } as any);
  });
}

describe('预选团队配方的发送链路', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.launchRecipe.mockResolvedValue({ ok: true });
    mocks.launchTeamRecipe.mockResolvedValue({ ok: true });
    useTeamRecipeStore.setState({ recipes: [RECIPE], isLoaded: true });
    useComposerStore.setState({ selectedTeamRecipeId: 'r1' });
  });

  it('已有会话时用这句话当主题启动配方，不走普通对话', async () => {
    const onSend = vi.fn();
    await submit(makeParams({ onSend }));

    expect(mocks.launchRecipe).toHaveBeenCalledWith('session-1', 'r1', '帮我评审这次上线');
    expect(onSend).not.toHaveBeenCalled();
    expect(useComposerStore.getState().selectedTeamRecipeId).toBeNull();
  });

  it('还没有会话时先建会话再启动', async () => {
    await submit(makeParams({ currentSessionId: null }));

    expect(mocks.launchTeamRecipe).toHaveBeenCalledWith('r1', '上线评审', '帮我评审这次上线');
    expect(mocks.launchRecipe).not.toHaveBeenCalled();
  });

  it('启动失败要把话还回输入框并报错，不能静默吞掉', async () => {
    mocks.launchRecipe.mockResolvedValue({ ok: false, error: '成员缺失' });
    const setValue = vi.fn();
    await submit(makeParams({ setValue }));

    expect(setValue).toHaveBeenCalledWith('帮我评审这次上线');
    expect(mocks.toast.error).toHaveBeenCalledWith('成员缺失');
  });

  it('配方已被删掉时清掉预选，这句话按普通消息发出去', async () => {
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    const onSend = vi.fn().mockResolvedValue(true);
    await submit(makeParams({ onSend, buildEnvelope: vi.fn(() => ({ content: '帮我评审这次上线' })) as never }));

    expect(mocks.launchRecipe).not.toHaveBeenCalled();
    expect(useComposerStore.getState().selectedTeamRecipeId).toBeNull();
    expect(onSend).toHaveBeenCalled();
  });
});
