// @vitest-environment jsdom
//
// 建团队 / 建角色确认卡：入口不再发裸 `/create-team`，而是就地弹卡收一句话再带内容提交。

import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seedComposerMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeDomain: vi.fn(),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  invoke: seedComposerMocks.invoke,
  invokeDomain: seedComposerMocks.invokeDomain,
  default: { invoke: seedComposerMocks.invoke, invokeDomain: seedComposerMocks.invokeDomain },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: seedComposerMocks.toast }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import {
  SeedComposerCard,
  buildSeedComposerCommand,
  getBareSeedComposerKind,
} from '../../../src/renderer/components/features/chat/ChatInput/SeedComposerCard';
import {
  useChatInputSubmit,
  type UseChatInputSubmitParams,
} from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';

function makeParams(overrides: Partial<UseChatInputSubmitParams> = {}): UseChatInputSubmitParams {
  return {
    value: '/create-team',
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
    inputAreaRef: { current: { focus: vi.fn() } } as unknown as UseChatInputSubmitParams['inputAreaRef'],
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

describe('建团队 / 建角色确认卡', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedComposerMocks.invokeDomain.mockResolvedValue([{ roleId: '研究员' }]);
  });
  afterEach(() => cleanup());

  it('只有裸指令才认作"要弹卡"，带了内容的照常走发送', () => {
    expect(getBareSeedComposerKind('/create-team')).toBe('team');
    expect(getBareSeedComposerKind('  /create-role  ')).toBe('role');
    expect(getBareSeedComposerKind('/create-team 每周做行业简报')).toBeNull();
    expect(getBareSeedComposerKind('/create-teams')).toBeNull();
    expect(getBareSeedComposerKind('建个团队')).toBeNull();
  });

  it('提交串保留前导 slash（确定性命中 skill 上下文，别改成纯自然语言）', () => {
    expect(buildSeedComposerCommand('team', '  每周做行业简报  ')).toBe('/create-team 每周做行业简报');
    expect(buildSeedComposerCommand('role', '会写周报的助理')).toBe('/create-role 会写周报的助理');
  });

  it('裸 /create-team 提交时弹卡，且这条指令不发给模型', async () => {
    const onSend = vi.fn();
    const openSeedComposer = vi.fn();
    const params = makeParams({ onSend, openSeedComposer });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as unknown as React.FormEvent);
    });

    expect(openSeedComposer).toHaveBeenCalledWith('team');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('带了描述的 /create-team 不弹卡，照常发送', async () => {
    const onSend = vi.fn();
    const openSeedComposer = vi.fn();
    const params = makeParams({
      value: '/create-team 每周做行业简报',
      onSend,
      openSeedComposer,
      buildEnvelope: vi.fn(() => ({ content: '/create-team 每周做行业简报', context: {} })),
    });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as unknown as React.FormEvent);
    });

    expect(openSeedComposer).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ content: '/create-team 每周做行业简报' }));
  });

  it('卡片：空文本时不能开始，填了内容才把文本交出去', () => {
    const onSubmit = vi.fn();
    render(
      <SeedComposerCard
        kind="team"
        title="建一个团队"
        placeholder="这个团队要做什么？"
        submitting={false}
        onSubmit={onSubmit}
        onDismiss={vi.fn()}
      />,
    );

    const start = document.querySelector('[data-seed-composer-start]') as HTMLButtonElement;
    expect(start).toBeTruthy();
    expect(start.disabled).toBe(true);

    const field = document.querySelector('[data-seed-composer-field]') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '每周做行业简报' } });
    expect(start.disabled).toBe(false);

    fireEvent.click(start);
    expect(onSubmit).toHaveBeenCalledWith('每周做行业简报');
  });

  it('卡片：只展示 IPC 返回的非空权威专家数', async () => {
    seedComposerMocks.invokeDomain.mockResolvedValue([{ roleId: '研究员' }, { roleId: '分析师' }]);
    const { unmount } = render(
      <SeedComposerCard
        kind="team"
        title="建一个团队"
        placeholder="这个团队要做什么？"
        submitting={false}
        onSubmit={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(await screen.findByText('本机现有 2 位专家可用')).toBeTruthy();
    unmount();

    seedComposerMocks.invokeDomain.mockResolvedValue([]);
    render(
      <SeedComposerCard
        kind="team"
        title="建一个团队"
        placeholder="这个团队要做什么？"
        submitting={false}
        onSubmit={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    await act(async () => {});
    expect(screen.queryByText(/本机现有 .* 位专家可用/)).toBeNull();
  });

  it('卡片：专家 IPC 失败时不显示数量', async () => {
    seedComposerMocks.invokeDomain.mockRejectedValue(new Error('IPC failed'));
    render(
      <SeedComposerCard
        kind="team"
        title="建一个团队"
        placeholder="这个团队要做什么？"
        submitting={false}
        onSubmit={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    await act(async () => {});
    expect(screen.queryByText(/本机现有 .* 位专家可用/)).toBeNull();
  });
});
