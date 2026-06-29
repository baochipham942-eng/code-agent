import { describe, expect, it } from 'vitest';
import { DEFAULT_SUPABASE_ANON_KEY, DEFAULT_SUPABASE_URL } from '../../../../src/shared/constants';
import { resolveSupabaseInitConfig, isSupabaseSessionKey } from '../../../../src/host/services/infra/supabaseService';

describe('resolveSupabaseInitConfig', () => {
  it('uses the built-in production Supabase config when no override exists', () => {
    expect(resolveSupabaseInitConfig(undefined, {})).toMatchObject({
      url: DEFAULT_SUPABASE_URL,
      anonKey: DEFAULT_SUPABASE_ANON_KEY,
      urlSource: 'default',
      anonKeySource: 'default',
      ignored: [],
    });
  });

  it('prefers valid environment config', () => {
    expect(resolveSupabaseInitConfig({
      supabase: {
        url: 'https://settings.supabase.co',
        anonKey: 'settings-key',
      },
    }, {
      SUPABASE_URL: ' https://env.supabase.co ',
      SUPABASE_ANON_KEY: ' env-key ',
    })).toMatchObject({
      url: 'https://env.supabase.co',
      anonKey: 'env-key',
      urlSource: 'env',
      anonKeySource: 'env',
      ignored: [],
    });
  });

  it('falls back to settings when the environment URL is invalid', () => {
    expect(resolveSupabaseInitConfig({
      supabase: {
        url: 'https://settings.supabase.co',
        anonKey: 'settings-key',
      },
    }, {
      SUPABASE_URL: 'not a url',
    })).toMatchObject({
      url: 'https://settings.supabase.co',
      anonKey: 'settings-key',
      urlSource: 'settings',
      anonKeySource: 'settings',
      ignored: ['SUPABASE_URL'],
    });
  });

  it('falls back to the built-in URL when custom URLs are invalid', () => {
    expect(resolveSupabaseInitConfig({
      supabase: {
        url: 'bad-settings-url',
      },
    }, {
      SUPABASE_URL: 'bad-env-url',
    })).toMatchObject({
      url: DEFAULT_SUPABASE_URL,
      urlSource: 'default',
      ignored: ['SUPABASE_URL', 'settings.supabase.url'],
    });
  });
});

describe('isSupabaseSessionKey (2b/ADR-030)', () => {
  it('匹配 supabase-js 默认 session storageKey', () => {
    expect(isSupabaseSessionKey('sb-xepbunahzbmexsmmiqyq-auth-token')).toBe(true);
    expect(isSupabaseSessionKey('sb-anyref-auth-token')).toBe(true);
  });

  it('不匹配其它键（避免误触发 Keychain 写）', () => {
    expect(isSupabaseSessionKey('supabase.session')).toBe(false); // 旧写死键（已不是真实键）
    expect(isSupabaseSessionKey('auth.user')).toBe(false);
    expect(isSupabaseSessionKey('sb-ref-auth-token.0')).toBe(false); // 分片键不整体匹配
    expect(isSupabaseSessionKey('')).toBe(false);
  });
});
