/**
 * ADR-041 — orchestrate profile cookie import into Managed browser context.
 * Never logs cookie values or key material.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  BrowserCookieImportFailureCode,
  BrowserCookieImportRequest,
  BrowserCookieImportResult,
  BrowserProfileSourceId,
  ManagedBrowserAccountStateSummary,
} from '../../../../shared/contract/desktop';
import {
  BrowserCookieCryptoError,
  chromeExpiresUtcToUnixSeconds,
  decryptChromiumCookieValue,
  deriveChromiumSafeStorageKey,
  domainMatchesAllowlist,
  isPlaywrightSafeCookieValue,
  mapChromiumSameSite,
  readMacOsKeychainPassword,
} from './browserCookieCrypto';

function isPlaywrightSafeCookieName(name: string): boolean {
  // RFC 6265 cookie-name token; reject empty / control / separators.
  // eslint-disable-next-line no-control-regex -- Cookie-name validation intentionally matches control characters.
  return name.length > 0 && !/[\x00-\x1f\x7f\s;,]/.test(name);
}
import {
  findBrowserProfile,
  getBrowserProfileSourceDefinition,
  listBrowserProfiles,
  type BrowserProfileSourceDefinition,
} from './browserProfileCatalog';

export interface PlaywrightCookieSeed {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface ChromiumCookieRow {
  host_key: string;
  name: string;
  value: string | null;
  encrypted_value: Buffer | Uint8Array | null;
  path: string | null;
  expires_utc: number | null;
  is_secure: number | boolean | null;
  is_httponly: number | boolean | null;
  samesite: number | null;
}

export interface BrowserProfileImportDependencies {
  platform?: NodeJS.Platform;
  homeDir?: string;
  nowMs?: () => number;
  listProfiles?: typeof listBrowserProfiles;
  findProfile?: typeof findBrowserProfile;
  getSource?: typeof getBrowserProfileSourceDefinition;
  readKeychainPassword?: typeof readMacOsKeychainPassword;
  readCookieRows?: (cookieDbPath: string) => Promise<ChromiumCookieRow[]>;
  copyCookieDbSnapshot?: (cookieDbPath: string, tempDbPath: string) => void;
  cleanupPaths?: (paths: string[]) => void;
  mkdtemp?: (prefix: string) => string;
  applyCookies?: (cookies: PlaywrightCookieSeed[]) => Promise<ManagedBrowserAccountStateSummary | null | undefined>;
}

function failureResult(args: {
  source: BrowserProfileSourceId;
  profileId: string;
  profileName?: string | null;
  code: BrowserCookieImportFailureCode;
  message: string;
  startedAt: number;
  warnings?: string[];
}): BrowserCookieImportResult {
  return {
    ok: false,
    source: args.source,
    profileId: args.profileId,
    profileName: args.profileName ?? null,
    importedCookieCount: 0,
    skippedCookieCount: 0,
    expiredSkippedCount: 0,
    domainCount: 0,
    domains: [],
    accountState: null,
    failureCode: args.code,
    failureMessage: args.message,
    warnings: args.warnings || [],
    durationMs: Math.max(0, Date.now() - args.startedAt),
    importSource: {
      kind: 'browser-profile-cookies',
      source: args.source,
      profileId: args.profileId,
    },
  };
}

function defaultCopyCookieDbSnapshot(cookieDbPath: string, tempDbPath: string): void {
  fs.copyFileSync(cookieDbPath, tempDbPath);
  for (const suffix of ['-wal', '-shm'] as const) {
    const side = `${cookieDbPath}${suffix}`;
    if (fs.existsSync(side)) {
      try {
        fs.copyFileSync(side, `${tempDbPath}${suffix}`);
      } catch {
        // Best-effort: main DB copy is still usable when side files cannot be copied.
      }
    }
  }
  try {
    fs.chmodSync(tempDbPath, 0o600);
  } catch {
    // ignore platforms/filesystems that reject chmod
  }
}

function defaultCleanup(paths: string[]): void {
  for (const target of paths) {
    try {
      if (target && fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
      }
    } catch {
      // ignore cleanup failures
    }
  }
}

async function defaultReadCookieRows(cookieDbPath: string): Promise<ChromiumCookieRow[]> {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(cookieDbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite
         FROM cookies`,
      )
      .all() as ChromiumCookieRow[];
    return rows;
  } finally {
    db.close();
  }
}

function uniqueDomains(domains: string[], limit = 24): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const domain of domains) {
    const normalized = domain.replace(/^\./, '').toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

export async function importBrowserProfileCookies(
  request: BrowserCookieImportRequest,
  deps: BrowserProfileImportDependencies = {},
): Promise<BrowserCookieImportResult> {
  const startedAt = deps.nowMs?.() ?? Date.now();
  const platform = deps.platform ?? process.platform;
  const listProfiles = deps.listProfiles ?? listBrowserProfiles;
  const findProfile = deps.findProfile ?? findBrowserProfile;
  const getSource = deps.getSource ?? getBrowserProfileSourceDefinition;
  const readKeychainPassword = deps.readKeychainPassword ?? readMacOsKeychainPassword;
  const readCookieRows = deps.readCookieRows ?? defaultReadCookieRows;
  const copyCookieDbSnapshot = deps.copyCookieDbSnapshot ?? defaultCopyCookieDbSnapshot;
  const cleanupPaths = deps.cleanupPaths ?? defaultCleanup;
  const mkdtemp = deps.mkdtemp ?? ((prefix: string) => fs.mkdtempSync(prefix));

  if (request.userConfirmed !== true) {
    return failureResult({
      source: request.source,
      profileId: request.profileId,
      code: 'not_confirmed',
      message: 'Profile cookie import requires explicit user confirmation (ADR-041).',
      startedAt,
    });
  }

  if (platform !== 'darwin') {
    return failureResult({
      source: request.source,
      profileId: request.profileId,
      code: 'unsupported_platform',
      message: 'Profile cookie import is currently macOS-only (ADR-041).',
      startedAt,
    });
  }

  const sourceDef: BrowserProfileSourceDefinition | null = getSource(request.source);
  if (!sourceDef) {
    return failureResult({
      source: request.source,
      profileId: request.profileId,
      code: 'profile_not_found',
      message: `Unsupported browser source: ${request.source}`,
      startedAt,
    });
  }

  const profile = findProfile(request.source, request.profileId, {
    homeDir: deps.homeDir,
    platform,
  }) || listProfiles({ homeDir: deps.homeDir, platform }).find(
    (entry) => entry.source === request.source && entry.profileId === request.profileId,
  );

  if (!profile) {
    return failureResult({
      source: request.source,
      profileId: request.profileId,
      code: 'profile_not_found',
      message: `Browser profile not found: ${request.source}/${request.profileId}`,
      startedAt,
    });
  }

  if (!profile.available || !profile.cookieDbPath) {
    return failureResult({
      source: request.source,
      profileId: request.profileId,
      profileName: profile.profileName,
      code: profile.unavailableReason === 'cookie_db_missing' ? 'cookie_db_missing' : 'profile_not_found',
      message: profile.unavailableMessage || 'Browser profile is not available for cookie import.',
      startedAt,
    });
  }

  if (typeof deps.applyCookies !== 'function') {
    return failureResult({
      source: request.source,
      profileId: request.profileId,
      profileName: profile.profileName,
      code: 'managed_browser_unavailable',
      message: 'Managed browser applyCookies hook is not available.',
      startedAt,
    });
  }

  const tempDir = mkdtemp(path.join(os.tmpdir(), 'neo-cookie-import-'));
  const tempDbPath = path.join(tempDir, 'Cookies');
  const cleanupTargets = [
    tempDbPath,
    `${tempDbPath}-wal`,
    `${tempDbPath}-shm`,
    tempDir,
  ];

  try {
    try {
      copyCookieDbSnapshot(profile.cookieDbPath, tempDbPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failureResult({
        source: request.source,
        profileId: request.profileId,
        profileName: profile.profileName,
        code: 'cookie_db_copy_failed',
        message: `Failed to snapshot Cookies DB (is the browser open?): ${message}`,
        startedAt,
      });
    }

    let key: Buffer;
    try {
      const password = await readKeychainPassword({
        keychainService: sourceDef.keychainService,
        keychainAccount: sourceDef.keychainAccount,
      });
      key = deriveChromiumSafeStorageKey(password);
    } catch (error) {
      if (error instanceof BrowserCookieCryptoError) {
        return failureResult({
          source: request.source,
          profileId: request.profileId,
          profileName: profile.profileName,
          code: error.code === 'keychain_denied' ? 'keychain_denied' : 'keychain_unavailable',
          message: error.message,
          startedAt,
        });
      }
      return failureResult({
        source: request.source,
        profileId: request.profileId,
        profileName: profile.profileName,
        code: 'keychain_unavailable',
        message: error instanceof Error ? error.message : String(error),
        startedAt,
      });
    }

    let rows: ChromiumCookieRow[];
    try {
      rows = await readCookieRows(tempDbPath);
    } catch (error) {
      return failureResult({
        source: request.source,
        profileId: request.profileId,
        profileName: profile.profileName,
        code: 'schema_unsupported',
        message: error instanceof Error ? error.message : String(error),
        startedAt,
      });
    }

    const includeExpired = request.includeExpired === true;
    const nowUnix = Math.floor((deps.nowMs?.() ?? Date.now()) / 1000);
    const seeds: PlaywrightCookieSeed[] = [];
    let skippedCookieCount = 0;
    let expiredSkippedCount = 0;
    const importedDomains: string[] = [];

    for (const row of rows) {
      const domain = typeof row.host_key === 'string' ? row.host_key : '';
      const name = typeof row.name === 'string' ? row.name : '';
      if (!domain || !name) {
        skippedCookieCount += 1;
        continue;
      }
      if (!domainMatchesAllowlist(domain, request.domainAllowlist)) {
        skippedCookieCount += 1;
        continue;
      }

      const expires = chromeExpiresUtcToUnixSeconds(row.expires_utc ?? undefined);
      if (!includeExpired && expires > 0 && expires <= nowUnix) {
        expiredSkippedCount += 1;
        skippedCookieCount += 1;
        continue;
      }

      let value: string;
      try {
        const decrypted = decryptChromiumCookieValue({
          encryptedValue: row.encrypted_value,
          plainValue: row.value,
          key,
        });
        value = decrypted.value;
      } catch (error) {
        // ADR-041 Decision 4: fail-closed on decrypt/schema errors; do not write partial secrets.
        const code: BrowserCookieImportFailureCode =
          error instanceof BrowserCookieCryptoError && error.code === 'schema_unsupported'
            ? 'schema_unsupported'
            : 'decrypt_failed';
        return failureResult({
          source: request.source,
          profileId: request.profileId,
          profileName: profile.profileName,
          code,
          message:
            error instanceof Error
              ? error.message
              : 'Failed to decrypt one or more cookies. Try Chrome Relay instead.',
          startedAt,
        });
      }

      if (!value) {
        skippedCookieCount += 1;
        continue;
      }
      // CDP/Playwright reject binary garbage (failed decrypt / unstripped hash prefix).
      // Import kernel already strips Chrome 80+ 32-byte digests; still skip unsafe values.
      if (!isPlaywrightSafeCookieValue(value) || !isPlaywrightSafeCookieName(name)) {
        skippedCookieCount += 1;
        continue;
      }

      const secure = row.is_secure === true || row.is_secure === 1;
      let sameSite = mapChromiumSameSite(
        typeof row.samesite === 'number' ? row.samesite : null,
      );
      // CDP: SameSite=None requires Secure.
      if (sameSite === 'None' && !secure) {
        sameSite = 'Lax';
      }

      seeds.push({
        name,
        value,
        domain,
        path: typeof row.path === 'string' && row.path ? row.path : '/',
        expires,
        httpOnly: row.is_httponly === true || row.is_httponly === 1,
        secure,
        sameSite,
      });
      importedDomains.push(domain);
    }

    // Zero out key material reference as soon as decryption loop ends.
    key.fill(0);

    let accountState: ManagedBrowserAccountStateSummary | null = null;
    if (seeds.length > 0) {
      accountState = (await deps.applyCookies(seeds)) || null;
    }

    const domains = uniqueDomains(importedDomains);
    return {
      ok: true,
      source: request.source,
      profileId: request.profileId,
      profileName: profile.profileName,
      importedCookieCount: seeds.length,
      skippedCookieCount,
      expiredSkippedCount,
      domainCount: domains.length,
      domains,
      selectedDomainCount: request.domainAllowlist?.length ?? null,
      accountState,
      failureCode: null,
      failureMessage: null,
      warnings:
        seeds.length === 0
          ? ['No cookies were imported. The profile may be empty or fully filtered by domain allowlist.']
          : [],
      durationMs: Math.max(0, (deps.nowMs?.() ?? Date.now()) - startedAt),
      importSource: {
        kind: 'browser-profile-cookies',
        source: request.source,
        profileId: request.profileId,
      },
    };
  } finally {
    cleanupPaths(cleanupTargets);
  }
}
