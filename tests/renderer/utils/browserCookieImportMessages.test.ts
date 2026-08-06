import { describe, expect, it } from 'vitest';
import { humanizeBrowserCookieImportFailure } from '../../../src/renderer/utils/browserCookieImportMessages';

const copy = {
  cookieDbLocked: 'LOCKED',
  keychainDenied: 'KEYCHAIN_DENIED',
  keychainUnavailable: 'KEYCHAIN_UNAVAILABLE',
  profileNotFound: 'PROFILE_NOT_FOUND',
  cookieDbMissing: 'COOKIE_DB_MISSING',
  notConfirmed: 'NOT_CONFIRMED',
  managedBrowserUnavailable: 'MANAGED_UNAVAILABLE',
  unsupportedPlatform: 'UNSUPPORTED',
  decryptFailed: 'DECRYPT_FAILED',
  schemaUnsupported: 'SCHEMA',
  unknown: 'UNKNOWN',
};

describe('humanizeBrowserCookieImportFailure', () => {
  it('maps cookie_db_copy_failed to human lock message (Chrome running)', () => {
    expect(humanizeBrowserCookieImportFailure(
      'cookie_db_copy_failed',
      'Failed to snapshot Cookies DB (is the browser open?): EBUSY',
      copy,
    )).toBe('LOCKED');
  });

  it('maps keychain and missing-profile codes without leaking raw paths', () => {
    expect(humanizeBrowserCookieImportFailure('keychain_denied', 'raw', copy)).toBe('KEYCHAIN_DENIED');
    expect(humanizeBrowserCookieImportFailure('profile_not_found', 'raw', copy)).toBe('PROFILE_NOT_FOUND');
  });

  it('falls back to failureMessage then unknown for unrecognized codes', () => {
    expect(humanizeBrowserCookieImportFailure('unknown', 'something went wrong', copy))
      .toBe('something went wrong');
    expect(humanizeBrowserCookieImportFailure(undefined, null, copy)).toBe('UNKNOWN');
  });
});
