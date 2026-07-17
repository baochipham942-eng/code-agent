/**
 * ADR-041 — decrypt Chromium Cookies.db values using macOS Keychain Safe Storage.
 * Key material must stay in-process for the import operation only.
 */
import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PBKDF2_SALT = 'saltysalt';
const PBKDF2_ITERATIONS = 1003;
const PBKDF2_KEYLEN = 16;
const AES_IV = Buffer.alloc(16, ' ');

export type ChromiumCookieVersion = 'v10' | 'v11' | 'plaintext' | 'unknown';

export interface DecryptedCookiePayload {
  value: string;
  version: ChromiumCookieVersion;
}

export class BrowserCookieCryptoError extends Error {
  readonly code: 'keychain_denied' | 'keychain_unavailable' | 'decrypt_failed' | 'schema_unsupported';

  constructor(
    code: BrowserCookieCryptoError['code'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BrowserCookieCryptoError';
    this.code = code;
  }
}

export function deriveChromiumSafeStorageKey(password: string): Buffer {
  return pbkdf2Sync(password, PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, 'sha1');
}

export async function readMacOsKeychainPassword(args: {
  keychainService: string;
  keychainAccount: string;
  execFileImpl?: typeof execFileAsync;
  timeoutMs?: number;
}): Promise<string> {
  const run = args.execFileImpl || execFileAsync;
  try {
    const { stdout } = await run(
      'security',
      [
        'find-generic-password',
        '-w',
        '-s',
        args.keychainService,
        '-a',
        args.keychainAccount,
      ],
      {
        timeout: args.timeoutMs ?? 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const password = String(stdout || '').trim();
    if (!password) {
      throw new BrowserCookieCryptoError(
        'keychain_unavailable',
        `Keychain returned an empty password for "${args.keychainService}".`,
      );
    }
    return password;
  } catch (error) {
    if (error instanceof BrowserCookieCryptoError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const denied = /user interaction is not allowed|could not be found|Unable to find|errSecAuthFailed|denied/i.test(message);
    throw new BrowserCookieCryptoError(
      denied ? 'keychain_denied' : 'keychain_unavailable',
      denied
        ? `Could not read "${args.keychainService}" from the login Keychain. Grant access when macOS prompts, or run the browser once so Safe Storage exists.`
        : `Failed to read Keychain item "${args.keychainService}": ${message}`,
      { cause: error },
    );
  }
}

function stripPkcs7Padding(buffer: Buffer): Buffer {
  if (buffer.length === 0) {
    return buffer;
  }
  const pad = buffer[buffer.length - 1];
  if (pad <= 0 || pad > 16 || pad > buffer.length) {
    return buffer;
  }
  for (let i = 0; i < pad; i += 1) {
    if (buffer[buffer.length - 1 - i] !== pad) {
      return buffer;
    }
  }
  return buffer.subarray(0, buffer.length - pad);
}

export function decryptChromiumCookieValue(args: {
  encryptedValue: Buffer | Uint8Array | null | undefined;
  plainValue?: string | null;
  key: Buffer;
}): DecryptedCookiePayload {
  const plain = typeof args.plainValue === 'string' ? args.plainValue : '';
  const encrypted = args.encryptedValue
    ? Buffer.isBuffer(args.encryptedValue)
      ? args.encryptedValue
      : Buffer.from(args.encryptedValue)
    : Buffer.alloc(0);

  if (encrypted.length === 0) {
    return { value: plain, version: 'plaintext' };
  }

  const prefix = encrypted.subarray(0, 3).toString('utf8');
  if (prefix !== 'v10' && prefix !== 'v11') {
    // Some builds store empty/unencrypted blobs; fall back to plain column when present.
    if (plain) {
      return { value: plain, version: 'plaintext' };
    }
    throw new BrowserCookieCryptoError(
      'schema_unsupported',
      `Unsupported Chromium cookie encryption prefix "${prefix || 'none'}".`,
    );
  }

  const ciphertext = encrypted.subarray(3);
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new BrowserCookieCryptoError(
      'decrypt_failed',
      'Encrypted cookie ciphertext has an invalid length.',
    );
  }

  try {
    // Chromium macOS Safe Storage historically uses AES-128-CBC with a 16-space IV
    // and PKCS#7 padding (prefix v10/v11).
    const decipher = createDecipheriv('aes-128-cbc', args.key, AES_IV);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return {
      value: chromiumDecryptedBytesToCookieValue(decrypted),
      version: prefix as 'v10' | 'v11',
    };
  } catch (error) {
    // Fallback for non-standard padding edge cases found in older fixtures.
    try {
      const decipher = createDecipheriv('aes-128-cbc', args.key, AES_IV);
      decipher.setAutoPadding(false);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const unpadded = stripPkcs7Padding(decrypted);
      return {
        value: chromiumDecryptedBytesToCookieValue(unpadded),
        version: prefix as 'v10' | 'v11',
      };
    } catch (fallbackError) {
      throw new BrowserCookieCryptoError(
        'decrypt_failed',
        'Failed to decrypt Chromium cookie value.',
        { cause: fallbackError ?? error },
      );
    }
  }
}

/**
 * Chrome 80+ prefixes decrypted cookie bytes with a 32-byte SHA-256 digest.
 * Older fixtures (and our unit encrypt helper) omit that prefix. Prefer the
 * stripped payload when it is the cleaner UTF-8 cookie value.
 */
export function chromiumDecryptedBytesToCookieValue(decrypted: Buffer): string {
  if (decrypted.length <= 32) {
    return decrypted.toString('utf8');
  }
  const full = decrypted.toString('utf8');
  const strippedBuf = decrypted.subarray(32);
  const stripped = strippedBuf.toString('utf8');
  // Chrome 80+: 32-byte digest prefix. Prefer stripped when full is unsafe/binary but remainder is clean.
  if (isPlaywrightSafeCookieValue(stripped) && !isPlaywrightSafeCookieValue(full)) {
    return stripped;
  }
  const fullReplacements = (full.match(/\uFFFD/g) || []).length;
  if (fullReplacements > 0 && isPlaywrightSafeCookieValue(stripped)) {
    return stripped;
  }
  // Prefer stripped when prefix is high-entropy binary and remainder is usable cookie text.
  const prefix = decrypted.subarray(0, 32);
  let prefixHigh = 0;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] >= 0x80 || prefix[i] < 0x20) {
      prefixHigh += 1;
    }
  }
  if (prefixHigh >= 8 && isPlaywrightSafeCookieValue(stripped)) {
    return stripped;
  }
  return full;
}

