// @vitest-environment jsdom

import React, { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SteerOrQueueOutcome } from '../../../src/shared/contract/appService';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { InputArea, type InputAreaRef } from '../../../src/renderer/components/features/chat/ChatInput/InputArea';
import {
} from '../../../src/renderer/components/features/chat/ChatInput';
import { RuntimeInputChoice } from '../../../src/renderer/components/features/chat/ChatInput/RuntimeInputChoice';
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
      current: { focus: vi.fn(), getEditor: () => null, getCaretOffset: () => 0, replaceRangeWithChip: vi.fn(), replaceRangeWithText: vi.fn() },
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

const domainInvoke = vi.fn();

beforeEach(() => {
  domainInvoke.mockResolvedValue({
    success: true,
    data: {
      id: 'queued-input-1',
      sessionId: 'session-running',
      envelope: { content: '请改成更简洁的方案' },
      status: 'queued',
      retryCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  });
  window.codeAgentDomainAPI = { invoke: domainInvoke } as typeof window.codeAgentDomainAPI;
});

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
  const [runtimeInputChoice, setRuntimeInputChoice] = useState<'queue' | 'redirect'>('queue');
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
    <>
      {isProcessing && (
        <RuntimeInputChoice value={runtimeInputChoice} onChange={setRuntimeInputChoice} />
      )}
      <InputArea
        ref={inputAreaRef}
        value={value}
        onChange={setValue}
        onSubmit={(opts) => {
          void handleSubmit(undefined, {
            ...opts,
            steer: opts?.steer ?? (isProcessing && runtimeInputChoice === 'redirect'),
          });
        }}
        onFileSelect={vi.fn()}
        isFocused={false}
        onFocusChange={vi.fn()}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.codeAgentDomainAPI = undefined;
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
      context: { runtimeInput: { mode: 'redirect' } },
    }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('puts ordinary Enter into the durable list while running', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue({ outcome: 'steered' });
    render(<SubmitHarness isProcessing onSend={onSend} onSteer={onSteer} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(domainInvoke).toHaveBeenCalledTimes(1));
    expect(domainInvoke).toHaveBeenCalledWith(
      'domain:queuedInput',
      'enqueue',
      expect.objectContaining({
        sessionId: 'session-running',
        envelope: expect.objectContaining({
          content: '请改成更简洁的方案',
          context: { runtimeInput: { mode: 'supplement' } },
        }),
      }),
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(onSteer).not.toHaveBeenCalled();
  });

  it('uses the selected Now choice for ordinary Enter while running', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue({ outcome: 'steered' });
    render(<SubmitHarness isProcessing onSend={onSend} onSteer={onSteer} />);

    fireEvent.click(screen.getByRole('radio', { name: '改道' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1));
    expect(domainInvoke).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows the two running choices with Later selected by default and hides them when idle', () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue({ outcome: 'steered' });
    const { rerender } = render(<SubmitHarness isProcessing onSend={onSend} onSteer={onSteer} />);

    expect(screen.getByRole('radio', { name: '排队' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '改道' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('radio', { name: '排队' }).getAttribute('title')).toBe('稍后再做');
    expect(screen.getByRole('radio', { name: '改道' }).getAttribute('title')).toBe('现在打断，按新话走');
    expect(screen.getByTestId('runtime-input-choice').textContent).toBe('排队改道');
    expect(screen.queryByText('稍后再做')).toBeNull();
    expect(screen.queryByText('现在打断，按新话走')).toBeNull();

    rerender(<SubmitHarness isProcessing={false} onSend={onSend} onSteer={onSteer} />);
    expect(screen.queryByTestId('runtime-input-choice')).toBeNull();
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
        current: { focus, getEditor: () => null, getCaretOffset: () => 0, replaceRangeWithChip: vi.fn(), replaceRangeWithText: vi.fn() },
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
