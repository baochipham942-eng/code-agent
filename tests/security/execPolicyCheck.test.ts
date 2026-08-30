import { describe, it, expect } from 'vitest';
import {
  parseExecPolicy,
  findPolicyConflicts,
  checkPolicyExamples,
  explainPolicyCommand,
} from '../../src/host/security/execPolicyCheck';
import { matchPolicyRule, tokenizePolicyCommand, type PrefixRule } from '../../src/host/security/execPolicy';

function rule(pattern: string[], decision: PrefixRule['decision'], source: PrefixRule['source'] = 'user'): PrefixRule {
  return { pattern, decision, createdAt: 1700000000000, source };
}

function validPolicy(rules: unknown[], examples?: unknown): string {
  return JSON.stringify({ version: 1, rules, ...(examples !== undefined ? { examples } : {}) });
}

describe('parseExecPolicy (syntax)', () => {
  it('accepts a valid policy file with examples', () => {
    const parsed = parseExecPolicy(validPolicy(
      [rule(['git', 'status'], 'allow')],
      [{ command: 'git status', expect: 'allow' }],
    ));
    expect(parsed.issues).toEqual([]);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.examples).toEqual([{ command: 'git status', expect: 'allow' }]);
  });

  it('reports invalid JSON', () => {
    const parsed = parseExecPolicy('{ not json');
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.code).toBe('invalid-json');
    expect(parsed.rules).toEqual([]);
  });

  it('reports non-object top level / wrong version / missing rules array', () => {
    expect(parseExecPolicy('[]').issues[0]?.code).toBe('invalid-schema');
    const wrongVersion = parseExecPolicy(JSON.stringify({ version: 2, rules: [] }));
    expect(wrongVersion.issues.some((i) => i.message.includes('version'))).toBe(true);
    const noRules = parseExecPolicy(JSON.stringify({ version: 1 }));
    expect(noRules.issues.some((i) => i.message.includes('rules 必须是数组'))).toBe(true);
  });

  it('rejects invalid decision / empty pattern / bad source / bad createdAt', () => {
    const parsed = parseExecPolicy(validPolicy([
      { pattern: ['git'], decision: 'yes', createdAt: 1, source: 'user' },
      { pattern: [], decision: 'allow', createdAt: 1, source: 'user' },
      { pattern: ['git', ''], decision: 'allow', createdAt: 1, source: 'user' },
      { pattern: ['git'], decision: 'allow', createdAt: 1, source: 'robot' },
      { pattern: ['git'], decision: 'allow', createdAt: 'yesterday', source: 'user' },
    ]));
    expect(parsed.rules).toHaveLength(0);
    expect(parsed.issues).toHaveLength(5);
    expect(parsed.issues.every((i) => i.code === 'invalid-schema' && i.severity === 'error')).toBe(true);
  });

  it('keeps valid rules when sibling entries are broken', () => {
    const parsed = parseExecPolicy(validPolicy([
      rule(['git'], 'prompt'),
      { pattern: 'not-an-array', decision: 'allow' },
    ]));
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.issues).toHaveLength(1);
  });

  it('validates examples shape', () => {
    const parsed = parseExecPolicy(validPolicy([], [
      { command: '', expect: 'allow' },
      { command: 'git status', expect: 'maybe' },
      'not-an-object',
    ]));
    expect(parsed.examples).toHaveLength(0);
    expect(parsed.issues).toHaveLength(3);
  });
});

