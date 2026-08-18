import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getScriptedRunPermissionHandler } from '../../../../src/host/permissions/scriptedRunPermissionPolicy';

const previousPolicy = process.env.NEO_SCRIPTED_APPROVAL_POLICY;
const previousDataDir = process.env.CODE_AGENT_DATA_DIR;
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
  });

  it('ignores a configured policy outside a dev data slot', () => {
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = '/tmp/policy.json';
    process.env.CODE_AGENT_DATA_DIR = path.join('/tmp', '.code-agent');
    expect(getScriptedRunPermissionHandler()).toBeUndefined();
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
