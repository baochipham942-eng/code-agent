// ============================================================================
// [env_filter] policy section tests (A8)
// ============================================================================
//
// Covers: TOML parsing defaults, loadPolicy defaults (fail-closed strip=on),
// user/project-level loosening, merge rules, and the mtime-keyed
// getEnvFilterPolicy cache used by the Bash tool on every child spawn.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDefaultPolicy,
  parseSimpleToml,
  policyFromToml,
} from '../../../src/host/security/policyFile';
import {
  getEnvFilterPolicy,
  loadPolicy,
} from '../../../src/host/security/policyLoader';

describe('[env_filter] policy', () => {
  let dirs: string[] = [];
  let savedDataDir: string | undefined;

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'env-filter-policy-'));
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    savedDataDir = process.env.CODE_AGENT_DATA_DIR;
    // Isolate user-level config (~/.code-agent) into a fresh tmp dir.
    process.env.CODE_AGENT_DATA_DIR = makeTmpDir();
  });

  afterEach(() => {
    if (savedDataDir === undefined) {
      delete process.env.CODE_AGENT_DATA_DIR;
    } else {
      process.env.CODE_AGENT_DATA_DIR = savedDataDir;
    }
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  it('policyFromToml parses strip_secret_vars and allowed_secret_vars', () => {
    const parsed = parseSimpleToml([
      '[env_filter]',
      'strip_secret_vars = false',
      'allowed_secret_vars = ["MY_APP_API_KEY", "CI_JOB_TOKEN"]',
    ].join('\n'));
    const policy = policyFromToml(parsed);
    expect(policy.env_filter).toEqual({
      strip_secret_vars: false,
      allowed_secret_vars: ['MY_APP_API_KEY', 'CI_JOB_TOKEN'],
    });
  });

  it('defaults: strip on, empty allowed list (fail-closed)', () => {
    expect(createDefaultPolicy().env_filter).toEqual({
      strip_secret_vars: true,
      allowed_secret_vars: [],
    });
    // No policy files anywhere → defaults still strip.
    const policy = loadPolicy(makeTmpDir());
    expect(policy.env_filter.strip_secret_vars).toBe(true);
    expect(policy.env_filter.allowed_secret_vars).toEqual([]);
  });

  it('user-level policy.toml can disable the filter', () => {
    writeFileSync(
      join(process.env.CODE_AGENT_DATA_DIR!, 'policy.toml'),
      '[env_filter]\nstrip_secret_vars = false\n',
    );
    expect(getEnvFilterPolicy(makeTmpDir()).strip_secret_vars).toBe(false);
  });

  it('user-level allowed_secret_vars is honored', () => {
    writeFileSync(
      join(process.env.CODE_AGENT_DATA_DIR!, 'policy.toml'),
      '[env_filter]\nallowed_secret_vars = ["E2E_FAKE_API_KEY"]\n',
    );
    const policy = getEnvFilterPolicy(makeTmpDir());
    expect(policy.strip_secret_vars).toBe(true);
    expect(policy.allowed_secret_vars).toEqual(['E2E_FAKE_API_KEY']);
  });

  it('project-level code-agent-policy.toml is honored (tests run trusted)', () => {
    const projectDir = makeTmpDir();
    writeFileSync(
      join(projectDir, 'code-agent-policy.toml'),
      '[env_filter]\nallowed_secret_vars = ["PROJECT_LEVEL_TOKEN"]\n',
    );
    expect(getEnvFilterPolicy(projectDir).allowed_secret_vars).toEqual(['PROJECT_LEVEL_TOKEN']);
  });

  it('merge: user-level scalar overrides project; non-empty user allowed list wins', () => {
    const projectDir = makeTmpDir();
    writeFileSync(
      join(projectDir, 'code-agent-policy.toml'),
      '[env_filter]\nstrip_secret_vars = true\nallowed_secret_vars = ["PROJECT_TOKEN"]\n',
    );
    writeFileSync(
      join(process.env.CODE_AGENT_DATA_DIR!, 'policy.toml'),
      '[env_filter]\nstrip_secret_vars = false\nallowed_secret_vars = ["USER_TOKEN"]\n',
    );
    const policy = getEnvFilterPolicy(projectDir);
    expect(policy.strip_secret_vars).toBe(false);
    expect(policy.allowed_secret_vars).toEqual(['USER_TOKEN']);
  });

  it('cache invalidates when a policy file appears (mtime fingerprint)', () => {
    const projectDir = makeTmpDir();
    expect(getEnvFilterPolicy(projectDir).strip_secret_vars).toBe(true);

    const userPolicy = join(process.env.CODE_AGENT_DATA_DIR!, 'policy.toml');
    mkdirSync(process.env.CODE_AGENT_DATA_DIR!, { recursive: true });
    writeFileSync(userPolicy, '[env_filter]\nstrip_secret_vars = false\n');
    expect(getEnvFilterPolicy(projectDir).strip_secret_vars).toBe(false);

    writeFileSync(userPolicy, '[env_filter]\nallowed_secret_vars = ["LATER_TOKEN"]\n');
    const updated = getEnvFilterPolicy(projectDir);
    expect(updated.strip_secret_vars).toBe(true);
    expect(updated.allowed_secret_vars).toEqual(['LATER_TOKEN']);
  });
});
