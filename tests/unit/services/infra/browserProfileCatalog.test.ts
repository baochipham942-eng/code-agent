import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
vi.mock('../../../../src/host/services/core/database/nativeLoader', async () => {
  const module = await import('better-sqlite3');
  return { loadBetterSqlite3: () => module.default };
});
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

  it('keeps domain metadata empty when the profile database cannot be read', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-profile-catalog-invalid-db-'));
    tempRoots.push(home);
    const chromeRoot = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    const defaultDir = path.join(chromeRoot, 'Default');
    fs.mkdirSync(path.join(defaultDir, 'Network'), { recursive: true });
    fs.writeFileSync(path.join(defaultDir, 'Network', 'Cookies'), 'not sqlite');
    fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: {} } } }));

    const profile = listBrowserProfiles({ homeDir: home, platform: 'darwin' })
      .find((entry) => entry.source === 'chrome' && entry.profileId === 'Default');
    expect(profile?.available).toBe(true);
    expect(profile?.cookieDomains).toEqual([]);
  });

  it('exposes normalized domain counts without cookie values', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-profile-catalog-domains-'));
    tempRoots.push(home);
    const chromeRoot = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    const defaultDir = path.join(chromeRoot, 'Default');
    fs.mkdirSync(path.join(defaultDir, 'Network'), { recursive: true });
    const db = new Database(path.join(defaultDir, 'Network', 'Cookies'));
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, expires_utc INTEGER DEFAULT 0);');
    db.prepare('INSERT INTO cookies (host_key, name, value) VALUES (?, ?, ?)').run('.Example.com', 'sid', 'secret');
    db.prepare('INSERT INTO cookies (host_key, name, value) VALUES (?, ?, ?)').run('example.com', 'prefs', 'secret');
    db.prepare('INSERT INTO cookies (host_key, name, value) VALUES (?, ?, ?)').run('github.com', 'sid', 'secret');
    db.close();
    fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: {} } } }));

    const profile = listBrowserProfiles({ homeDir: home, platform: 'darwin' })
      .find((entry) => entry.source === 'chrome' && entry.profileId === 'Default');
    expect(profile?.cookieDomains).toEqual([
      { domain: 'example.com', cookieCount: 2 },
      { domain: 'github.com', cookieCount: 1 },
    ]);
  });

  it('omits expired cookies from domain counts, matching the import skip path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-profile-catalog-expired-'));
    tempRoots.push(home);
    const chromeRoot = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    const defaultDir = path.join(chromeRoot, 'Default');
    fs.mkdirSync(path.join(defaultDir, 'Network'), { recursive: true });
    const chromeEpochOffsetSeconds = 11_644_473_600;
    const nowUnix = Math.floor(Date.now() / 1000);
    const expiredUtc = (nowUnix - 3600 + chromeEpochOffsetSeconds) * 1_000_000;
    const liveUtc = (nowUnix + 3600 + chromeEpochOffsetSeconds) * 1_000_000;
    const db = new Database(path.join(defaultDir, 'Network', 'Cookies'));
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, expires_utc INTEGER);');
    db.prepare('INSERT INTO cookies (host_key, name, value, expires_utc) VALUES (?, ?, ?, ?)').run('example.com', 'sid', 'secret', liveUtc);
    db.prepare('INSERT INTO cookies (host_key, name, value, expires_utc) VALUES (?, ?, ?, ?)').run('example.com', 'old', 'secret', expiredUtc);
    db.prepare('INSERT INTO cookies (host_key, name, value, expires_utc) VALUES (?, ?, ?, ?)').run('github.com', 'sid', 'secret', 0);
    db.close();
    fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: {} } } }));

    const profile = listBrowserProfiles({ homeDir: home, platform: 'darwin' })
      .find((entry) => entry.source === 'chrome' && entry.profileId === 'Default');
    expect(profile?.cookieDomains).toEqual([
      { domain: 'example.com', cookieCount: 1 },
      { domain: 'github.com', cookieCount: 1 },
    ]);
  });
});
