import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getUserConfigDir } from '../../src/host/config/configPaths';
import { getExecPolicyStore, resetExecPolicyStore } from '../../src/host/security/execPolicy';

let fakeHome: string;

afterEach(() => {
  resetExecPolicyStore();
  vi.unstubAllEnvs();
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('Vitest 用户目录隔离', () => {
  it('既不读取 HOME 的 find 放行规则，也不把新规则写回 HOME', async () => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), 'policy-home-'));
    const homeConfig = path.join(fakeHome, '.code-agent');
    mkdirSync(homeConfig);
    const policyPath = path.join(homeConfig, 'exec-policy.json');
    const sentinel = JSON.stringify({ version: 1, rules: [{
      pattern: ['find', '.'], decision: 'allow', source: 'user', createdAt: 1,
    }] });
    writeFileSync(policyPath, sentinel);
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('CODE_AGENT_HOME', '');
    resetExecPolicyStore();

    expect(getUserConfigDir()).not.toBe(homeConfig);
    const store = getExecPolicyStore();
    expect(store.match('find .')).toBeNull();
    store.addRule(['smallbatch-isolation-probe'], 'allow');
    await store.save();

    expect(readFileSync(policyPath, 'utf8')).toBe(sentinel);
    expect(readdirSync(homeConfig)).toEqual(['exec-policy.json']);
    expect(readFileSync(path.join(getUserConfigDir(), 'exec-policy.json'), 'utf8'))
      .toContain('smallbatch-isolation-probe');

  });
});
