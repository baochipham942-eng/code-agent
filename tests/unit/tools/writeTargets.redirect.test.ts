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
    ["sh -c 'printf x > \"my file.txt\"'", 'my file.txt'],
    ['bash -c "printf x > \'my file.txt\'"', 'my file.txt'],
    ['bash -c "echo hi > out.txt"', 'out.txt'],
    ['eval "echo hi > out.txt"', 'out.txt'],
    ["eval 'echo hi' '> out.txt'", 'out.txt'],
    ["sh -lc 'printf x > out.txt'", 'out.txt'],
    ["sh -c -- 'printf x > out.txt'", 'out.txt'],
    ["bash --noprofile -c 'printf x > out.txt'", 'out.txt'],
    ["bash --norc --noprofile -c 'printf x > out.txt'", 'out.txt'],
    ["zsh -ec 'printf x > out.txt'", 'out.txt'],
    ["dash -c 'printf x > out.txt'", 'out.txt'],
    ["MODE=1 sh -c 'printf x > out.txt'", 'out.txt'],
    ["env sh -c 'printf x > out.txt'", 'out.txt'],
    ["env FOO=1 sh -c 'printf x > out.txt'", 'out.txt'],
    ["env -i sh -c 'printf x > out.txt'", 'out.txt'],
    ["env -u MODE sh -c 'printf x > out.txt'", 'out.txt'],
    ["env MODE=1 /bin/bash -c 'printf x > out.txt'", 'out.txt'],
    ["env -S 'sh -c \"printf x > out.txt\"'", 'out.txt'],
    ["env --split-string 'bash -c \"printf x > out.txt\"'", 'out.txt'],
    ["nohup sh -c 'printf x > out.txt'", 'out.txt'],
    ["timeout 5 sh -c 'printf x > out.txt'", 'out.txt'],
    ["nice sh -c 'printf x > out.txt'", 'out.txt'],
    ["/bin/sh -c 'printf x > out.txt'", 'out.txt'],
    ["command sh -c 'printf x > out.txt'", 'out.txt'],
    ["command -p sh -c 'printf x > out.txt'", 'out.txt'],
    ["echo ok && sh -c 'echo hi > out.txt'", 'out.txt'],
    ["true & sh -c 'echo hi > out.txt'", 'out.txt'],
    ["true\nsh -c 'echo hi > out.txt'", 'out.txt'],
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
    expect(resolve("env -S 'sh -c \"echo hi 2>&1\"'")).toMatchObject({
      targets: [],
      uncertain: [],
    });
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
    'bash --rcfile foo -c \'echo > f\'',
    'bash --rcfile "$F" -c \'echo hi > out.txt\'',
    'bash -o pipefail -c \'echo > f\'',
  ])('fails closed when an option value prevents static script location: %s', (command) => {
    expect(resolve(command)).toMatchObject({
      targets: [],
      uncertain: ['uncertain-redirection:bash'],
    });
  });

  it.each([
    "sh${IFS}-c 'echo > f'",
    "sh$IFS-c 'echo > f'",
    "sh$'\\x20'-c 'echo > f'",
  ])('fails closed for IFS/ANSI-C whitespace glued wrappers: %s', (command) => {
    const result = resolve(command);
    expect(
      result.targets.includes(resolveCanonicalRunPath(path.join(workingDirectory, 'f')))
      || result.uncertain.length > 0,
    ).toBe(true);
  });

  it.each([
    "sh$'\\x20'-c 'echo > f'",
    "sh${IFS}-c 'echo > f'",
    "s\\h -c 'x'",
  ])('fails closed when the command word uses dynamic or escaped syntax: %s', (command) => {
    expect(resolve(command).uncertain).toContain('uncertain-redirection:dynamic-command');
  });

  it('fails closed instead of resolving a wrapper target against a stale cwd', () => {
    expect(resolve("cd .. && sh -c 'printf x > memory/c.md'")).toMatchObject({
      targets: [],
      uncertain: ['uncertain-redirection:cwd-changed'],
    });
  });

  it('keeps absolute wrapper targets after a cwd change', () => {
    expect(resolve("cd .. && sh -c 'printf x > /abs/p'")).toMatchObject({
      targets: [resolveCanonicalRunPath('/abs/p')],
      uncertain: [],
    });
  });

  it('keeps resolving relative wrapper targets when the cwd is unchanged', () => {
    expect(resolve("sh -c 'printf x > memory/c.md'")).toMatchObject({
      targets: [resolveCanonicalRunPath(path.join(workingDirectory, 'memory/c.md'))],
      uncertain: [],
    });
  });

  it.each([
    ["sh -c 'echo $(date) > out.txt'", 'uncertain-redirection:sh'],
    ['env -S "$WRAPPER"', 'uncertain-redirection:env'],
    ['sh -c "$SCRIPT"', 'uncertain-redirection:sh'],
    ['eval "${SCRIPT}"', 'uncertain-redirection:eval'],
    ['$(sh -c \'cat > "$HOME/x"\')', 'uncertain-redirection:command-substitution'],
    ['echo "$(sh -c \'cat > $HOME/x\')"', 'uncertain-redirection:command-substitution'],
    ["echo `sh -c 'cat > $HOME/x'`", 'uncertain-redirection:command-substitution'],
    ["eval 'echo `date` > out.txt'", 'uncertain-redirection:eval'],
    ["sh -c 'echo \"unterminated > out.txt'", 'uncertain-redirection:sh'],
    ["setsid sh -c 'echo > out.txt'", 'uncertain-redirection:sh'],
    ['time bash -c "echo > out.txt"', 'uncertain-redirection:bash'],
    ["setsid bash --noprofile -c 'echo > out.txt'", 'uncertain-redirection:bash'],
    ["xargs -0 sh -c 'x'", 'uncertain-redirection:sh'],
    ["sudo -u me bash -c 'x'", 'uncertain-redirection:bash'],
    ["printf '%s\\n' sh -c 'x'", 'uncertain-redirection:sh'],
    [`cat <(sh -c 'printf x > "$HOME/m/c.md"')`, 'uncertain-redirection:process-substitution'],
    ["cat >(eval 'printf x')", 'uncertain-redirection:process-substitution'],
    ['"$runner" -c \'printf x\'', 'uncertain-redirection:dynamic-command'],
    ["$runner -c 'printf x'", 'uncertain-redirection:dynamic-command'],
    ["${runner} -c 'printf x'", 'uncertain-redirection:dynamic-command'],
    ['$runner script.sh', 'uncertain-redirection:dynamic-command'],
    ['sh <<EOF', 'uncertain-redirection:sh'],
    ['eval <<EOF', 'uncertain-redirection:eval'],
    ['bash script.sh', 'uncertain-redirection:bash'],
    ['bash -x script.sh', 'uncertain-redirection:bash'],
    ['sh script.sh', 'uncertain-redirection:sh'],
    ['sh -x script.sh', 'uncertain-redirection:sh'],
    ['bash "$SCRIPT"', 'uncertain-redirection:bash'],
    ['source script.sh', 'uncertain-redirection:source'],
    ['. script.sh', 'uncertain-redirection:source'],
    ['git log | sh', 'uncertain-redirection:sh'],
    ["printf '%s' bash", 'uncertain-redirection:bash'],
    ['echo bash', 'uncertain-redirection:bash'],
    ['grep sh file', 'uncertain-redirection:sh'],
    ['echo eval', 'uncertain-redirection:eval'],
  ])('fails closed when a wrapped script cannot be resolved: %s', (command, reason) => {
    expect(resolve(command)).toMatchObject({ targets: [], uncertain: [reason] });
  });

  it('keeps a direct target while failing closed on a dynamic command word', () => {
    expect(resolve('$CMD > f')).toMatchObject({
      targets: [resolveCanonicalRunPath(path.join(workingDirectory, 'f'))],
      uncertain: ['uncertain-redirection:dynamic-command'],
    });
  });

  it.each([
    'echo "a > b"',
    "echo '$(sh -c \"echo hi > out.txt\")'",
    'echo $(date)',
    'echo "$(date)"',
    'echo `date`',
    'grep ">" f',
    'diff <(printf a) <(printf b)',
    'cat >(printf a)',
    "printf '%s' '$runner' -c 'x'",
    "sed 's/>/x/' f",
    'echo "a${IFS}b"',
    'echo "$\'x\'"',
  ])('ignores redirect syntax in ordinary quoted arguments: %s', (command) => {
    expect(resolve(command)).toMatchObject({ targets: [], uncertain: [] });
  });
});
