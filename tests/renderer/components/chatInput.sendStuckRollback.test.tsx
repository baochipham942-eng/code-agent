// @vitest-environment jsdom
// 回归测试：发送挂住不返回时，草稿必须回到输入框并出声，不许静默吞掉整条消息。
//
// 真机取证（2026-08-01）：composer 是「乐观清空 + 失败回滚」——先 setValue('')，
// onSend 返回 false 或抛错才 restoreDraft。缺的一档是「永远不返回」：
// 侧栏请求风暴打满浏览器连接池 → ensureModelConfigured 的 settings/get 挂死不返回 →
// sendMessage 从未被调用 → 输入框已空，而屏幕、messages、queued_inputs 三处都没有这条，
// 刷新也不恢复，用户完全无感（全库搜索确认那句话不存在于任何会话）。
// 那条根因已单独修掉，本测试钉的是兜底：链路上任何一处挂住都不能再变成零痕迹。
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';

const toastSpy = vi.hoisted(() => ({
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: toastSpy }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import {
  useChatInputSubmit,
  type UseChatInputSubmitParams,
} from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';
import { zh } from '../../../src/renderer/i18n/zh';
import { useAppshotsStore } from '../../../src/renderer/stores/appshotsStore';
import { DRAFT_SCOPE_KEY, useComposerStore } from '../../../src/renderer/stores/composerStore';

const DRAFT = '这条消息不许被吞掉';

function makeParams(overrides: Partial<UseChatInputSubmitParams>): UseChatInputSubmitParams {
  return {
    value: DRAFT,
    attachments: [],
    voiceInputContext: null,
    pendingAppshot: null,
    pendingPromptCommand: null,
    pendingAgentSelection: null,
    currentSessionId: 'session-stuck',
    isProcessing: false,
    disabled: false,
    isUploading: false,
    onSend: vi.fn().mockResolvedValue(true),
    onSteer: vi.fn().mockResolvedValue({ outcome: 'steered' }),
    agentEntries: [],
    buildEnvelope: (content, attachments): ConversationEnvelope => ({ content, attachments }),
    openAgentCommand: vi.fn(),
    addToInputHistory: vi.fn(),
    clearAppshot: vi.fn(),
    inputAreaRef: {
      current: {
        focus: vi.fn(),
        getEditor: () => null,
        getCaretOffset: () => 0,
        replaceRangeWithChip: vi.fn(),
        replaceRangeWithText: vi.fn(),
      },
    },
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

// 只关心「草稿有没有回来 / 有没有出声」，不需要挂真的 InputArea（它在 jsdom 里 focus 会抛）。
function Harness({ onSend, goal = false, currentSessionId = 'session-stuck' }: { onSend: (envelope: ConversationEnvelope) => Promise<boolean>; goal?: boolean; currentSessionId?: string | null }) {
  const [value, setValue] = useState(DRAFT);
  const { handleSubmit, startGoalRun } = useChatInputSubmit(makeParams({ value, setValue, onSend, currentSessionId }));
  return (
    <div>
      <span data-testid="draft">{value}</span>
      <button type="button" onClick={() => void (goal ? startGoalRun({ goal: DRAFT }, DRAFT) : handleSubmit())}>send</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  // appshot 存在自己的 store 里，不随 cleanup 复位；不清会泄漏到下一条用例
  // （回滚守卫看到 pending 就跳过还原，下一条测试假红）。
  useAppshotsStore.getState().setPending(null, null);
  useComposerStore.getState().resetForSuccessfulSend();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('发送挂住不返回时的兜底', () => {
  it.each([true, false])('发送结果 %s 只在成功后清空单轮能力', async (sent) => {
    const store = useComposerStore.getState();
    store.setSelectedSkillIds(['review']);
    store.setSelectedConnectorIds(['mail']);
    store.setSelectedMcpServerIds(['github']);
    render(<Harness onSend={vi.fn().mockResolvedValue(sent)} />);
    await act(async () => { screen.getByText('send').click(); });
    expect(useComposerStore.getState()).toMatchObject({
      selectedSkillIds: sent ? [] : ['review'],
      selectedConnectorIds: sent ? [] : ['mail'],
      selectedMcpServerIds: sent ? [] : ['github'],
      turnCapabilityScopeMode: sent ? 'auto' : 'manual',
    });
  });

  it.each([false, true])('延迟发送（goal=%s）不清空等待期间为下一句选的新能力', async (goal) => {
    const store = useComposerStore.getState();
    store.setSelectedSkillIds(['old']);
    let finish!: (sent: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(<Harness onSend={onSend} goal={goal} />);
    await act(async () => { screen.getByText('send').click(); });
    store.setSelectedSkillIds(['next-skill']);
    store.setSelectedConnectorIds(['next-connector']);
    store.setSelectedMcpServerIds(['next-mcp']);
    await act(async () => { finish(true); });
    expect(useComposerStore.getState()).toMatchObject({
      selectedSkillIds: ['next-skill'], selectedConnectorIds: ['next-connector'],
      selectedMcpServerIds: ['next-mcp'], turnCapabilityScopeMode: 'manual',
    });
  });

  it.each([false, true])('延迟发送（goal=%s）不清空切换会话后加载的预设', async (goal) => {
    let finish!: (sent: boolean) => void;
    render(<Harness onSend={() => new Promise<boolean>((resolve) => { finish = resolve; })} goal={goal} />);
    await act(async () => { screen.getByText('send').click(); });
    const store = useComposerStore.getState();
    store.hydrateFromSession('next-session', '/tmp/next-session');
    store.applyWorkbenchPreset({
      routingMode: 'auto', targetAgentIds: [], browserSessionMode: 'none',
      selectedSkillIds: ['preset-skill'], selectedConnectorIds: ['preset-connector'],
      selectedMcpServerIds: ['preset-mcp'], turnCapabilityScopeMode: 'manual',
    });
    await act(async () => { finish(true); });
    expect(useComposerStore.getState()).toMatchObject({
      selectedSkillIds: ['preset-skill'], selectedConnectorIds: ['preset-connector'],
      selectedMcpServerIds: ['preset-mcp'], turnCapabilityScopeMode: 'manual',
    });
  });

  it.each([false, true])('草稿移交新会话（goal=%s）成功后仍清空同一轮能力', async (goal) => {
    const store = useComposerStore.getState();
    store.activateScope(DRAFT_SCOPE_KEY);
    store.setSelectedSkillIds(['sent-skill']);
    store.setSelectedConnectorIds(['sent-connector']);
    store.setSelectedMcpServerIds(['sent-mcp']);
    let finish!: (sent: boolean) => void;
    render(<Harness goal={goal} currentSessionId={null}
      onSend={() => new Promise<boolean>((resolve) => { finish = resolve; })} />);
    await act(async () => { screen.getByText('send').click(); });
    await act(async () => {
      await store.handoffActiveScopeToSession('created-session');
      store.hydrateFromSession('created-session', '/tmp/created-session');
    });
    expect(useComposerStore.getState().selectedSkillIds).toEqual(['sent-skill']);
    await act(async () => { finish(true); });
    expect(useComposerStore.getState()).toMatchObject({
      hydratedSessionId: 'created-session', selectedSkillIds: [], selectedConnectorIds: [],
      selectedMcpServerIds: [], turnCapabilityScopeMode: 'auto',
    });
  });

  it.each([false, true])('切走再切回原会话（goal=%s）不让旧发送清掉恢复的选择', async (goal) => {
    const store = useComposerStore.getState();
    store.hydrateFromSession('roundtrip-session', '/tmp/roundtrip');
    store.setSelectedSkillIds(['roundtrip-skill']);
    store.setSelectedConnectorIds(['roundtrip-connector']);
    store.setSelectedMcpServerIds(['roundtrip-mcp']);
    let finish!: (sent: boolean) => void;
    render(<Harness goal={goal} currentSessionId="roundtrip-session"
      onSend={() => new Promise<boolean>((resolve) => { finish = resolve; })} />);
    await act(async () => { screen.getByText('send').click(); });
    store.hydrateFromSession('away-session', '/tmp/away');
    store.hydrateFromSession('roundtrip-session', '/tmp/roundtrip');
    await act(async () => { finish(true); });
    expect(useComposerStore.getState()).toMatchObject({
      hydratedSessionId: 'roundtrip-session',
      selectedSkillIds: ['roundtrip-skill'], selectedConnectorIds: ['roundtrip-connector'],
      selectedMcpServerIds: ['roundtrip-mcp'], turnCapabilityScopeMode: 'manual',
    });
  });

  it.each([false, true])('重新选择相同能力（goal=%s）也是下一轮意图', async (goal) => {
    const store = useComposerStore.getState();
    store.setSelectedSkillIds(['same-skill']);
    let finish!: (sent: boolean) => void;
    render(<Harness goal={goal} onSend={() => new Promise<boolean>((resolve) => { finish = resolve; })} />);
    await act(async () => { screen.getByText('send').click(); });
    store.setSelectedSkillIds(['same-skill']);
    await act(async () => { finish(true); });
    expect(useComposerStore.getState().selectedSkillIds).toEqual(['same-skill']);
  });

  it('超时后草稿退回输入框并出声，不留「输入框空了但哪儿都没有」的状态', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 永不 settle：模拟发送链路上任意一处挂死
    const onSend = vi.fn(() => new Promise<boolean>(() => {}));
    render(<Harness onSend={onSend} />);

    await act(async () => {
      screen.getByText('send').click();
    });
    // 乐观清空已经发生：此刻用户看到的输入框是空的
    expect(screen.getByTestId('draft').textContent).toBe('');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    // 修复前：草稿永远回不来、零提示；修复后：原文回到输入框 + 明确出声
    expect(screen.getByTestId('draft').textContent).toBe(DRAFT);
    expect(toastSpy.warning).toHaveBeenCalledWith(zh.chatInputSubmit.sendStuckDraftRestored);
  });

  it('正常发送成功时不误报超时、不把草稿塞回去', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onSend = vi.fn().mockResolvedValue(true);
    render(<Harness onSend={onSend} />);

    await act(async () => {
      screen.getByText('send').click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(screen.getByTestId('draft').textContent).toBe('');
    expect(toastSpy.warning).not.toHaveBeenCalled();
  });
});

// ai-review #1694：把 `send` 的返回值从恒 true 改成真实投递结果后，「失败回滚」这条路
// 第一次真的会走到。乐观清空之后用户可以继续输入，回滚不许把新内容覆盖掉。
describe('失败回滚不覆盖用户在这期间新打的内容', () => {
  function TypingHarness({ onSend }: { onSend: (envelope: ConversationEnvelope) => Promise<boolean> }) {
    const [value, setValue] = useState(DRAFT);
    const { handleSubmit } = useChatInputSubmit(
      makeParams({ value, setValue, onSend, currentSessionId: 'session-typing' }),
    );
    return (
      <div>
        <span data-testid="draft">{value}</span>
        <button type="button" onClick={() => void handleSubmit()}>send</button>
        <button type="button" onClick={() => setValue('用户后打的新内容')}>type</button>
      </div>
    );
  }

  it('发送失败回执到达时输入框已有新内容 ⇒ 保留新内容，不还原旧草稿', async () => {
    let resolveSend: ((sent: boolean) => void) | undefined;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));

    render(<TypingHarness onSend={onSend} />);
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    // 乐观清空后用户接着打字
    fireEvent.click(screen.getByText('type'));
    await waitFor(() => expect(screen.getByTestId('draft').textContent).toBe('用户后打的新内容'));

    await act(async () => { resolveSend?.(false); });

    expect(screen.getByTestId('draft').textContent).toBe('用户后打的新内容');
    expect(screen.getByTestId('draft').textContent).not.toBe(DRAFT);
  });

  // ai-review #1694 第三轮②：逐字段各判各的会把两份草稿混起来。回滚必须整份。
  it('用户已打新内容时不还原任何一项（附件也不许单独塞回来）', async () => {
    let resolveSend: ((sent: boolean) => void) | undefined;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));
    const setAttachments = vi.fn();

    function MixHarness() {
      const [value, setValue] = useState(DRAFT);
      const { handleSubmit } = useChatInputSubmit(makeParams({
        value,
        setValue,
        setAttachments,
        attachments: [{ id: 'a1', name: 'a.png', type: 'image', size: 1, data: 'x' } as never],
        onSend,
        currentSessionId: 'session-mix',
      }));
      return (
        <div>
          <span data-testid="draft">{value}</span>
          <button type="button" onClick={() => void handleSubmit()}>send</button>
          <button type="button" onClick={() => setValue('纯文本 B')}>type</button>
        </div>
      );
    }

    render(<MixHarness />);
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    fireEvent.click(screen.getByText('type'));
    await waitFor(() => expect(screen.getByTestId('draft').textContent).toBe('纯文本 B'));
    setAttachments.mockClear();

    await act(async () => { resolveSend?.(false); });

    expect(screen.getByTestId('draft').textContent).toBe('纯文本 B');
    // 整份不还 ⇒ 附件也不许被塞回来
    expect(setAttachments).not.toHaveBeenCalled();
  });

  // 变异自查发现的盲区：上面那条只动文本，附件那一半的守卫没人站着。
  it('用户没打字但加了附件时同样不还原（守卫的另一半）', async () => {
    let resolveSend: ((sent: boolean) => void) | undefined;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));

    function AttachHarness() {
      const [value, setValue] = useState(DRAFT);
      const [attachments, setAttachments] = useState<never[]>([]);
      const { handleSubmit } = useChatInputSubmit(makeParams({
        value,
        setValue,
        attachments,
        setAttachments,
        onSend,
        currentSessionId: 'session-attach',
      }));
      return (
        <div>
          <span data-testid="draft">{value}</span>
          <span data-testid="count">{attachments.length}</span>
          <button type="button" onClick={() => void handleSubmit()}>send</button>
          <button
            type="button"
            onClick={() => setAttachments([{ id: 'new', name: 'b.png', type: 'image', size: 1, data: 'y' } as never])}
          >attach</button>
        </div>
      );
    }

    render(<AttachHarness />);
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    // 乐观清空后文本框是空的，用户没打字、只加了个附件
    await waitFor(() => expect(screen.getByTestId('draft').textContent).toBe(''));
    fireEvent.click(screen.getByText('attach'));
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));

    await act(async () => { resolveSend?.(false); });

    // 整份不还：旧文本不许回来，用户新加的附件也不许被旧附件顶掉
    expect(screen.getByTestId('draft').textContent).toBe('');
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  // ai-review #1694 第四轮②：appshot 在自己的 store 里，不在 value/attachments 上。
  it('用户重新截了图时不还原（守卫要覆盖所有会被回滚写回的项）', async () => {
    let resolveSend: ((sent: boolean) => void) | undefined;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));

    function AppshotHarness() {
      const [value, setValue] = useState(DRAFT);
      const { handleSubmit } = useChatInputSubmit(makeParams({
        value, setValue, onSend, currentSessionId: 'session-appshot',
      }));
      return (
        <div>
          <span data-testid="draft">{value}</span>
          <button type="button" onClick={() => void handleSubmit()}>send</button>
        </div>
      );
    }

    render(<AppshotHarness />);
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('draft').textContent).toBe(''));
    // 空输入框里重新截了一张
    act(() => {
      useAppshotsStore.getState().setPending(
        { requestId: 'new-shot', image: 'data:image/png;base64,bmV3' } as never,
        'session-appshot',
      );
    });

    await act(async () => { resolveSend?.(false); });

    expect(screen.getByTestId('draft').textContent).toBe('');
    expect(useAppshotsStore.getState().pending).toMatchObject({ requestId: 'new-shot' });
  });

  // ai-review #1694 第五轮②：守卫要覆盖回滚会写回的每一项，会话/产物引用也在其中。
  it('用户为下一条选了会话引用时不还原（引用也是回滚项）', async () => {
    let resolveSend: ((sent: boolean) => void) | undefined;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));
    const setValueSpy = vi.fn();

    function RefHarness() {
      const [value, setValue] = useState(DRAFT);
      const [sessionReferences, setSessionReferences] = useState<never[]>([]);
      const { handleSubmit } = useChatInputSubmit(makeParams({
        value,
        setValue: (next: never) => { setValueSpy(next); setValue(next as never); },
        sessionReferences,
        setSessionReferences,
        onSend,
        currentSessionId: 'session-refs',
      }));
      return (
        <div>
          <span data-testid="draft">{value}</span>
          <span data-testid="refs">{sessionReferences.length}</span>
          <button type="button" onClick={() => void handleSubmit()}>send</button>
          <button
            type="button"
            onClick={() => setSessionReferences([{ sessionId: 'ref-b', title: 'B' } as never])}
          >pick</button>
        </div>
      );
    }

    render(<RefHarness />);
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('draft').textContent).toBe(''));
    fireEvent.click(screen.getByText('pick'));
    await waitFor(() => expect(screen.getByTestId('refs').textContent).toBe('1'));
    setValueSpy.mockClear();

    await act(async () => { resolveSend?.(false); });

    // 整份不还：旧草稿不许回来，用户新选的引用也不许被旧引用顶掉
    expect(screen.getByTestId('draft').textContent).toBe('');
    expect(screen.getByTestId('refs').textContent).toBe('1');
  });

  // ai-review #1694 第七轮（二裁维持）：命令 chip 零宽、不进 value，守卫全通过 ⇒
  // A 的旧文本被还原到用户新选的 /loop chip 旁，下一次提交拼成「/loop A」，
  // 直接起一个用户从未要求的循环任务。
  it('用户新选了命令 chip 时不还原', async () => {
    let resolveSend: ((sent: boolean) => void) | undefined;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));

    function ChipHarness() {
      const [value, setValue] = useState(DRAFT);
      const { handleSubmit } = useChatInputSubmit(makeParams({
        value, setValue, onSend, currentSessionId: 'session-chip',
      }));
      return (
        <div>
          <span data-testid="draft">{value}</span>
          <button type="button" onClick={() => void handleSubmit()}>send</button>
        </div>
      );
    }

    render(<ChipHarness />);
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('draft').textContent).toBe(''));
    act(() => {
      useComposerStore.getState().setPendingCommand({ command: 'loop', raw: '/loop' } as never);
    });

    await act(async () => { resolveSend?.(false); });

    expect(screen.getByTestId('draft').textContent).toBe('');
  });

  it('输入框仍是空的（用户没打字）⇒ 照常把草稿还回去', async () => {
    const onSend = vi.fn(async () => false);

    render(<TypingHarness onSend={onSend} />);
    fireEvent.click(screen.getByText('send'));

    await waitFor(() => expect(screen.getByTestId('draft').textContent).toBe(DRAFT));
  });
});
