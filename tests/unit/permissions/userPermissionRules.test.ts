import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PolicyEngine } from '../../../src/host/permissions/policyEngine';
import { parseToolSpecifier } from '../../../src/host/permissions/specifierParser';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import {
  TOOL_SPECIFIER_PATTERN,
  TOOL_SPECIFIER_TYPES,
  validateUserPermissionRule,
} from '../../../src/shared/permissionRuleSyntax';
import { resolvePermissionRulesBlur } from '../../../src/renderer/components/features/settings/tabs/GeneralSettings';

const ACCEPTED_ALLOW = ['Bash(git status)', 'Edit(src/**)', 'Read', 'WebFetch'] as const;

const ALLOW_ALL_BASH = [
  'Bash',
  'bash',
  'Bash(*)',
  'Bash(**)',
  'Bash( * )',
  ' Bash(*) ',
  'Bash(***)',
  'Bash(?*)',
  'Bash({*,**})',
  'Bash(@(**))',
] as const;

const NARROW_BASH = ['Bash(git *)', 'Bash(npm run *)', 'Bash(rm *)'] as const;

function freshEngine(): PolicyEngine {
  const engine = new PolicyEngine();
  engine.setAuditEnabled(false);
  return engine;
}

afterEach(() => {
  resetPermissionModeManager();
  vi.restoreAllMocks();
});

describe('validateUserPermissionRule', () => {
  it('accepts well-formed rules and rejects empty, malformed, and unsupported specifiers', () => {
    for (const rule of ACCEPTED_ALLOW) {
      expect(validateUserPermissionRule(rule, 'allow'), rule).toEqual({ ok: true });
    }
    expect(validateUserPermissionRule('', 'allow')).toEqual({ ok: false, reason: 'empty' });
    expect(validateUserPermissionRule('   ', 'allow')).toEqual({ ok: false, reason: 'empty' });
    expect(validateUserPermissionRule('Bash(', 'allow')).toEqual({ ok: false, reason: 'malformed' });
    expect(validateUserPermissionRule('(x)', 'allow')).toEqual({ ok: false, reason: 'malformed' });
    expect(validateUserPermissionRule('Bash()', 'allow')).toEqual({ ok: false, reason: 'malformed' });
    expect(validateUserPermissionRule('Network(*)', 'allow')).toEqual({ ok: false, reason: 'specifier_not_supported' });
    expect(validateUserPermissionRule('WebFetch(example.com)', 'allow')).toEqual({
      ok: false,
      reason: 'specifier_not_supported',
    });
  });

  it('rejects allow-all Bash spellings and keeps narrow Bash patterns', () => {
    for (const rule of ALLOW_ALL_BASH) {
      expect(validateUserPermissionRule(rule, 'allow'), rule).toEqual({ ok: false, reason: 'allow_all_bash' });
      expect(validateUserPermissionRule(rule, 'ask'), rule).toEqual({ ok: true });
      expect(validateUserPermissionRule(rule, 'deny'), rule).toEqual({ ok: true });
    }
    for (const rule of NARROW_BASH) {
      expect(validateUserPermissionRule(rule, 'allow'), rule).toEqual({ ok: true });
    }
  });
});

describe('parseToolSpecifier shares the validator table', () => {
  it('returns a non-none specifierType iff a specifier is present', () => {
    for (const rule of ACCEPTED_ALLOW) {
      const parsed = parseToolSpecifier(rule);
      const specifierPresent = parsed.specifier !== undefined;
      expect(parsed.specifierType !== 'none', rule).toBe(specifierPresent);
      const match = TOOL_SPECIFIER_PATTERN.exec(rule);
      if (match) {
        expect(parsed.toolName).toBe(match[1]);
        expect(parsed.specifier).toBe(match[2]);
        expect(parsed.specifierType).toBe(TOOL_SPECIFIER_TYPES[match[1]]);
      } else {
        expect(parsed.specifierType).toBe('none');
      }
    }
  });

  it('does not keep a second copy of the specifier table or regex', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/host/permissions/specifierParser.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/const TOOL_SPECIFIER_TYPES/);
    expect(source).not.toMatch(/TOOL_SPECIFIER_TYPES\s*=/);
    expect(source).not.toContain('^(\\w+)\\((.+)\\)$');
    expect(source).toContain('permissionRuleSyntax');
  });
});

