import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSONOutput } from '../../../src/cli/output/json';
import type { AgentEvent } from '../../../src/shared/contract';
import type { SwarmEvent } from '../../../src/shared/contract/swarm';

describe('CLI JSONOutput', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockConsole(): { log: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> } {
    return {
      log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
      error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    };
  }

  function loggedObjects(log: ReturnType<typeof vi.spyOn>): unknown[] {
    return log.mock.calls.map(([value]) => JSON.parse(String(value)));
  }

  it('emits task progress, tool calls, messages, errors, and deduped completion metadata', () => {
    const output = new JSONOutput();
    const { log } = mockConsole();
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValueOnce(1000);
    output.start();

    now.mockReturnValueOnce(1010);
    output.handleEvent({ type: 'task_progress', data: { phase: 'plan', step: 'scan' } } as AgentEvent);

    now.mockReturnValueOnce(1020);
    output.handleEvent({
      type: 'tool_call_start',
      data: { id: 'call-1', name: 'Read', arguments: { path: 'README.md' } },
    } as AgentEvent);

    now.mockReturnValueOnce(1030);
    output.handleEvent({
      type: 'tool_call_start',
      data: { id: 'call-2', name: 'Read', arguments: { path: 'package.json' } },
    } as AgentEvent);

    now.mockReturnValueOnce(1040);
    output.handleEvent({
      type: 'message',
      data: { role: 'assistant', content: 'done' },
    } as AgentEvent);

    now.mockReturnValueOnce(1050);
    output.handleEvent({
      type: 'error',
      data: { message: 'failed', code: 'E_FAIL' },
    } as AgentEvent);

    now.mockReturnValueOnce(1200).mockReturnValueOnce(1200);
    output.handleEvent({ type: 'agent_complete', data: null } as AgentEvent);

    expect(loggedObjects(log)).toEqual([
      {
        type: 'thinking',
        timestamp: 1010,
        data: { phase: 'plan', step: 'scan' },
      },
      {
        type: 'tool_call',
        timestamp: 1020,
        data: { id: 'call-1', name: 'Read', arguments: { path: 'README.md' } },
      },
      {
        type: 'tool_call',
        timestamp: 1030,
        data: { id: 'call-2', name: 'Read', arguments: { path: 'package.json' } },
      },
      {
        type: 'message',
        timestamp: 1040,
        data: { content: 'done' },
      },
      {
        type: 'error',
        timestamp: 1050,
        data: { message: 'failed', code: 'E_FAIL' },
      },
      {
        type: 'complete',
        timestamp: 1200,
        data: { duration: 200, toolsUsed: ['Read'] },
      },
    ]);
  });

  it('emits tool results and ignores stream chunks', () => {
    const output = new JSONOutput();
    const { log } = mockConsole();
    const now = vi.spyOn(Date, 'now').mockReturnValue(2000);

    output.start();
    output.handleEvent({ type: 'stream_chunk', data: { content: 'partial' } } as AgentEvent);
    output.handleEvent({
      type: 'tool_call_end',
      data: {
        toolCallId: 'call-1',
        success: false,
        output: 'stdout',
        error: 'bad',
        duration: 42,
      },
    } as AgentEvent);

    expect(now).toHaveBeenCalled();
    expect(loggedObjects(log)).toEqual([
      {
        type: 'tool_result',
        timestamp: 2000,
        data: {
          toolCallId: 'call-1',
          success: false,
          output: 'stdout',
          error: 'bad',
          duration: 42,
        },
      },
    ]);
  });

  it('writes final results, errors, and swarm events as JSON', () => {
    const output = new JSONOutput();
    const { log, error } = mockConsole();

    output.result({ success: true, output: 'done', toolsUsed: ['Read'] });
    output.error('bad input', 'E_INPUT');
    output.handleSwarmEvent({
      type: 'swarm:started',
      timestamp: 3000,
      data: {},
    } as SwarmEvent);

    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      success: true,
      output: 'done',
      toolsUsed: ['Read'],
    });
    expect(JSON.parse(String(error.mock.calls[0][0]))).toEqual({
      success: false,
      error: 'bad input',
      code: 'E_INPUT',
    });
    expect(JSON.parse(String(log.mock.calls[1][0]))).toEqual({
      type: 'swarm_event',
      event_type: 'swarm:started',
      timestamp: 3000,
      data: {},
    });
  });
});
