// Rules with commandPattern/pathPattern must not match requests carrying no command/path.
import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyEngine, resetPolicyEngine, type PolicyRule } from '../../../src/host/permissions/policyEngine';
import { PolicyEngineSource } from '../../../src/host/permissions/guardFabric';

describe('policy rules with pattern but empty input', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    resetPolicyEngine();
    engine = new PolicyEngine();
  });

  it.each(['Read', 'Write', 'mcp__x__y'])('%s at execute level without command is not denied by block-rm-rf-root', (tool) => {
    const r = engine.evaluate({ tool, level: 'execute', description: `tool: ${tool}` });
    expect(r.matchedRule?.id).not.toBe('block-rm-rf-root');
    expect(r.action).not.toBe('deny');
  });

  it('Bash rm -rf / is still denied by block-rm-rf-root', () => {
    const r = engine.evaluate({ tool: 'Bash', level: 'execute', description: 'x', command: 'rm -rf /' });
    expect(r.action).toBe('deny');
    expect(r.matchedRule?.id).toBe('block-rm-rf-root');
  });

  it('write to ~/.env still prompts via block-env-files', () => {
    const r = engine.evaluate({ tool: 'Write', level: 'write', description: 'x', filePath: '/Users/someone/.env' });
    expect(r.matchedRule?.id).toBe('block-env-files');
    expect(r.action).toBe('prompt');
  });

  it('write to /usr/bin/evil is still denied by block-root-write', () => {
    const r = engine.evaluate({ tool: 'Write', level: 'write', description: 'x', filePath: '/usr/bin/evil' });
    expect(r.action).toBe('deny');
    expect(r.matchedRule?.id).toBe('block-root-write');
  });

  it('user rule with commandPattern does not match an empty-string command', () => {
    const rule: PolicyRule = {
      id: 'user-cmd-rule',
      name: 'user-cmd-rule',
      priority: 800,
      matcher: { level: 'execute', commandPattern: 'foo' },
      action: 'deny',
      overridable: true,
      audit: false,
    };
    engine.addRule(rule);
    const empty = engine.evaluate({ tool: 'Bash', level: 'execute', description: 'x', command: '' });
    expect(empty.matchedRule?.id).not.toBe('user-cmd-rule');
    const hit = engine.evaluate({ tool: 'Bash', level: 'execute', description: 'x', command: 'foo bar' });
    expect(hit.matchedRule?.id).toBe('user-cmd-rule');
  });

  it('PolicyEngineSource: Read with file_path is not denied by rules', () => {
    resetPolicyEngine();
    const result = new PolicyEngineSource().evaluate({
      tool: 'Read',
      args: { file_path: '/tmp/x' },
      topology: 'main',
    });
    expect(result).not.toBeNull();
    expect(result!.verdict).not.toBe('deny');
  });
});
