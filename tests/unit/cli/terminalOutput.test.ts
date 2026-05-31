import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalOutput } from '../../../src/cli/output/terminal';
import type { AgentEvent, ToolCall, ToolResult } from '../../../src/shared/contract';

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

describe('TerminalOutput', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureOutput(): { logs: string[]; errors: string[]; writes: string[] } {
    const logs: string[] = [];
    const errors: string[] = [];
    const writes: string[] = [];

    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(stripAnsi(args.map(String).join(' ')));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(stripAnsi(args.map(String).join(' ')));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(stripAnsi(String(chunk)));
      return true;
    }) as never);

    return { logs, errors, writes };
  }

  it('renders welcome, prompt, info, success, and warning text', () => {
    const output = new TerminalOutput();
    const { logs, writes } = captureOutput();

    output.welcome('1.2.3', {
      model: 'gpt-test',
      provider: 'openai',
      workingDirectory: '/tmp/project',
    });
    output.prompt();
    output.info('ready');
    output.success('done');
    output.warn('careful');

    const text = [...logs, ...writes].join('\n');
    expect(text).toContain('Agent Neo v1.2.3');
    expect(text).toContain('openai/gpt-test');
    expect(text).toContain('/tmp/project');
    expect(text).toContain('ready');
    expect(text).toContain('done');
    expect(text).toContain('careful');
  });

  it('renders tool calls and tool results with compact argument summaries', () => {
    const output = new TerminalOutput();
    const { logs } = captureOutput();

    output.toolCall({
      id: 'call-1',
      name: 'Read',
      arguments: { path: '/tmp/project/README.md' },
    } as ToolCall);
    output.toolCall({
      id: 'call-2',
      name: 'mcp__github__search',
      arguments: { query: 'issues' },
    } as ToolCall);
    output.toolResult({ toolCallId: 'call-1', success: true, output: 'first line\nsecond line' } as ToolResult);
    output.toolResult({ toolCallId: 'call-2', success: false, error: 'bad token' } as ToolResult);

    const text = logs.join('\n');
    expect(text).toContain('Read');
    expect(text).toContain('/tmp/project/README.md');
    expect(text).toContain('mcp:github search');
    expect(text).toContain('"issues"');
    expect(text).toContain('first line second line');
    expect(text).toContain('bad token');
  });

  it('streams chunks, suppresses duplicate assistant messages, and routes TUI errors to stdout', () => {
    const output = new TerminalOutput();
    const { logs, errors, writes } = captureOutput();

    output.handleEvent({ type: 'stream_chunk', data: { content: 'hel' } } as AgentEvent);
    output.handleEvent({ type: 'stream_chunk', data: { content: 'lo' } } as AgentEvent);
    output.handleEvent({ type: 'message', data: { role: 'assistant', content: 'hello' } } as AgentEvent);
    output.setTUIMode(true);
    output.error('visible');

    expect(writes.join('')).toContain('hello');
    expect(logs.join('\n')).toContain('visible');
    expect(errors).toEqual([]);
  });

  it('tracks model response metadata into the task completion status line', () => {
    const output = new TerminalOutput();
    const { logs } = captureOutput();

    output.handleEvent({
      type: 'model_response',
      data: {
        model: 'gpt-test',
        provider: 'openai',
        responseType: 'message',
        duration: 20,
        toolCalls: [],
        textLength: 5,
        inputTokens: 1200,
        outputTokens: 300,
      },
    } as AgentEvent);
    output.updateContextUsage(50, 4000, 8000);
    output.taskComplete(1500, ['Read', 'Read', 'Write']);

    const text = logs.join('\n');
    expect(text).toContain('openai/gpt-test');
    expect(text).toContain('1.5k tokens');
    expect(text).toContain('1 turns');
    expect(text).toContain('2 tools');
    expect(text).toContain('ctx');
  });
});
