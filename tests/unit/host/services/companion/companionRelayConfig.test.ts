import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startCompanionRelayIfConfigured } from '../../../../../src/host/services/companion/CompanionRelayClient';
import {
  loadCompanionRelayConfig,
  loadCompanionRelayCredential,
  type CompanionRelayKeytarLoader,
  type CompanionRelayLogger,
} from '../../../../../src/host/services/companion/companionRelayConfig';
import { COMPANION_LIMITS as L } from '../../../../../src/shared/constants/companion';
import type { CompanionGateway } from '../../../../../src/host/services/companion/CompanionGateway';

const gateway = {} as CompanionGateway;
const FIXTURE_CA = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/companion-relay-tls/ca.pem');
const SECRET = 'CREDENTIAL_VALUE_MUST_NOT_APPEAR';
const SHORT_SECRET = 'TOOSHORT';
const ENABLED = {
  v: 1 as const,
  enabled: true,
  url: 'wss://relay.example.invalid/companion',
  credentialRef: 'companion-relay',
};

function collectLogger(): { logger: CompanionRelayLogger; warn: string[]; info: string[]; all(): string[] } {
  const warn: string[] = [];
  const info: string[] = [];
  return {
    warn,
    info,
    all: () => [...info, ...warn],
    logger: {
      warn: (message: string) => { warn.push(message); },
      info: (message: string) => { info.push(message); },
    },
  };
}

function keytarOf(value: string | null | Error): CompanionRelayKeytarLoader {
  return () => ({
    getPassword: async () => {
      if (value instanceof Error) throw value;
      return value;
    },
  });
}

async function writeConfig(dir: string, body: unknown): Promise<void> {
  await writeFile(join(dir, L.relayConfigFile), typeof body === 'string' ? body : JSON.stringify(body));
}

function expectNoSecrets(logs: string[]): void {
  const blob = logs.join('\n');
  expect(blob).not.toContain(SECRET);
  expect(blob).not.toContain(SHORT_SECRET);
  expect(blob).not.toContain('Bearer ');
  expect(blob).not.toMatch(/authorization/i);
}

