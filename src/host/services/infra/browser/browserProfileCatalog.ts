/**
 * ADR-041 — discover local Chromium-family browser profiles for cookie import.
 * Does not read cookie values; only maps source → profile dirs / Cookies DB / Keychain ids.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  BrowserProfileDescriptor,
  BrowserProfileSourceId,
  BrowserProfileUnavailableReason,
} from '../../../../shared/contract/desktop';

export interface BrowserProfileSourceDefinition {
  source: BrowserProfileSourceId;
  appName: string;
  /** Relative to ~/Library/Application Support on macOS. */
  userDataSubpath: string;
  keychainService: string;
  keychainAccount: string;
}

/** Alma-aligned macOS Chromium catalog. */
export const BROWSER_PROFILE_SOURCES: readonly BrowserProfileSourceDefinition[] = [
  {
    source: 'chrome',
    appName: 'Google Chrome',
    userDataSubpath: 'Google/Chrome',
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
  },
  {
    source: 'chrome-beta',
    appName: 'Google Chrome Beta',
    userDataSubpath: 'Google/Chrome Beta',
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
  },
  {
    source: 'chrome-canary',
    appName: 'Google Chrome Canary',
    userDataSubpath: 'Google/Chrome Canary',
    keychainService: 'Chromium Safe Storage',
    keychainAccount: 'Chromium',
  },
  {
    source: 'chromium',
    appName: 'Chromium',
    userDataSubpath: 'Chromium',
    keychainService: 'Chromium Safe Storage',
    keychainAccount: 'Chromium',
  },
  {
    source: 'edge',
    appName: 'Microsoft Edge',
    userDataSubpath: 'Microsoft Edge',
    keychainService: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge',
  },
  {
    source: 'brave',
    appName: 'Brave',
    userDataSubpath: 'BraveSoftware/Brave-Browser',
    keychainService: 'Brave Safe Storage',
    keychainAccount: 'Brave',
  },
  {
    source: 'arc',
    appName: 'Arc',
    userDataSubpath: 'Arc/User Data',
    keychainService: 'Arc Safe Storage',
    keychainAccount: 'Arc',
  },
  {
    source: 'vivaldi',
    appName: 'Vivaldi',
    userDataSubpath: 'Vivaldi',
    keychainService: 'Vivaldi Safe Storage',
    keychainAccount: 'Vivaldi',
  },
] as const;

export function getBrowserProfileSourceDefinition(
  source: BrowserProfileSourceId,
): BrowserProfileSourceDefinition | null {
  return BROWSER_PROFILE_SOURCES.find((entry) => entry.source === source) || null;
}

export function resolveBrowserUserDataRoot(
  definition: BrowserProfileSourceDefinition,
  homeDir = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'darwin') {
    return null;
  }
  return path.join(homeDir, 'Library', 'Application Support', definition.userDataSubpath);
}

export function resolveCookieDbPath(profileDir: string): string | null {
  const networkCookies = path.join(profileDir, 'Network', 'Cookies');
  if (fs.existsSync(networkCookies)) {
    return networkCookies;
  }
  const legacyCookies = path.join(profileDir, 'Cookies');
  if (fs.existsSync(legacyCookies)) {
    return legacyCookies;
  }
  return null;
}

interface LocalStateProfileInfo {
  name?: string;
  user_name?: string;
  gaia_name?: string;
  active_time?: number;
  last_active_time?: number;
}

