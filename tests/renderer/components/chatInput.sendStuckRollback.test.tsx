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
import { act, cleanup, render, screen } from '@testing-library/react';
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
    isProcessing: true,
    disabled: true,
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
function Harness({ onSend }: { onSend: (envelope: ConversationEnvelope) => Promise<boolean> }) {
  const [value, setValue] = useState(DRAFT);
  const { handleSubmit } = useChatInputSubmit(makeParams({ value, setValue, onSend }));
  return (
    <div>
      <span data-testid="draft">{value}</span>
      <button type="button" onClick={() => void handleSubmit()}>send</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('发送挂住不返回时的兜底', () => {
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
