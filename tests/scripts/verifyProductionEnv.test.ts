import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function runVerifier(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', ['scripts/verify-production-env.mjs', ...args], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env,
    },
    encoding: 'utf8',
  });
}

function baseReleaseEnv(): NodeJS.ProcessEnv {
  return {
    TAURI_UPDATER_PUBKEY: 'updater-public-key',
    TAURI_SIGNING_PRIVATE_KEY: 'updater-private-key',
    CODE_AGENT_CONTROL_PLANE_KEY_ID: 'release-key',
    CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY: 'release-public-key',
  };
}

describe('production env verifier', () => {
  it('fails with explicit missing env names before packaging starts', () => {
    const result = runVerifier();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[verify-production-env] failed: mode=production');
    expect(result.stderr).toContain('TAURI_UPDATER_PUBKEY or TAURI_UPDATER_PUBKEY_PATH');
    expect(result.stderr).toContain('TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH');
    expect(result.stderr).toContain('CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS');
    expect(result.stderr).toContain('APPLE_SIGNING_IDENTITY or TAURI_MACOS_SIGNING_IDENTITY');
    expect(result.stderr).toContain('Apple notarization credentials are incomplete');
  });

  it('passes local mode with updater keys and control-plane public keys only', () => {
    const result = runVerifier(['--mode', 'local'], baseReleaseEnv());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[verify-production-env] passed: mode=local');
    expect(result.stdout).not.toContain('Apple notarization credentials');
  });

  it('passes notarized mode with Apple ID notarization credentials', () => {
    const result = runVerifier(['--mode', 'notarized'], {
      ...baseReleaseEnv(),
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Agent Neo (TEAM123456)',
      APPLE_ID: 'release@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'app-specific-password',
      APPLE_TEAM_ID: 'TEAM123456',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Developer ID identity');
    expect(result.stdout).toContain('Apple notarization credentials');
  });

  it('honors --require-notarization even in local mode', () => {
    const result = runVerifier(['--mode', 'local', '--require-notarization'], baseReleaseEnv());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('APPLE_SIGNING_IDENTITY or TAURI_MACOS_SIGNING_IDENTITY');
    expect(result.stderr).toContain('Apple notarization credentials are incomplete');
  });

  it('passes notarized mode with App Store Connect API key credentials', () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-agent-notary-key-'));
    const keyPath = join(dir, 'AuthKey_TEST123.p8');
    writeFileSync(keyPath, 'api-key');

    const result = runVerifier(['--mode=notarized'], {
      ...baseReleaseEnv(),
      TAURI_MACOS_SIGNING_IDENTITY: 'Developer ID Application: Agent Neo (TEAM123456)',
      APPLE_API_KEY: 'TEST123',
      APPLE_API_ISSUER: 'issuer-id',
      APPLE_API_KEY_PATH: keyPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[verify-production-env] passed: mode=notarized');
  });

  it('fails notarized mode when Apple notarization credential combinations are incomplete', () => {
    const result = runVerifier(['--mode', 'notarized'], {
      ...baseReleaseEnv(),
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Agent Neo (TEAM123456)',
      APPLE_ID: 'release@example.com',
      APPLE_PASSWORD: 'app-specific-password',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Apple notarization credentials are incomplete');
    expect(result.stderr).toContain('APPLE_TEAM_ID');
    expect(result.stderr).toContain('APPLE_API_KEY');
    expect(result.stderr).not.toContain('cargo tauri build');
  });
});