describe('findPolicyConflicts', () => {
  it('flags duplicate patterns: same decision = warning, different decision = error', () => {
    const same = findPolicyConflicts([rule(['git'], 'prompt'), rule(['git'], 'prompt', 'builtin')]);
    expect(same).toHaveLength(1);
    expect(same[0]?.code).toBe('duplicate-pattern');
    expect(same[0]?.severity).toBe('warning');

    const diff = findPolicyConflicts([rule(['git'], 'prompt'), rule(['git'], 'forbidden')]);
    expect(diff[0]?.severity).toBe('error');
  });

  it('flags shadow-escalation: a forbidden blanket pierced by a narrower rule', () => {
    const issues = findPolicyConflicts([rule(['git'], 'forbidden'), rule(['git', 'status'], 'allow')]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('shadow-escalation');
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.ruleIndexes).toEqual([0, 1]);

    const viaPrompt = findPolicyConflicts([rule(['git'], 'forbidden'), rule(['git', 'status'], 'prompt')]);
    expect(viaPrompt.some((i) => i.code === 'shadow-escalation')).toBe(true);
  });

  it('does not flag shadow-restriction layering (narrower rule stricter)', () => {
    const issues = findPolicyConflicts([rule(['git'], 'allow'), rule(['git', 'push'], 'prompt')]);
    expect(issues).toEqual([]);
    const harder = findPolicyConflicts([rule(['git'], 'allow'), rule(['git', 'push'], 'forbidden')]);
    expect(harder).toEqual([]);
  });

  it('does not flag allow under a broader prompt (the designed learnFromApproval usage)', () => {
    const issues = findPolicyConflicts([rule(['git'], 'prompt'), rule(['git', 'status'], 'allow')]);
    expect(issues).toEqual([]);
  });

  it('flags banned-prefix allow rules; banned prompt/forbidden are fine', () => {
    const bad = findPolicyConflicts([rule(['sudo'], 'allow'), rule(['python3', '-c'], 'allow')]);
    expect(bad).toHaveLength(2);
    expect(bad.every((i) => i.code === 'banned-prefix-allow' && i.severity === 'error')).toBe(true);

    const fine = findPolicyConflicts([rule(['sudo'], 'forbidden'), rule(['bash'], 'prompt')]);
    expect(fine).toEqual([]);
  });

  it('matches match() semantics: shadow-escalation example actually pierces the broader rule', () => {
    // forbidden git + allow git status → match('git status') 真的返回 allow（穿透成立）
    const rules = [rule(['git'], 'forbidden'), rule(['git', 'status'], 'allow')];
    expect(matchPolicyRule(rules, 'git status')?.decision).toBe('allow');
    expect(findPolicyConflicts(rules).some((i) => i.code === 'shadow-escalation')).toBe(true);
  });
});

describe('checkPolicyExamples', () => {
  const rules = [rule(['git', 'status'], 'allow'), rule(['git'], 'prompt'), rule(['rm', '-rf'], 'forbidden')];

  it('passes when actual equals expected, fails with per-item diff otherwise', () => {
    const results = checkPolicyExamples(rules, [
      { command: 'git status', expect: 'allow' },
      { command: 'git push origin main', expect: 'prompt' },
      { command: 'rm -rf /', expect: 'forbidden' },
      { command: 'npm test', expect: 'allow' },
    ]);
    expect(results.map((r) => r.pass)).toEqual([true, true, true, false]);
    expect(results[3]?.actual).toBeNull();
  });
});

describe('explainPolicyCommand', () => {
  const rules = [rule(['git'], 'prompt'), rule(['git', 'status'], 'allow')];

  it('shows the longest-prefix matching rule and why', () => {
    const explanation = explainPolicyCommand(rules, 'git status --short');
    expect(explanation.matched?.pattern).toEqual(['git', 'status']);
    expect(explanation.decision).toBe('allow');
    expect(explanation.reason).toContain('最长前缀');
    expect(explanation.tokens).toEqual(['git', 'status', '--short']);
  });

  it('reports no-match with the fall-through reason', () => {
    const explanation = explainPolicyCommand(rules, 'npm test');
    expect(explanation.matched).toBeNull();
    expect(explanation.decision).toBeNull();
    expect(explanation.reason).toContain('match() 返回 null');
  });

  it('reports unanalyzable commands (canonicalize failure) as no-match', () => {
    const explanation = explainPolicyCommand(rules, 'echo $(whoami)');
    expect(explanation.tokens).toEqual([]);
    expect(explanation.decision).toBeNull();
    expect(explanation.reason).toContain('无法静态解析');
  });
});

describe('tokenizePolicyCommand', () => {
  it('canonicalizes quoting the same way ExecPolicyStore does', () => {
    expect(tokenizePolicyCommand('  git   status  ')).toEqual(['git', 'status']);
    // 引号被 canonicalize 剥离后按空格拆词（与 match() 的拆词完全一致）
    expect(tokenizePolicyCommand('grep "hello world" file.txt')).toEqual(['grep', 'hello', 'world', 'file.txt']);
    expect(tokenizePolicyCommand('')).toEqual([]);
  });
});
