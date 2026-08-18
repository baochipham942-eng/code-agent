import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getScriptedRunPermissionHandler } from '../../../../src/host/permissions/scriptedRunPermissionPolicy';

const previousPolicy = process.env.NEO_SCRIPTED_APPROVAL_POLICY;
const previousDataDir = process.env.CODE_AGENT_DATA_DIR;

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

  it('installs a deny-all handler in a dev data slot', async () => {
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = '/tmp/policy.json';
    process.env.CODE_AGENT_DATA_DIR = path.join('/tmp', '.code-agent-dev3');
    const handler = getScriptedRunPermissionHandler();
    expect(handler).toBeTypeOf('function');
    await expect(handler!({ type: 'file_write', tool: 'Write', details: {} })).resolves.toEqual({
      approved: false,
      denialSource: 'scripted',
    });
  });
});
