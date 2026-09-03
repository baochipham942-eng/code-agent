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
    'echo hi > out.txt',
    'echo hi >> out.txt',
    'cmd &> out.txt',
    'cmd >& out.txt',
    'cmd &>out.txt',
    'cmd >&out.txt',
  ])('keeps file output redirects as write targets: %s', (command) => {
    expect(resolve(command)).toMatchObject({
      targets: [resolveCanonicalRunPath(path.join(workingDirectory, 'out.txt'))],
      uncertain: [],
    });
  });

  it('ignores redirect syntax inside quotes', () => {
    expect(resolve('echo "2>&1" ')).toMatchObject({ targets: [], uncertain: [] });
  });
});
