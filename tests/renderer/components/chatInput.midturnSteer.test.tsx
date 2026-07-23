// @vitest-environment jsdom

import React, { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SteerOrQueueOutcome } from '../../../src/shared/contract/appService';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { InputArea, type InputAreaRef } from '../../../src/renderer/components/features/chat/ChatInput/InputArea';
import {
  RuntimeInputShortcutHint,
} from '../../../src/renderer/components/features/chat/ChatInput';
import {
  useChatInputSubmit,
  type UseChatInputSubmitParams,
} from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';

function makeParams(overrides: Partial<UseChatInputSubmitParams> = {}): UseChatInputSubmitParams {
  return {
    value: '请改成更简洁的方案',
    attachments: [],
    voiceInputContext: null,
    pendingAppshot: null,
    pendingPromptCommand: null,
    pendingAgentSelection: null,
    currentSessionId: 'session-running',
    isProcessing: true,
    disabled: true,
    isUploading: false,
    onSend: vi.fn().mockResolvedValue(true),
    onSteer: vi.fn().mockResolvedValue({ outcome: 'steered' }),
    agentEntries: [],
    buildEnvelope: (content, attachments, runtimeInputMode): ConversationEnvelope => ({
      content,
      attachments,
      context: runtimeInputMode ? { runtimeInput: { mode: runtimeInputMode } } : undefined,
    }),
    openAgentCommand: vi.fn(),
    addToInputHistory: vi.fn(),
    clearAppshot: vi.fn(),
    inputAreaRef: {
      current: { focus: vi.fn(), getTextarea: () => null },
    },
    setValue: vi.fn(),
    setAttachments: vi.fn(),
    setVoiceInputContext: vi.fn(),
    setPendingPromptCommand: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setScheduleComposerOpen: vi.fn(),
    openGoalConfirm: vi.fn(),
    closeGoalConfirm: vi.fn(),
    setActiveAgentId: vi.fn(),
    ...overrides,
  };
}

function SubmitHarness({
  isProcessing,
  onSend,
  onSteer,
}: {
  isProcessing: boolean;
  onSend: (envelope: ConversationEnvelope) => boolean | Promise<boolean>;
  onSteer: (envelope: ConversationEnvelope) => Promise<SteerOrQueueOutcome | undefined>;
}) {
  const [value, setValue] = useState('请改成更简洁的方案');
  const inputAreaRef = useRef<InputAreaRef>(null);
  const { handleSubmit } = useChatInputSubmit(makeParams({
    value,
    setValue,
    isProcessing,
    disabled: isProcessing,
    onSend,
    onSteer,
    inputAreaRef,
  }));

  return (
    <InputArea
      ref={inputAreaRef}
      value={value}
      onChange={setValue}
      onSubmit={(opts) => { void handleSubmit(undefined, opts); }}
      onFileSelect={vi.fn()}
      isFocused={false}
      onFocusChange={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('mid-turn composer submission', () => {
  it('routes Alt/Option+Enter to the running-turn adjustment path', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue({ outcome: 'steered' });
    render(<SubmitHarness isProcessing onSend={onSend} onSteer={onSteer} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', altKey: true });

    await waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1));
    expect(onSteer).toHaveBeenCalledWith(expect.objectContaining({
      content: '请改成更简洁的方案',
      context: { runtimeInput: { mode: 'supplement' } },
    }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps ordinary Enter on the existing running-turn queue path', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue({ outcome: 'steered' });
    render(<SubmitHarness isProcessing onSend={onSend} onSteer={onSteer} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSteer).not.toHaveBeenCalled();
  });

  it('treats Alt/Option+Enter as ordinary send while idle', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue({ outcome: 'steered' });
    render(<SubmitHarness isProcessing={false} onSend={onSend} onSteer={onSteer} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', altKey: true });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSteer).not.toHaveBeenCalled();
  });

  it('restores and focuses the draft when the adjustment request fails', async () => {
    const setValue = vi.fn();
    const focus = vi.fn();
    const params = makeParams({
      setValue,
      inputAreaRef: {
        current: { focus, getTextarea: () => null },
      },
      onSteer: vi.fn().mockResolvedValue(undefined),
    });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit(undefined, { steer: true });
    });

    expect(setValue).toHaveBeenLastCalledWith('请改成更简洁的方案');
    expect(focus).toHaveBeenCalledTimes(1);
  });
});

describe('running-turn shortcut hint', () => {
  it('renders a stable hint anchor while processing with a draft', () => {
    render(<RuntimeInputShortcutHint isProcessing hasDraft />);
    expect(screen.getByTestId('runtime-input-shortcut-hint')).toBeTruthy();
  });

  it('does not render the hint anchor while idle', () => {
    render(<RuntimeInputShortcutHint isProcessing={false} hasDraft />);
    expect(screen.queryByTestId('runtime-input-shortcut-hint')).toBeNull();
  });

  it('does not render the hint anchor while processing without a draft', () => {
    render(<RuntimeInputShortcutHint isProcessing hasDraft={false} />);
    expect(screen.queryByTestId('runtime-input-shortcut-hint')).toBeNull();
  });
});
