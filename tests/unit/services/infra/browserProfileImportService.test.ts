import { createCipheriv } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  deriveChromiumSafeStorageKey,
} from '../../../../src/host/services/infra/browser/browserCookieCrypto';
import { importBrowserProfileCookies } from '../../../../src/host/services/infra/browser/browserProfileImportService';

function encryptV10(password: string, plaintext: string): Buffer {
  const key = deriveChromiumSafeStorageKey(password);
  const iv = Buffer.alloc(16, ' ');
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), encrypted]);
}

describe('browserProfileImportService (ADR-041)', () => {
  it('rejects unconfirmed imports', async () => {
    const result = await importBrowserProfileCookies({
      source: 'chrome',
      profileId: 'Default',
      // @ts-expect-error intentional invalid confirmation for guard test
      userConfirmed: false,
    });
    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe('not_confirmed');
  });

  it('imports decrypted cookies through applyCookies and cleans up', async () => {
    const password = 'unit-test-password';
    const encrypted = encryptV10(password, 'cookie-value-1');
    const applyCookies = vi.fn(async (cookies) => {
      expect(cookies).toEqual([
        expect.objectContaining({
          name: 'sid',
          value: 'cookie-value-1',
          domain: '.example.com',
        }),
      ]);
      // ensure value is present for managed browser, but never returned by import summary domains path
      return {
        status: 'available' as const,
        cookieCount: 1,
        expiredCookieCount: 0,
        originCount: 0,
        localStorageEntryCount: 0,
        sessionStorageEntryCount: 0,
        cookieDomains: ['example.com'],
        origins: [],
        updatedAtMs: Date.now(),
      };
    });
    const cleanupPaths = vi.fn();
    const copied: string[] = [];

    const result = await importBrowserProfileCookies(
      {
        source: 'chrome',
        profileId: 'Default',
        userConfirmed: true,
        domainAllowlist: ['example.com'],
      },
      {
        platform: 'darwin',
        findProfile: () => ({
          source: 'chrome',
          appName: 'Google Chrome',
          profileId: 'Default',
          profileName: 'Person 1',
          profileDir: '/tmp/fake-profile',
          cookieDbPath: '/tmp/fake-profile/Network/Cookies',
          available: true,
          lastActiveAtMs: Date.now(),
        }),
        getSource: () => ({
          source: 'chrome',
          appName: 'Google Chrome',
          userDataSubpath: 'Google/Chrome',
          keychainService: 'Chrome Safe Storage',
          keychainAccount: 'Chrome',
        }),
        readKeychainPassword: async () => password,
        copyCookieDbSnapshot: (src, dest) => {
          copied.push(src, dest);
        },
        readCookieRows: async () => [
          {
            host_key: '.example.com',
            name: 'sid',
            value: '',
            encrypted_value: encrypted,
            path: '/',
            expires_utc: (Math.floor(Date.now() / 1000) + 3600 + 11644473600) * 1_000_000,
            is_secure: 1,
            is_httponly: 1,
            samesite: 1,
          },
          {
            host_key: '.other.com',
            name: 'skip',
            value: '',
            encrypted_value: encryptV10(password, 'nope'),
            path: '/',
            expires_utc: (Math.floor(Date.now() / 1000) + 3600 + 11644473600) * 1_000_000,
            is_secure: 1,
            is_httponly: 0,
            samesite: 1,
          },
        ],
        applyCookies,
        cleanupPaths,
        mkdtemp: () => '/tmp/neo-cookie-import-test',
      },
    );

    expect(result.ok).toBe(true);
    expect(result.importedCookieCount).toBe(1);
    expect(result.skippedCookieCount).toBe(1);
    expect(result.domains).toContain('example.com');
    expect(JSON.stringify(result)).not.toContain('cookie-value-1');
    expect(applyCookies).toHaveBeenCalledOnce();
    expect(cleanupPaths).toHaveBeenCalled();
    expect(copied[0]).toBe('/tmp/fake-profile/Network/Cookies');
  });

  it('rejects control, whitespace, and separator characters in cookie names', async () => {
    const cookieNames = [
      'normal_name-123',
      'null\x00name',
      'unit\x1fname',
      'delete\x7fname',
      'white space',
      'semi;colon',
      'comma,name',
    ];
    const applyCookies = vi.fn(async () => null);

    const result = await importBrowserProfileCookies(
      {
        source: 'chrome',
        profileId: 'Default',
        userConfirmed: true,
      },
      {
        platform: 'darwin',
        findProfile: () => ({
          source: 'chrome',
          appName: 'Google Chrome',
          profileId: 'Default',
          profileName: 'Person 1',
          profileDir: '/tmp/fake-profile',
          cookieDbPath: '/tmp/fake-profile/Network/Cookies',
          available: true,
        }),
        getSource: () => ({
          source: 'chrome',
          appName: 'Google Chrome',
          userDataSubpath: 'Google/Chrome',
          keychainService: 'Chrome Safe Storage',
          keychainAccount: 'Chrome',
        }),
        readKeychainPassword: async () => 'password',
        copyCookieDbSnapshot: () => undefined,
        readCookieRows: async () => cookieNames.map((name) => ({
          host_key: '.example.com',
          name,
          value: 'cookie-value',
          encrypted_value: null,
          path: '/',
          expires_utc: 0,
          is_secure: 1,
          is_httponly: 1,
          samesite: 1,
        })),
        applyCookies,
        cleanupPaths: () => undefined,
        mkdtemp: () => '/tmp/neo-cookie-import-test-names',
      },
    );

    expect(result.ok).toBe(true);
    expect(result.importedCookieCount).toBe(1);
    expect(result.skippedCookieCount).toBe(6);
    expect(applyCookies).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'normal_name-123' }),
    ]);
  });

  it('fail-closes when a cookie cannot be decrypted', async () => {
    const result = await importBrowserProfileCookies(
      {
        source: 'chrome',
        profileId: 'Default',
        userConfirmed: true,
      },
      {
        platform: 'darwin',
        findProfile: () => ({
          source: 'chrome',
          appName: 'Google Chrome',
          profileId: 'Default',
          profileName: 'Person 1',
          profileDir: '/tmp/fake-profile',
          cookieDbPath: '/tmp/fake-profile/Network/Cookies',
          available: true,
        }),
        getSource: () => ({
          source: 'chrome',
          appName: 'Google Chrome',
          userDataSubpath: 'Google/Chrome',
          keychainService: 'Chrome Safe Storage',
          keychainAccount: 'Chrome',
        }),
        readKeychainPassword: async () => 'password',
        copyCookieDbSnapshot: () => undefined,
        readCookieRows: async () => [
          {
            host_key: '.example.com',
            name: 'sid',
            value: '',
            encrypted_value: Buffer.from('v10not-valid-ciphertext!!'),
            path: '/',
            expires_utc: 0,
            is_secure: 1,
            is_httponly: 1,
            samesite: 1,
          },
        ],
        applyCookies: async () => null,
        cleanupPaths: () => undefined,
        mkdtemp: () => '/tmp/neo-cookie-import-test-fail',
      },
    );

    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe('decrypt_failed');
    expect(result.importedCookieCount).toBe(0);
  });
});
