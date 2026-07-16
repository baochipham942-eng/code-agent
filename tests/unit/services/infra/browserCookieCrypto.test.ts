import { createCipheriv, pbkdf2Sync } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  chromeExpiresUtcToUnixSeconds,
  decryptChromiumCookieValue,
  deriveChromiumSafeStorageKey,
  domainMatchesAllowlist,
  mapChromiumSameSite,
} from '../../../../src/host/services/infra/browser/browserCookieCrypto';

function encryptV10(password: string, plaintext: string): Buffer {
  const key = deriveChromiumSafeStorageKey(password);
  const iv = Buffer.alloc(16, ' ');
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), encrypted]);
}

describe('browserCookieCrypto (ADR-041)', () => {
  it('derives the Chromium Safe Storage key with saltysalt/1003/sha1', () => {
    const key = deriveChromiumSafeStorageKey('test-password');
    const expected = pbkdf2Sync('test-password', 'saltysalt', 1003, 16, 'sha1');
    expect(key.equals(expected)).toBe(true);
  });

  it('decrypts v10 cookie ciphertext', () => {
    const password = 'test-password';
    const encrypted = encryptV10(password, 'session-secret-value');
    const key = deriveChromiumSafeStorageKey(password);
    const result = decryptChromiumCookieValue({
      encryptedValue: encrypted,
      key,
    });
    expect(result.version).toBe('v10');
    expect(result.value).toBe('session-secret-value');
  });

  it('returns plaintext when encrypted_value is empty', () => {
    const key = deriveChromiumSafeStorageKey('x');
    const result = decryptChromiumCookieValue({
      encryptedValue: Buffer.alloc(0),
      plainValue: 'already-plain',
      key,
    });
    expect(result.version).toBe('plaintext');
    expect(result.value).toBe('already-plain');
  });

  it('maps Chrome expires_utc microseconds to unix seconds', () => {
    // 2020-01-01T00:00:00Z
    const unix = 1577836800;
    const chromeUtc = (unix + 11644473600) * 1_000_000;
    expect(chromeExpiresUtcToUnixSeconds(chromeUtc)).toBe(unix);
    expect(chromeExpiresUtcToUnixSeconds(0)).toBe(-1);
    expect(chromeExpiresUtcToUnixSeconds(null)).toBe(-1);
  });

  it('maps sameSite integers and domain allowlist', () => {
    expect(mapChromiumSameSite(1)).toBe('Lax');
    expect(mapChromiumSameSite(2)).toBe('Strict');
    expect(mapChromiumSameSite(0)).toBe('None');
    expect(domainMatchesAllowlist('.github.com', ['github.com'])).toBe(true);
    expect(domainMatchesAllowlist('api.github.com', ['github.com'])).toBe(true);
    expect(domainMatchesAllowlist('evil.com', ['github.com'])).toBe(false);
    expect(domainMatchesAllowlist('github.com', undefined)).toBe(true);
  });
});