describe('companion relay config', () => {
  it('is inert when the config file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const logs = collectLogger();
    expect(loadCompanionRelayConfig(dir, logs.logger)).toBeNull();
    expect(logs.info).toEqual([`Companion relay config file missing: ${resolve(dir, L.relayConfigFile)}`]);
    expect(logs.warn).toEqual([]);
    const startLogs = collectLogger();
    await expect(startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => { throw new Error('should not load identity'); },
      logger: startLogs.logger,
    })).resolves.toBeNull();
    expect(startLogs.info).toEqual([`Companion relay config file missing: ${resolve(dir, L.relayConfigFile)}`]);
    expect(startLogs.warn).toEqual([]);
  });

  it('is inert when enabled is false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const logs = collectLogger();
    await writeConfig(dir, {
      v: 1, enabled: false, url: 'wss://relay.example.invalid/companion', credentialRef: 'companion-relay',
    });
    expect(loadCompanionRelayConfig(dir, logs.logger)).toBeNull();
    expect(logs.info).toEqual(['Companion relay config enabled is not true']);
    expect(logs.warn).toEqual([]);
    await expect(startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => { throw new Error('should not load identity'); },
      logger: logs.logger,
    })).resolves.toBeNull();
  });

  it('is inert when enabled but the credential cannot be resolved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const logs = collectLogger();
    await writeConfig(dir, ENABLED);
    expect(loadCompanionRelayConfig(dir, logs.logger)).toMatchObject({ credentialRef: 'companion-relay' });
    await expect(startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => { throw new Error('should not load identity'); },
      logger: logs.logger,
    })).resolves.toBeNull();
    expect(logs.warn).toContain('Companion relay keytar unavailable');
  });

  it('treats malformed config as disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const logs = collectLogger();
    await writeConfig(dir, '{not json');
    expect(loadCompanionRelayConfig(dir, logs.logger)).toBeNull();
    expect(logs.warn).toEqual([`Companion relay config JSON parse failed: ${resolve(dir, L.relayConfigFile)}`]);
  });

  it('logs schema issue paths without values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const logs = collectLogger();
    await writeConfig(dir, { ...ENABLED, secret: SECRET });
    expect(loadCompanionRelayConfig(dir, logs.logger)).toBeNull();
    expect(logs.warn).toEqual(['Companion relay config schema invalid: secret']);
    expectNoSecrets(logs.all());
  });

  it('logs missing url and credentialRef separately', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const urlLogs = collectLogger();
    await writeConfig(dir, { v: 1, enabled: true, credentialRef: 'companion-relay' });
    expect(loadCompanionRelayConfig(dir, urlLogs.logger)).toBeNull();
    expect(urlLogs.warn).toEqual(['Companion relay config missing url']);

    const dir2 = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const refLogs = collectLogger();
    await writeConfig(dir2, { v: 1, enabled: true, url: 'wss://relay.example.invalid/companion' });
    expect(loadCompanionRelayConfig(dir2, refLogs.logger)).toBeNull();
    expect(refLogs.warn).toEqual(['Companion relay config missing credentialRef']);
  });

  it('logs invalid and insecure relay urls by error code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const invalid = collectLogger();
    await writeConfig(dir, { ...ENABLED, url: 'wss://user:pass@relay.example.invalid/companion' });
    expect(loadCompanionRelayConfig(dir, invalid.logger)).toBeNull();
    expect(invalid.warn).toEqual(['Companion relay config url invalid: COMPANION_RELAY_INVALID_URL']);
    expect(invalid.warn.join('\n')).not.toContain('pass');

    const dir2 = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const insecure = collectLogger();
    await writeConfig(dir2, { ...ENABLED, url: 'ws://relay.example.invalid/companion' });
    expect(loadCompanionRelayConfig(dir2, insecure.logger)).toBeNull();
    expect(insecure.warn).toEqual(['Companion relay config url invalid: COMPANION_RELAY_INSECURE_URL']);
  });

  it('reads caFile relative to the data directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const logs = collectLogger();
    await copyFile(FIXTURE_CA, join(dir, 'ca.pem'));
    await writeConfig(dir, { ...ENABLED, caFile: 'ca.pem' });
    const config = loadCompanionRelayConfig(dir, logs.logger);
    expect(config?.caPem).toBe(await readFile(join(dir, 'ca.pem'), 'utf8'));
    expect(logs.warn).toEqual([]);
  });

  it('reads an absolute caFile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const logs = collectLogger();
    const caPath = join(dir, 'absolute-ca.pem');
    await writeFile(caPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    await writeConfig(dir, { ...ENABLED, caFile: caPath });
    expect(loadCompanionRelayConfig(dir, logs.logger)?.caPem).toContain('BEGIN CERTIFICATE');
    expect(logs.warn).toEqual([]);
  });

  it('fail-closes when caFile is missing or not a certificate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const missing = collectLogger();
    await writeConfig(dir, { ...ENABLED, caFile: 'missing.pem' });
    expect(loadCompanionRelayConfig(dir, missing.logger)).toBeNull();
    expect(missing.warn).toEqual([`Companion relay caFile unreadable: ${resolve(dir, 'missing.pem')}`]);

    const dir2 = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const invalid = collectLogger();
    await writeFile(join(dir2, 'ca.pem'), 'not-a-certificate');
    await writeConfig(dir2, { ...ENABLED, caFile: 'ca.pem' });
    expect(loadCompanionRelayConfig(dir2, invalid.logger)).toBeNull();
    expect(invalid.warn).toEqual([`Companion relay caFile invalid: ${resolve(dir2, 'ca.pem')}`]);
  });

  it('logs keytar unavailable, missing, too-short, and thrown errors', async () => {
    const unavailable = collectLogger();
    expect(await loadCompanionRelayCredential('companion-relay', {
      logger: unavailable.logger,
      loadKeytar: () => null,
    })).toBeNull();
    expect(unavailable.warn).toEqual(['Companion relay keytar unavailable']);

    const missing = collectLogger();
    expect(await loadCompanionRelayCredential('companion-relay', {
      logger: missing.logger,
      loadKeytar: keytarOf(null),
    })).toBeNull();
    expect(missing.warn).toEqual(['Companion relay credential missing from keychain']);

    const tooShort = collectLogger();
    expect(await loadCompanionRelayCredential('companion-relay', {
      logger: tooShort.logger,
      loadKeytar: keytarOf(SHORT_SECRET),
    })).toBeNull();
    expect(tooShort.warn).toEqual([`Companion relay credential too short: length=${SHORT_SECRET.length}`]);

    const thrown = collectLogger();
    expect(await loadCompanionRelayCredential('companion-relay', {
      logger: thrown.logger,
      loadKeytar: keytarOf(new Error(`keytar exploded\n${SECRET}`)),
    })).toBeNull();
    expect(thrown.warn).toEqual(['Companion relay keytar error: keytar exploded']);
    expectNoSecrets([...unavailable.all(), ...missing.all(), ...tooShort.all(), ...thrown.all()]);
  });

  it('logs identity load failure and does not dial', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const logs = collectLogger();
    await writeConfig(dir, ENABLED);
    await expect(startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => { throw new Error(`identity boom\n${SECRET}`); },
      logger: logs.logger,
      loadKeytar: keytarOf(SECRET),
    })).resolves.toBeNull();
    expect(logs.warn).toEqual(['Companion relay identity load failed: identity boom']);
    expectNoSecrets(logs.all());
  });

  it('never puts the credential value in any skip log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    const logs = collectLogger();
    await writeConfig(dir, { ...ENABLED, secret: SECRET, url: `wss://user:${SECRET}@relay.example.invalid/companion` });
    loadCompanionRelayConfig(dir, logs.logger);
    await loadCompanionRelayCredential('companion-relay', { logger: logs.logger, loadKeytar: keytarOf(SECRET) });
    await loadCompanionRelayCredential('companion-relay', { logger: logs.logger, loadKeytar: keytarOf(SHORT_SECRET) });
    await loadCompanionRelayCredential('companion-relay', {
      logger: logs.logger,
      loadKeytar: keytarOf(new Error(`boom\n${SECRET}`)),
    });
    expectNoSecrets(logs.all());
  });
});
