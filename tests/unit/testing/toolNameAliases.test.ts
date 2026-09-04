import { describe, expect, it } from 'vitest';
import { runExpectations } from '../../../src/host/testing/assertionEngine';
import {
  isShellEvalTool,
  toolMatches,
} from '../../../src/host/testing/toolNameAliases';
import type { Expectation, ToolExecutionRecord } from '../../../src/host/testing/types';

function toolExecution(tool: string, output = 'package.json'): ToolExecutionRecord {
  return {
    tool,
    input: { command: 'ls' },
    output,
    success: true,
    duration: 1,
    timestamp: 0,
  };
}

async function outputContains(params: Record<string, unknown>, toolExecutions: ToolExecutionRecord[]) {
  const expectation: Expectation = {
    type: 'tool_output_contains',
    description: 'filter tool output',
    params,
  };
  const result = await runExpectations([expectation], {
    toolExecutions,
    responses: [],
    errors: [],
    turnCount: 1,
    workingDirectory: '/tmp',
  });
  return result.results[0];
}

describe('canonical aliases', () => {
  it('keeps existing Neo aliases and adds external CLI shells', () => {
    expect(toolMatches('read_file', 'read')).toBe(true);
    expect(toolMatches('WriteFile', 'write')).toBe(true);
    expect(toolMatches('edit_file', 'edit')).toBe(true);
    expect(toolMatches('TodoWrite', 'todowrite')).toBe(true);
    expect(toolMatches('exec_command', 'bash')).toBe(true);
    expect(toolMatches('run_terminal_command', 'bash')).toBe(true);
    expect(toolMatches('shell', 'bash')).toBe(true);
    expect(toolMatches('search_replace', 'edit')).toBe(true);
  });

  it('does not collapse Grok output polling onto bash', () => {
    expect(toolMatches('get_command_or_subagent_output', 'bash')).toBe(false);
    expect(toolMatches('get_command_or_subagent_output', '^Bash$')).toBe(false);
  });
});

describe('toolMatches', () => {
  it('T3：^Bash$ 锚定仍过 Neo Bash、不过 BashOutput', () => {
    expect(toolMatches('Bash', '^Bash$')).toBe(true);
    expect(toolMatches('bash', '^Bash$')).toBe(true);
    expect(toolMatches('BashOutput', '^Bash$')).toBe(false);
    expect(toolMatches('get_command_or_subagent_output', '^Bash$')).toBe(false);
  });

  it('widens bash-class names without replacing the raw regex hit', () => {
    expect(toolMatches('exec_command', 'bash|list_directory|glob')).toBe(true);
    expect(toolMatches('run_terminal_command', 'bash|list_directory|glob')).toBe(true);
    expect(toolMatches('ListDirectory', 'bash|list_directory|glob')).toBe(true);
    expect(toolMatches('ToolSearch', 'ToolSearch')).toBe(true);
    expect(toolMatches('Task', '^Task$')).toBe(true);
    expect(toolMatches('search_replace', '^Edit$')).toBe(true);
  });
});

describe('isShellEvalTool', () => {
  it('recognizes Neo/Codex/Grok shells and spares the Grok poller', () => {
    expect(isShellEvalTool('Bash')).toBe(true);
    expect(isShellEvalTool('Terminal')).toBe(true);
    expect(isShellEvalTool('exec_command')).toBe(true);
    expect(isShellEvalTool('run_terminal_command')).toBe(true);
    expect(isShellEvalTool('BashOutput')).toBe(false);
    expect(isShellEvalTool('get_command_or_subagent_output')).toBe(false);
    expect(isShellEvalTool('Read')).toBe(false);
  });
});

describe('T3 tool_output_contains params.tool filter', () => {
  it('still filters by tool and does not leak a Read hit into a bash filter', async () => {
    const executions = [
      toolExecution('Read', 'secret-from-read'),
      toolExecution('exec_command', 'package.json'),
    ];

    const bashFilter = await outputContains({ text: 'package.json', tool: 'bash' }, executions);
    expect(bashFilter.passed).toBe(true);

    const readLeak = await outputContains({ text: 'secret-from-read', tool: 'bash' }, executions);
    expect(readLeak.passed).toBe(false);

    const readOnly = await outputContains({ text: 'package.json', tool: 'Read' }, executions);
    expect(readOnly.passed).toBe(false);

    const readHit = await outputContains({ text: 'secret-from-read', tool: 'Read' }, executions);
    expect(readHit.passed).toBe(true);
  });
});
