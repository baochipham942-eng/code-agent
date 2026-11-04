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

// FU1 r1：evaluate() 只回报优先级胜出的单条 matchedRule——内置不可覆盖 deny（priority 1000）
// 在 Pass1 先命中就把同时命中的 user-deny（priority 700、overridable）挤出 matchedRule 位。
// 消费方（guardFabricGate 的 evaluateUserDeny）问的是「用户是否显式拒绝了这个请求」，与
// 优先级竞争无关，必须走 matchUserDenyRule 独立扫描；只认规则本身 action=deny，plan/dontAsk
// 档模式改写的 user-allow（result.action=deny）不在此列（r4 语义保持）。
describe('matchUserDenyRule: 用户 deny 不被内置规则遮蔽（FU1 r1）', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    resetPolicyEngine();
    engine = new PolicyEngine();
  });

  it('Write /usr/bin/x + deny Write：evaluate 的 matchedRule 被 block-root-write 抢占，扫描仍返回 user-deny', () => {
    engine.loadUserRules({ deny: ['Write'] }, 'user-ui');
    const request = { tool: 'Write', level: 'write' as const, description: 'x', filePath: '/usr/bin/x' };
    // 遮蔽现场：整体评估的 matchedRule 是内置规则，不是用户规则。
    expect(engine.evaluate(request).matchedRule?.id).toBe('block-root-write');
    expect(engine.matchUserDenyRule(request)?.id).toBe('user-deny-Write');
  });

  it('Read ~/.ssh/id_rsa + deny Read：block-ssh-keys 同理不遮蔽用户 deny', () => {
    engine.loadUserRules({ deny: ['Read'] }, 'user-ui');
    const request = { tool: 'Read', level: 'read' as const, description: 'x', filePath: '/Users/someone/.ssh/id_rsa' };
    expect(engine.evaluate(request).matchedRule?.id).toBe('block-ssh-keys');
    expect(engine.matchUserDenyRule(request)?.id).toBe('user-deny-Read');
  });

  it('无用户 deny 命中返回 null；user-allow（含模式改写）与路径不符的 user-deny 都不算', () => {
    engine.loadUserRules({ allow: ['Bash(git tag)'], deny: ['Read(**/.aws/**)'] }, 'user-ui');
    expect(engine.matchUserDenyRule({ tool: 'Bash', level: 'execute', description: 'x', command: 'git tag' })).toBeNull();
    expect(engine.matchUserDenyRule({ tool: 'Read', level: 'read', description: 'x', filePath: '/tmp/plain.txt' })).toBeNull();
  });
});
