import { describe, expect, it, vi } from 'vitest';

import { emitCommandCenterToolStart } from '../../../src/host/agent/runtime/contextAssembly/sessionCommandCenterPreannounce';

describe('session command center renderer-visible preannounce', () => {
  it('emits non-empty task-bound assistant text before the delegate_task row', () => {
    const events: Array<{ type: string; text?: string }> = [];
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: '<session_command_center>internal</session_command_center>\n<user_request>研究 React 的最新版本</user_request>',
      emitPreview: (text) => events.push({ type: 'message_delta', text }),
      emitToolStart: () => events.push({ type: 'stream_tool_call_start' }),
    });

    expect(preview).toContain('研究 React 的最新版本');
    expect(events).toEqual([
      { type: 'message_delta', text: preview },
      { type: 'stream_tool_call_start' },
    ]);
    expect(events[0].text?.trim()).not.toBe('');
  });

  it('does not duplicate a model-provided preamble', () => {
    const emitPreview = vi.fn();
    const emitToolStart = vi.fn();
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '我先去研究。',
      existingPreannounce: '',
      userMessage: '研究 React',
      emitPreview,
      emitToolStart,
    });
    expect(preview).toBe('');
    expect(emitPreview).not.toHaveBeenCalled();
    expect(emitToolStart).toHaveBeenCalledOnce();
  });
});