describe('editor-accepted rules are the rules the engine loads', () => {
  const messages = {
    empty: 'empty',
    malformed: 'malformed',
    specifierNotSupported: 'specifier',
    allowAllBash: 'allow all',
  };
  const accepted = [...ACCEPTED_ALLOW, ...NARROW_BASH, 'Write(/etc/*)', 'Glob(src/**)', 'ListDirectory'];
  const rejected = ['', '   ', 'Bash(', '(x)', 'Bash()', 'Network(*)', 'WebFetch(example.com)', ...ALLOW_ALL_BASH];

  it('loads every rule the editor accepts and skips every rule the editor rejects', () => {
    for (const rule of accepted) {
      const decision = resolvePermissionRulesBlur('allow', rule, messages);
      expect(decision, rule).toEqual({ ok: true, rules: [rule] });
      const engine = freshEngine();
      const before = engine.getRules().map((entry) => entry.id);
      engine.loadUserRules({ allow: [rule] });
      const added = engine.getRules().map((entry) => entry.id).filter((id) => !before.includes(id));
      expect(added, rule).toEqual([`user-allow-${rule}`]);
    }

    for (const rule of rejected) {
      expect(validateUserPermissionRule(rule, 'allow').ok, rule).toBe(false);
      if (rule.trim()) {
        const decision = resolvePermissionRulesBlur('allow', rule, messages);
        expect(decision.ok, rule).toBe(false);
      }
      const engine = freshEngine();
      const before = engine.getRules().length;
      engine.loadUserRules({ allow: [rule] });
      expect(engine.getRules().length, rule).toBe(before);
    }

    for (const rule of ALLOW_ALL_BASH) {
      const trimmed = rule.trim();
      const decision = resolvePermissionRulesBlur('deny', rule, messages);
      expect(decision.ok, rule).toBe(true);
      const engine = freshEngine();
      engine.loadUserRules({ deny: [rule] });
      expect(engine.getRules().some((entry) => entry.id === `user-deny-${trimmed}`), rule).toBe(true);
    }
  });
});

describe('PolicyEngine user rules', () => {
  it('user deny beats user allow for the same Bash command', () => {
    expect(getPermissionModeManager().setMode('bypassPermissions', true)).toBe(true);
    const request = {
      tool: 'Bash',
      level: 'execute' as const,
      description: 'rm x',
      command: 'rm x',
    };

    const denied = freshEngine();
    denied.loadUserRules({ deny: ['Bash(rm *)'], allow: ['Bash(rm *)', 'Bash(*)'] });
    const denyResult = denied.evaluate(request);
    expect(denyResult.action).toBe('deny');
    expect(denyResult.matchedRule?.id).toBe('user-deny-Bash(rm *)');

    const allowed = freshEngine();
    allowed.loadUserRules({ allow: ['Bash(rm *)', 'Bash(*)'] });
    const allowResult = allowed.evaluate(request);
    expect(allowResult.action).toBe('allow');
    expect(allowResult.matchedRule?.id).toBe('user-allow-Bash(rm *)');
  });

  it('does not let a user Read allow override the built-in ssh key deny', () => {
    const engine = freshEngine();
    engine.loadUserRules({ allow: ['Read(*)'] });
    const result = engine.evaluate({
      tool: 'Read',
      level: 'read',
      description: 'read ssh key',
      filePath: '~/.ssh/id_rsa',
    });
    expect(result.action).toBe('deny');
    expect(result.matchedRule?.id).toBe('block-ssh-keys');
  });

  it('loads a hyphenated MCP deny rule and denies the same tool', () => {
    expect(getPermissionModeManager().setMode('bypassPermissions', true)).toBe(true);
    const tool = 'mcp__foo-bar__baz';
    const dotted = 'mcp__foo.bar__baz';
    expect(validateUserPermissionRule(tool, 'deny')).toEqual({ ok: true });
    expect(validateUserPermissionRule(dotted, 'deny')).toEqual({ ok: true });

    const engine = freshEngine();
    engine.loadUserRules({ deny: [tool, dotted] });

    const hyphenated = engine.evaluate({
      tool,
      level: 'network',
      description: 'call hyphenated mcp tool',
    });
    expect(hyphenated.action).toBe('deny');
    expect(hyphenated.matchedRule?.id).toBe(`user-deny-${tool}`);

    const dottedResult = engine.evaluate({
      tool: dotted,
      level: 'network',
      description: 'call dotted mcp tool',
    });
    expect(dottedResult.action).toBe('deny');
    expect(dottedResult.matchedRule?.id).toBe(`user-deny-${dotted}`);
  });

  it('skips an allow-all Bash rule already stored in config and keeps the rest', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const engine = freshEngine();
    engine.loadUserRules({ allow: ['Bash(*)', 'Read(*)'] });

    const ids = engine.getRules().map((entry) => entry.id);
    expect(ids).not.toContain('user-allow-Bash(*)');
    expect(ids).toContain('user-allow-Read(*)');
    const warned = spy.mock.calls.some((call) => call.join(' ').includes('Bash(*)'));
    expect(warned).toBe(true);

    const read = engine.evaluate({
      tool: 'Read',
      level: 'read',
      description: 'read notes',
      filePath: 'notes.txt',
    });
    expect(read.action).toBe('allow');
    expect(read.matchedRule?.id).toBe('user-allow-Read(*)');

    const rm = engine.evaluate({
      tool: 'Bash',
      level: 'execute',
      description: 'rm x',
      command: 'rm x',
    });
    expect(rm.action).not.toBe('allow');
    expect(rm.matchedRule?.id).not.toBe('user-allow-Bash(*)');
  });
});
