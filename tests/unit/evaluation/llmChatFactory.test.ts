// ============================================================================
// llmChatFactory tests — Self-Evolving v2.5 Phase 7 (A)
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import {
  buildChatFn,
  loadApiKeyForProvider,
  resolveProviderBaseUrl,
  buildAttributionChatFnFromEnv,
  DEFAULT_ATTRIBUTION_MODEL,
} from '../../../src/main/evaluation/llmChatFactory';

describe('llmChatFactory', () => {
  describe('resolveProviderBaseUrl', () => {
    it('returns known provider URL from MODEL_API_ENDPOINTS', () => {
      const url = resolveProviderBaseUrl('deepseek');
      expect(url).toBeTruthy();
      expect(url).toContain('deepseek.com');
    });

    it('returns null for unknown provider', () => {
      expect(resolveProviderBaseUrl('bogus')).toBeNull();
    });
  });

  describe('loadApiKeyForProvider', () => {
    let tmpDir: string;
    let envFile: string;
    const SAVED_ENV = { ...process.env };

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-fac-'));
      envFile = path.join(tmpDir, '.env');
      // Make sure test envs don't leak in
      delete process.env.FAKE_API_KEY;
    });

    afterEach(async () => {
      process.env = { ...SAVED_ENV };
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('prefers process.env over file', async () => {
      process.env.FAKE_API_KEY = 'from-env';
      await fs.writeFile(envFile, 'FAKE_API_KEY=from-file\n');
      const key = await loadApiKeyForProvider('fake', envFile);
      expect(key).toBe('from-env');
    });

    it('falls back to .env file when env var is missing', async () => {
      await fs.writeFile(envFile, 'FAKE_API_KEY=from-file\n');
      const key = await loadApiKeyForProvider('fake', envFile);
      expect(key).toBe('from-file');
    });

    it('strips quotes from .env values', async () => {
      await fs.writeFile(envFile, 'FAKE_API_KEY="quoted-value"\n');
      const key = await loadApiKeyForProvider('fake', envFile);
      expect(key).toBe('quoted-value');
    });

    it('returns null when no env var and no file', async () => {
      const key = await loadApiKeyForProvider('fake', path.join(tmpDir, 'missing.env'));
      expect(key).toBeNull();
    });
  });

  describe('buildChatFn', () => {
    const SAVED_ENV = { ...process.env };
    afterEach(() => {
      process.env = { ...SAVED_ENV };
    });

    it('rejects malformed model spec (no slash)', async () => {
      const result = await buildChatFn({ polishModel: 'nomodel' });
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('provider/model');
      }
    });

    it('rejects when provider part is empty', async () => {
      const result = await buildChatFn({ polishModel: '/deepseek-chat' });
      expect('error' in result).toBe(true);
    });

    it('rejects when model part is empty', async () => {
      const result = await buildChatFn({ polishModel: 'deepseek/' });
      expect('error' in result).toBe(true);
    });

    it('rejects unknown provider with clear error', async () => {
      process.env.BOGUS_API_KEY = 'dummy';
      const result = await buildChatFn({ polishModel: 'bogus/xyz' });
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('Unknown provider');
      }
    });

    it('rejects when API key is missing', async () => {
      delete process.env.DEEPSEEK_API_KEY;
      const result = await buildChatFn({
        polishModel: 'deepseek/deepseek-chat',
        envFilePath: path.join(os.tmpdir(), 'definitely-not-a-file-' + Date.now()),
      });
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('No API key');
      }
    });

    it('returns a callable chatFn when provider/key/URL all resolve', async () => {
      process.env.DEEPSEEK_API_KEY = 'dummy-key';
      const result = await buildChatFn({ polishModel: 'deepseek/deepseek-chat' });
      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.provider).toBe('deepseek');
        expect(result.model).toBe('deepseek-chat');
        expect(typeof result.chatFn).toBe('function');
      }
    });
  });

  describe('buildAttributionChatFnFromEnv', () => {
    const SAVED_ENV = { ...process.env };
    afterEach(() => {
      process.env = { ...SAVED_ENV };
    });

    it('returns null when env flag is not set', async () => {
      delete process.env.CODE_AGENT_EVAL_LLM_ENABLED;
      const fn = await buildAttributionChatFnFromEnv();
      expect(fn).toBeNull();
    });

    it('returns null when env flag is explicitly "0"', async () => {
      process.env.CODE_AGENT_EVAL_LLM_ENABLED = '0';
      const fn = await buildAttributionChatFnFromEnv();
      expect(fn).toBeNull();
    });

    it('returns null silently when flag on but no API key', async () => {
      process.env.CODE_AGENT_EVAL_LLM_ENABLED = '1';
      process.env.CODE_AGENT_EVAL_LLM_MODEL = 'bogus/xyz';
      const fn = await buildAttributionChatFnFromEnv();
      expect(fn).toBeNull();
    });

    it('returns a callable chatFn when flag on and default provider key present', async () => {
      process.env.CODE_AGENT_EVAL_LLM_ENABLED = '1';
      process.env.DEEPSEEK_API_KEY = 'dummy-for-test';
      // Don't set CODE_AGENT_EVAL_LLM_MODEL so default is used
      delete process.env.CODE_AGENT_EVAL_LLM_MODEL;
      const fn = await buildAttributionChatFnFromEnv();
      expect(fn).not.toBeNull();
      expect(typeof fn).toBe('function');
    });

    it('DEFAULT_ATTRIBUTION_MODEL is a valid provider/model spec', () => {
      expect(DEFAULT_ATTRIBUTION_MODEL).toMatch(/^[a-z]+\/.+$/);
    });

    it('respects CODE_AGENT_EVAL_LLM_MODEL override', async () => {
      process.env.CODE_AGENT_EVAL_LLM_ENABLED = '1';
      process.env.CODE_AGENT_EVAL_LLM_MODEL = 'unknown-provider/some-model';
      // No API key for unknown-provider → should return null
      const fn = await buildAttributionChatFnFromEnv();
      expect(fn).toBeNull();
    });
  });
});
