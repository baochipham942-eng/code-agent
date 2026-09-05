import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getScriptedRunPermissionHandler,
  requireScriptedRunPermissionHandler,
} from '../../../../src/host/permissions/scriptedRunPermissionPolicy';

const previousPolicy = process.env.NEO_SCRIPTED_APPROVAL_POLICY;
const previousDataDir = process.env.CODE_AGENT_DATA_DIR;
const previousBridge = process.env.CODE_AGENT_EVAL_BRIDGE;
let tempDir: string | undefined;

function installPolicy(policy: unknown): void {
  tempDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-approval-policy-'));
  const policyPath = path.join(tempDir, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify(policy), 'utf8');
  process.env.NEO_SCRIPTED_APPROVAL_POLICY = policyPath;
  process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, '.code-agent-dev3');
}

function restoreEnv(): void {
  if (previousPolicy === undefined) delete process.env.NEO_SCRIPTED_APPROVAL_POLICY;
  else process.env.NEO_SCRIPTED_APPROVAL_POLICY = previousPolicy;
  if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  if (previousBridge === undefined) delete process.env.CODE_AGENT_EVAL_BRIDGE;
  else process.env.CODE_AGENT_EVAL_BRIDGE = previousBridge;
}

describe('scripted run permission policy', () => {
  afterEach(() => {
    restoreEnv();
    vi.unstubAllEnvs();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('returns undefined when no eval policy path is configured', () => {
    delete process.env.NEO_SCRIPTED_APPROVAL_POLICY;
    expect(getScriptedRunPermissionHandler()).toBeUndefined();
    expect(() => requireScriptedRunPermissionHandler()).toThrow(/审批策略/);
  });

  it('ignores a configured policy outside a dev data slot', () => {
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = '/tmp/policy.json';
    process.env.CODE_AGENT_DATA_DIR = path.join('/tmp', '.code-agent');
    expect(getScriptedRunPermissionHandler()).toBeUndefined();
  });

  it('accepts an explicit real-eval policy outside a named dev slot', () => {
    installPolicy({ version: 1, rules: [] });
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir!, 'isolated-data');
    delete process.env.CODE_AGENT_EVAL_BRIDGE;

    expect(requireScriptedRunPermissionHandler()).toBeTypeOf('function');
  });

  it('lets the repository policy use local file and safe shell tools while denying side-effect surfaces', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-approval-policy-'));
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = path.resolve('.claude/eval-approval-policy.json');
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, 'isolated-data');
    process.env.CODE_AGENT_EVAL_BRIDGE = '1';
    const handler = requireScriptedRunPermissionHandler();

    await expect(handler({ type: 'file_read', tool: 'Read', details: { path: '/tmp/eval/input.txt' } }))
      .resolves.toMatchObject({ approved: true });
    await expect(handler({ type: 'file_write', tool: 'write_file', details: { path: '/tmp/eval/output.txt' } }))
      .resolves.toMatchObject({ approved: true });
    await expect(handler({ type: 'command', tool: 'Bash', details: { command: 'npm test' } }))
      .resolves.toMatchObject({ approved: true });
    await expect(handler({ type: 'dangerous_command', tool: 'Bash', details: { command: 'sudo reboot' } }))
      .resolves.toMatchObject({ approved: false });
    await expect(handler({ type: 'network', tool: 'WebSearch', details: { query: 'secret' } }))
      .resolves.toMatchObject({ approved: false });
    await expect(handler({ type: 'file_write', tool: 'mail_send', details: {} }))
      .resolves.toMatchObject({ approved: false });
    await expect(handler({ type: 'directory_access', tool: 'request_directory', details: { path: '/Users' } }))
      .resolves.toMatchObject({ approved: false });
  });

  // N-EVAL-ORCHARM-REALCASE：扇出实验臂的第三道闸。Task/spawn_agent 的 permissionLevel
  // 是 'execute' ⇒ requestType 'command'，但策略按 tool 精确匹配，Bash 的 command 规则
  // 盖不到它们；缺覆盖即拒 ⇒ 两臂模型都拉到了 Task 却一次也扇不出去，
  // subagentSpawns 恒 0，编排维度的实验臂等于没接线。
  // 摘掉这两条规则本用例立刻红。
  it('lets the repository policy delegate to subagents so the fan-out arm has a signal', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-approval-policy-'));
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = path.resolve('.claude/eval-approval-policy.json');
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, 'isolated-data');
    process.env.CODE_AGENT_EVAL_BRIDGE = '1';
    const handler = requireScriptedRunPermissionHandler();

    await expect(handler({ type: 'command', tool: 'Task', details: { subagent_type: 'reviewer', prompt: 'audit dir' } }))
      .resolves.toMatchObject({ approved: true, approvalSource: 'scripted' });
    await expect(handler({ type: 'command', tool: 'spawn_agent', details: { agentType: 'explore' } }))
      .resolves.toMatchObject({ approved: true, approvalSource: 'scripted' });
    // 放行的只是「派子代理」这一下：子代理自己的工具调用回到同一个 handler 重判，
    // 没有 allow 规则的工具面照旧拒。
    await expect(handler({ type: 'network', tool: 'WebFetch', details: { url: 'https://example.com' } }))
      .resolves.toMatchObject({ approved: false });
  });

  it('allows a matching tool and path with scripted attribution', async () => {
    installPolicy({
      version: 1,
      rules: [{
        id: 'allow-eval-sandbox-write',
        effect: 'allow',
        tool: 'Write',
        match: { pathPrefix: '/tmp/code-agent-eval-' },
      }],
    });
    const handler = getScriptedRunPermissionHandler();
    expect(handler).toBeTypeOf('function');
    await expect(handler!({
      type: 'file_write',
      tool: 'Write',
      details: { path: '/tmp/code-agent-eval-123/output.txt' },
    })).resolves.toEqual({
      approved: true,
      approvalSource: 'scripted',
    });
  });

  it('denies a matching tool and command with scripted attribution', async () => {
    installPolicy({
      version: 1,
      rules: [{
        id: 'deny-outside-write',
        effect: 'deny',
        tool: 'Bash',
        match: { commandPrefix: 'printf probe > /Users/' },
      }],
    });
    const handler = getScriptedRunPermissionHandler()!;
    await expect(handler({
      type: 'command',
      tool: 'Bash',
      details: { command: 'printf probe > /Users/linchen/probe.txt' },
    })).resolves.toEqual({
      approved: false,
      denialSource: 'scripted',
    });
  });

  it('denies an uncovered request by default', async () => {
    installPolicy({ version: 1, rules: [] });
    const handler = getScriptedRunPermissionHandler()!;
    await expect(handler({
      type: 'file_write',
      tool: 'Write',
      details: { path: '/tmp/uncovered.txt' },
    })).resolves.toEqual({ approved: false, denialSource: 'scripted' });
  });

  it('installs a deny-all handler when the policy file is malformed', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-approval-policy-'));
    const policyPath = path.join(tempDir, 'broken.json');
    fs.writeFileSync(policyPath, '{not-json', 'utf8');
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = policyPath;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, '.code-agent-dev3');

    const handler = getScriptedRunPermissionHandler();
    expect(handler).toBeTypeOf('function');
    await expect(handler!({
      type: 'file_write',
      tool: 'Write',
      details: { path: '/tmp/probe.txt' },
    })).resolves.toEqual({ approved: false, denialSource: 'scripted' });
    expect(() => requireScriptedRunPermissionHandler()).toThrow(/无法读取/);
  });

  it('installs a deny-all handler when the policy file is missing', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-approval-policy-'));
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = path.join(tempDir, 'missing.json');
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, '.code-agent-dev3');

    const handler = getScriptedRunPermissionHandler();
    expect(handler).toBeTypeOf('function');
    await expect(handler!({
      type: 'command',
      tool: 'Bash',
      details: { command: 'echo unsafe' },
    })).resolves.toEqual({ approved: false, denialSource: 'scripted' });
    expect(() => requireScriptedRunPermissionHandler()).toThrow(/读取/);
  });

  it('rejects wildcard allow rules by failing closed', async () => {
    installPolicy({
      version: 1,
      rules: [{ id: 'forbidden', effect: 'allow', tool: '*', match: { pathPrefix: '/' } }],
    });
    const handler = getScriptedRunPermissionHandler()!;
    await expect(handler({
      type: 'file_write',
      tool: 'Write',
      details: { path: '/tmp/probe.txt' },
    })).resolves.toEqual({ approved: false, denialSource: 'scripted' });
  });
});
