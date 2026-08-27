import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error —— 纯 JS 本机验证入口，无类型声明
import { buildSlotlessConfig, maskTokenRhythmKey, parseDogfoodEnv, readDogfoodCredentials, stopRun } from '../../scripts/verify-slotless.mjs';
// @ts-expect-error —— 纯 JS 本机验证入口，无类型声明
import { parseViewport } from '../../scripts/verify-shot.mjs';

describe('slotless verification scripts', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('copies only TokenRhythm deepseek-v4-flash and routes every role to it', () => {
    const config = buildSlotlessConfig({
      models: {
        providers: {
          other: { apiKey: 'must-not-copy', model: 'other-model' },
          'custom-tokenrhythm': {
            enabled: true,
            displayName: 'TokenRhythm',
            baseUrl: 'https://example.test/v1',
            protocol: 'openai',
            apiKey: 'must-not-copy',
            model: 'deepseek-v4-pro',
            models: {
              'deepseek-v4-flash': { label: 'Flash', enabled: true, maxTokens: 8192 },
              'deepseek-v4-pro': { label: 'Pro', enabled: true },
            },
          },
        },
        routing: {
          code: { provider: 'other', model: 'other-model' },
          vision: { provider: 'other', model: 'other-model' },
        },
      },
    }, 'sk_tr_test-only-abcd');

    const providerEntries = Object.entries(config.models.providers) as Array<[string, { enabled?: boolean }]>;
    expect(providerEntries.filter(([, value]) => value.enabled).map(([id]) => id)).toEqual(['custom-tokenrhythm']);
    expect(config.models.providers.other).toEqual({ enabled: false });
    expect(Object.keys(config.models.providers['custom-tokenrhythm'].models)).toEqual(['deepseek-v4-flash']);
    expect(config.models.providers['custom-tokenrhythm'].apiKey).toBe('sk_tr_test-only-abcd');
    expect(config.models.routing).toEqual({
      code: { provider: 'custom-tokenrhythm', model: 'deepseek-v4-flash' },
      vision: { provider: 'custom-tokenrhythm', model: 'deepseek-v4-flash' },
    });
  });

  it('parses exported and quoted credentials without changing their values', () => {
    expect(parseDogfoodEnv('export NEO_DOGFOOD_EMAIL="dog@example.com"\nNEO_DOGFOOD_PASSWORD=secret#value\nNEO_DOGFOOD_TR_KEY=sk_tr_test-only-abcd\n')).toEqual({
      NEO_DOGFOOD_EMAIL: 'dog@example.com',
      NEO_DOGFOOD_PASSWORD: 'secret#value',
      NEO_DOGFOOD_TR_KEY: 'sk_tr_test-only-abcd',
    });
  });

  it('fails closed when the dogfood credential file is missing or not mode 600', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'neo-verify-secret-test-'));
    tempDirs.push(dir);
    const credentialFile = path.join(dir, 'neo-dogfood.env');

    expect(() => readDogfoodCredentials(credentialFile)).toThrow(/is required/);
    writeFileSync(credentialFile, 'NEO_DOGFOOD_EMAIL=dog@example.com\nNEO_DOGFOOD_PASSWORD=test-only\nNEO_DOGFOOD_TR_KEY=sk_tr_test-only-abcd\n');
    chmodSync(credentialFile, 0o644);
    expect(() => readDogfoodCredentials(credentialFile)).toThrow(/mode 600/);
  });

  it('fails closed with the required message when the TokenRhythm key is missing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'neo-verify-secret-test-'));
    tempDirs.push(dir);
    const credentialFile = path.join(dir, 'neo-dogfood.env');
    writeFileSync(credentialFile, 'NEO_DOGFOOD_EMAIL=dog@example.com\nNEO_DOGFOOD_PASSWORD=test-only\n', { mode: 0o600 });

    expect(() => readDogfoodCredentials(credentialFile)).toThrow('缺 NEO_DOGFOOD_TR_KEY');
  });

  it('prints only the approved masked TokenRhythm key shape', () => {
    const key = 'sk_tr_super-secret-abcd';
    const masked = maskTokenRhythmKey(key);

    expect(masked).toBe('sk_tr_…abcd');
    expect(masked).not.toContain('super-secret');
  });

  it('removes the isolated data directory after --stop cleanup', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'neo-verify-stop-test-'));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, '.neo-verify-state.json'), JSON.stringify({
      pid: 2_147_483_647,
      marker: path.basename(dir),
    }));

    await stopRun(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it('validates screenshot viewport bounds', () => {
    expect(parseViewport('1440x900')).toEqual({ width: 1440, height: 900 });
    expect(() => parseViewport('100x100')).toThrow(/outside/);
  });
});