/** Playwright/CDP rejects binary or malformed cookie fields. */
export function isPlaywrightSafeCookieValue(value: string): boolean {
  if (!value || value.includes('\u0000')) {
    return false;
  }
  // Reject values dominated by C0 controls (failed decrypt without hash strip).
  let controls = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x09 || (code > 0x0d && code < 0x20) || code === 0x7f) {
      controls += 1;
    }
  }
  return controls === 0;
}

/** Chrome/WebKit expires_utc is microseconds since 1601-01-01 UTC. Playwright wants seconds since Unix epoch, or -1. */
export function chromeExpiresUtcToUnixSeconds(expiresUtc: number | null | undefined): number {
  if (typeof expiresUtc !== 'number' || !Number.isFinite(expiresUtc) || expiresUtc <= 0) {
    return -1;
  }
  const WINDOWS_TO_UNIX_SECONDS = 11644473600;
  const unixSeconds = Math.floor(expiresUtc / 1_000_000) - WINDOWS_TO_UNIX_SECONDS;
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return -1;
  }
  return unixSeconds;
}

export function mapChromiumSameSite(value: number | null | undefined): 'Strict' | 'Lax' | 'None' {
  switch (value) {
    case 1:
      return 'Lax';
    case 2:
      return 'Strict';
    case 0:
    case -1:
    case 3:
    default:
      return 'None';
  }
}

export function domainMatchesAllowlist(domain: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) {
    return true;
  }
  const normalizedDomain = domain.replace(/^\./, '').toLowerCase();
  return allowlist.some((entry) => {
    const needle = entry.replace(/^\./, '').toLowerCase().trim();
    if (!needle) return false;
    return normalizedDomain === needle || normalizedDomain.endsWith(`.${needle}`);
  });
}