function readLocalStateProfileCache(userDataRoot: string): Record<string, LocalStateProfileInfo> {
  const localStatePath = path.join(userDataRoot, 'Local State');
  if (!fs.existsSync(localStatePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(localStatePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      profile?: { info_cache?: Record<string, LocalStateProfileInfo> };
    };
    const cache = parsed.profile?.info_cache;
    if (!cache || typeof cache !== 'object') {
      return {};
    }
    return cache;
  } catch {
    return {};
  }
}

function listCandidateProfileIds(userDataRoot: string, infoCache: Record<string, LocalStateProfileInfo>): string[] {
  const fromCache = Object.keys(infoCache);
  let fromDisk: string[];
  try {
    fromDisk = fs
      .readdirSync(userDataRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name === 'Default' || /^Profile \d+$/i.test(name) || name === 'Guest Profile' || name === 'System Profile');
  } catch {
    fromDisk = [];
  }

  const merged = new Set<string>([...fromCache, ...fromDisk]);
  // Prefer Default first, then numeric profiles.
  return Array.from(merged).sort((a, b) => {
    if (a === 'Default') return -1;
    if (b === 'Default') return 1;
    return a.localeCompare(b, 'en');
  });
}

function toUnixMsFromChromeActiveTime(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  // Local State active_time is typically seconds since epoch on modern Chromium.
  if (value > 1e12) {
    return Math.floor(value);
  }
  if (value > 1e9) {
    return Math.floor(value * 1000);
  }
  return Math.floor(value * 1000);
}

function buildUnavailable(
  partial: Omit<BrowserProfileDescriptor, 'available' | 'unavailableReason' | 'unavailableMessage'> & {
    unavailableReason: BrowserProfileUnavailableReason;
    unavailableMessage: string;
  },
): BrowserProfileDescriptor {
  return {
    ...partial,
    available: false,
    cookieDbPath: partial.cookieDbPath ?? null,
    lastActiveAtMs: partial.lastActiveAtMs ?? null,
  };
}

export function listBrowserProfiles(options?: {
  homeDir?: string;
  platform?: NodeJS.Platform;
  sources?: readonly BrowserProfileSourceDefinition[];
}): BrowserProfileDescriptor[] {
  const homeDir = options?.homeDir ?? os.homedir();
  const platform = options?.platform ?? process.platform;
  const sources = options?.sources ?? BROWSER_PROFILE_SOURCES;
  const results: BrowserProfileDescriptor[] = [];

  if (platform !== 'darwin') {
    for (const source of sources) {
      results.push(
        buildUnavailable({
          source: source.source,
          appName: source.appName,
          profileId: 'Default',
          profileName: 'Default',
          profileDir: '',
          unavailableReason: 'unsupported_platform',
          unavailableMessage: 'Profile cookie import is currently macOS-only (ADR-041).',
        }),
      );
    }
    return results;
  }

  for (const source of sources) {
    const userDataRoot = resolveBrowserUserDataRoot(source, homeDir, platform);
    if (!userDataRoot || !fs.existsSync(userDataRoot)) {
      results.push(
        buildUnavailable({
          source: source.source,
          appName: source.appName,
          profileId: 'Default',
          profileName: 'Default',
          profileDir: userDataRoot || '',
          unavailableReason: 'app_not_found',
          unavailableMessage: `${source.appName} user data directory was not found.`,
        }),
      );
      continue;
    }

    const infoCache = readLocalStateProfileCache(userDataRoot);
    const profileIds = listCandidateProfileIds(userDataRoot, infoCache);
    if (profileIds.length === 0) {
      results.push(
        buildUnavailable({
          source: source.source,
          appName: source.appName,
          profileId: 'Default',
          profileName: 'Default',
          profileDir: path.join(userDataRoot, 'Default'),
          unavailableReason: 'profile_dir_missing',
          unavailableMessage: `No profiles found under ${source.appName}.`,
        }),
      );
      continue;
    }

    for (const profileId of profileIds) {
      const profileDir = path.join(userDataRoot, profileId);
      const info = infoCache[profileId] || {};
      const profileName =
        (typeof info.name === 'string' && info.name.trim())
        || (typeof info.gaia_name === 'string' && info.gaia_name.trim())
        || (typeof info.user_name === 'string' && info.user_name.trim())
        || profileId;
      const lastActiveAtMs =
        toUnixMsFromChromeActiveTime(info.active_time)
        ?? toUnixMsFromChromeActiveTime(info.last_active_time);

      if (!fs.existsSync(profileDir)) {
        results.push(
          buildUnavailable({
            source: source.source,
            appName: source.appName,
            profileId,
            profileName,
            profileDir,
            lastActiveAtMs,
            unavailableReason: 'profile_dir_missing',
            unavailableMessage: `Profile directory missing: ${profileId}`,
          }),
        );
        continue;
      }

      const cookieDbPath = resolveCookieDbPath(profileDir);
      if (!cookieDbPath) {
        results.push(
          buildUnavailable({
            source: source.source,
            appName: source.appName,
            profileId,
            profileName,
            profileDir,
            lastActiveAtMs,
            unavailableReason: 'cookie_db_missing',
            unavailableMessage: `Cookies database not found for profile ${profileId}.`,
          }),
        );
        continue;
      }

      results.push({
        source: source.source,
        appName: source.appName,
        profileId,
        profileName,
        profileDir,
        cookieDbPath,
        lastActiveAtMs,
        available: true,
        unavailableReason: null,
        unavailableMessage: null,
      });
    }
  }

  return results.sort((a, b) => {
    if (a.available !== b.available) {
      return a.available ? -1 : 1;
    }
    const aTime = a.lastActiveAtMs || 0;
    const bTime = b.lastActiveAtMs || 0;
    if (aTime !== bTime) {
      return bTime - aTime;
    }
    return `${a.source}:${a.profileId}`.localeCompare(`${b.source}:${b.profileId}`);
  });
}

export function findBrowserProfile(
  source: BrowserProfileSourceId,
  profileId: string,
  options?: {
    homeDir?: string;
    platform?: NodeJS.Platform;
  },
): BrowserProfileDescriptor | null {
  return listBrowserProfiles(options).find(
    (profile) => profile.source === source && profile.profileId === profileId,
  ) || null;
}
