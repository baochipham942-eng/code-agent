import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';
import { resolveCanonicalRunPath } from '../../../src/host/runtime/runContext';
import { resolveToolWriteTargets } from '../../../src/host/tools/writeTargets';

const BASH_TOOL: ToolDefinition = {
  name: 'Bash',
  description: 'test fixture',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
  outputSchema: { type: 'string' },
  permissionLevel: 'execute',
  requiresPermission: true,
  pathAuthority: [{ kind: 'shell', commandParameter: 'command' }],
};

const workingDirectory = '/tmp/write-target-redirects';

function resolve(command: string) {
  return resolveToolWriteTargets({
    definition: BASH_TOOL,
    params: { command },
    workingDirectory,
  });
}

describe('shell redirect write targets', () => {
  it.each([
    'echo hi 2>&1',
    'git status 2>&1',
    'git remote -v 2>&1 | head',
    'cmd >&2',
    'cmd >& 1',
    'cmd 2>&-',
    'cmd &>',
  ])('does not treat file descriptor duplication as a write target: %s', (command) => {
    expect(resolve(command)).toMatchObject({ targets: [], uncertain: [] });
  });

  it.each([
    ['echo hi > out.txt', 'out.txt'],
    ['echo hi >> out.txt', 'out.txt'],
    ['cmd &> out.txt', 'out.txt'],
    ['cmd >& out.txt', 'out.txt'],
    ['cmd &>out.txt', 'out.txt'],
    ['cmd >&out.txt', 'out.txt'],
    ['cmd >&12abc', '12abc'],
    ['cmd >&-report.log', '-report.log'],
  ])('keeps file output redirects as write targets: %s', (command, target) => {
    expect(resolve(command)).toMatchObject({
      targets: [resolveCanonicalRunPath(path.join(workingDirectory, target))],
      uncertain: [],
    });
  });

  it('ignores redirect syntax inside quotes', () => {
    expect(resolve('echo "2>&1" ')).toMatchObject({ targets: [], uncertain: [] });
  });

  it.each([
    ["sh -c 'echo hi > out.txt'", 'out.txt'],
    ['bash -c "echo hi > out.txt"', 'out.txt'],
    ['eval "echo hi > out.txt"', 'out.txt'],
    ["eval 'echo hi' '> out.txt'", 'out.txt'],
    ["sh -lc 'printf x > out.txt'", 'out.txt'],
    ["sh -c -- 'printf x > out.txt'", 'out.txt'],
    ["zsh -ec 'printf x > out.txt'", 'out.txt'],
    ["dash -c 'printf x > out.txt'", 'out.txt'],
    ["MODE=1 sh -c 'printf x > out.txt'", 'out.txt'],
    ["echo ok && sh -c 'echo hi > out.txt'", 'out.txt'],
    ['printf x | eval "echo hi > out.txt"', 'out.txt'],
    ["true; sh -c 'echo hi > out.txt'", 'out.txt'],
    ["false || sh -c 'echo hi > out.txt'", 'out.txt'],
  ])('finds write targets inside shell command wrappers: %s', (command, target) => {
    expect(resolve(command)).toMatchObject({
      targets: [resolveCanonicalRunPath(path.join(workingDirectory, target))],
      uncertain: [],
    });
  });

  it("keeps descriptor duplication inside a shell command wrapper target-free", () => {
    expect(resolve("sh -c 'echo hi 2>&1'")).toMatchObject({ targets: [], uncertain: [] });
  });

  it('does not feed an outer descriptor duplication back into eval', () => {
    expect(resolve('eval "echo hi > out.txt" 2>&1')).toMatchObject({
      targets: [resolveCanonicalRunPath(path.join(workingDirectory, 'out.txt'))],
      uncertain: [],
    });
  });

  it('fails closed when a wrapped redirect target is dynamic', () => {
    expect(resolve('bash -c \'cat > "$HOME/x"\'')).toMatchObject({
      targets: [],
      uncertain: ['uncertain-redirection:bash'],
    });
  });

  it.each([
    ["sh -c 'echo $(date) > out.txt'", 'uncertain-redirection:sh'],
    ['sh -c "$SCRIPT"', 'uncertain-redirection:sh'],
    ['eval "${SCRIPT}"', 'uncertain-redirection:eval'],
    ["eval 'echo `date` > out.txt'", 'uncertain-redirection:eval'],
    ["sh -c 'echo \"unterminated > out.txt'", 'uncertain-redirection:sh'],
  ])('fails closed when a wrapped script cannot be resolved: %s', (command, reason) => {
    expect(resolve(command)).toMatchObject({ targets: [], uncertain: [reason] });
  });

  it.each([
    'echo "a > b"',
    'grep ">" f',
    "sed 's/>/x/' f",
  ])('ignores redirect syntax in ordinary quoted arguments: %s', (command) => {
    expect(resolve(command)).toMatchObject({ targets: [], uncertain: [] });
  });
});
