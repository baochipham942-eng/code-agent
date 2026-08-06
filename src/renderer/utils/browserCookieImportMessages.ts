/**
 * Human-readable Cookie import failure messages (P1 auth-state).
 * Pure mapping — UI and tests share this so lock/Keychain cases stay plain language.
 */
import type { BrowserCookieImportFailureCode } from '../../shared/contract/desktop';

export interface BrowserCookieImportMessageCopy {
  cookieDbLocked: string;
  keychainDenied: string;
  keychainUnavailable: string;
  profileNotFound: string;
  cookieDbMissing: string;
  notConfirmed: string;
  managedBrowserUnavailable: string;
  unsupportedPlatform: string;
  decryptFailed: string;
  schemaUnsupported: string;
  unknown: string;
}

export function humanizeBrowserCookieImportFailure(
  code: BrowserCookieImportFailureCode | null | undefined,
  failureMessage: string | null | undefined,
  copy: BrowserCookieImportMessageCopy,
): string {
  switch (code) {
    case 'cookie_db_copy_failed':
      return copy.cookieDbLocked;
    case 'keychain_denied':
      return copy.keychainDenied;
    case 'keychain_unavailable':
      return copy.keychainUnavailable;
    case 'profile_not_found':
      return copy.profileNotFound;
    case 'cookie_db_missing':
      return copy.cookieDbMissing;
    case 'not_confirmed':
      return copy.notConfirmed;
    case 'managed_browser_unavailable':
      return copy.managedBrowserUnavailable;
    case 'unsupported_platform':
      return copy.unsupportedPlatform;
    case 'decrypt_failed':
      return copy.decryptFailed;
    case 'schema_unsupported':
      return copy.schemaUnsupported;
    case 'unknown':
    default:
      return failureMessage?.trim() || copy.unknown;
  }
}
