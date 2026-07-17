import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_PROFILE_SOURCES,
  listBrowserProfiles,
  resolveCookieDbPath,
} from '../../../../src/host/services/infra/browser/browserProfileCatalog';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('browserProfileCatalog (ADR-041)', () => {
  it('exports Alma-aligned source ids', () => {
    const sources = BROWSER_PROFILE_SOURCES.map((entry) => entry.source);
    expect(sources).toEqual([
      'chrome',
      'chrome-beta',
      'chrome-canary',
      'chromium',
      'edge',
      'brave',
      'arc',
      'vivaldi',
    ]);
  });

  it('marks unsupported platforms without throwing', () => {
    const profiles = listBrowserProfiles({ platform: 'linux', homeDir: '/tmp' });
    expect(profiles.length).toBe(BROWSER_PROFILE_SOURCES.length);
    expect(profiles.every((profile) => profile.available === false)).toBe(true);
    expect(profiles[0]?.unavailableReason).toBe('unsupported_platform');
  });

  it('discovers Default profile with Network/Cookies', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-profile-catalog-'));
    tempRoots.push(home);
    const chromeRoot = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    const defaultDir = path.join(chromeRoot, 'Default');
    fs.mkdirSync(path.join(defaultDir, 'Network'), { recursive: true });
    fs.writeFileSync(path.join(defaultDir, 'Network', 'Cookies'), 'fake-db');
    fs.writeFileSync(
      path.join(chromeRoot, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: 'Person 1', active_time: 1_700_000_000 },
          },
        },
      }),
    );

    const profiles = listBrowserProfiles({ homeDir: home, platform: 'darwin' });
    const chromeDefault = profiles.find(
      (profile) => profile.source === 'chrome' && profile.profileId === 'Default',
    );
    expect(chromeDefault?.available).toBe(true);
    expect(chromeDefault?.profileName).toBe('Person 1');
    expect(chromeDefault?.cookieDbPath).toBe(path.join(defaultDir, 'Network', 'Cookies'));
    expect(resolveCookieDbPath(defaultDir)).toBe(path.join(defaultDir, 'Network', 'Cookies'));
  });
});
