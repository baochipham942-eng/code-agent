import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error —— 纯 JS 本机验证入口，无类型声明
import { buildSlotlessConfig, parseDogfoodEnv, readDogfoodCredentials } from '../../scripts/verify-slotless.mjs';
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
    });

    const providerEntries = Object.entries(config.models.providers) as Array<[string, { enabled?: boolean }]>;
    expect(providerEntries.filter(([, value]) => value.enabled).map(([id]) => id)).toEqual(['custom-tokenrhythm']);
    expect(config.models.providers.other).toEqual({ enabled: false });
    expect(Object.keys(config.models.providers['custom-tokenrhythm'].models)).toEqual(['deepseek-v4-flash']);
    expect(config.models.providers['custom-tokenrhythm']).not.toHaveProperty('apiKey');
    expect(config.models.routing).toEqual({
      code: { provider: 'custom-tokenrhythm', model: 'deepseek-v4-flash' },
      vision: { provider: 'custom-tokenrhythm', model: 'deepseek-v4-flash' },
    });
  });

  it('parses exported and quoted credentials without changing their values', () => {
    expect(parseDogfoodEnv('export NEO_DOGFOOD_EMAIL="dog@example.com"\nNEO_DOGFOOD_PASSWORD=secret#value\n')).toEqual({
      NEO_DOGFOOD_EMAIL: 'dog@example.com',
      NEO_DOGFOOD_PASSWORD: 'secret#value',
    });
  });

  it('fails closed when the dogfood credential file is missing or not mode 600', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'neo-verify-secret-test-'));
    tempDirs.push(dir);
    const credentialFile = path.join(dir, 'neo-dogfood.env');

    expect(() => readDogfoodCredentials(credentialFile)).toThrow(/is required/);
    writeFileSync(credentialFile, 'NEO_DOGFOOD_EMAIL=dog@example.com\nNEO_DOGFOOD_PASSWORD=test-only\n');
    chmodSync(credentialFile, 0o644);
    expect(() => readDogfoodCredentials(credentialFile)).toThrow(/mode 600/);
  });

  it('validates screenshot viewport bounds', () => {
    expect(parseViewport('1440x900')).toEqual({ width: 1440, height: 900 });
    expect(() => parseViewport('100x100')).toThrow(/outside/);
  });
});
