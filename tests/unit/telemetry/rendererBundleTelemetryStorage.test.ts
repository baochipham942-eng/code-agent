import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import { TelemetryStorage } from '../../../src/host/telemetry/telemetryStorage';
import type { RendererBundleStatus } from '../../../src/shared/contract/update';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

function createRendererBundleStatus(overrides: Partial<RendererBundleStatus> = {}): RendererBundleStatus {
  return {
    schemaVersion: 1,
    source: {
      channel: 'beta',
      manifestUrl: 'https://oss.example/renderer-bundle/channels/beta/manifest.json',
    },
    activeBundle: {
      version: '0.16.92',
      contentHash: 'a'.repeat(64),
    },
    lastAttempt: {
      checkedAt: '2026-06-06T00:00:00.000Z',
      manifestUrl: 'https://oss.example/renderer-bundle/channels/beta/manifest.json',
      currentShellVersion: '0.16.93',
      outcome: 'skipped',
      reason: 'missing-shell-capability',
      manifest: {
        version: '0.17.0-beta.1',
        contentHash: 'b'.repeat(64),
        minShellVersion: '0.16.93',
        bundleUrl: 'https://oss.example/renderer-bundle/channels/beta/bundle.tar.gz',
        requiredShellCapabilitiesCount: 2,
      },
      missingShellCapabilities: ['domain:local/newAction'],
      missingRuntimeAssets: ['playwright-browser-runtime'],
      missingResources: ['resources/browser-relay-extension'],
      diagnostics: ['missing-shell-capability'],
    },
    ...overrides,
  };
}

describe('TelemetryStorage renderer bundle attempts', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.sqlite.exec(`
      CREATE TABLE telemetry_renderer_bundle_attempts (
        id TEXT PRIMARY KEY,
        checked_at INTEGER NOT NULL,
        manifest_url TEXT NOT NULL,
        source_channel TEXT,
        source_manifest_url_override INTEGER NOT NULL DEFAULT 0,
        source_error_reason TEXT,
        source_error_message TEXT,
        source_error_target TEXT,
        current_shell_version TEXT NOT NULL,
        active_version TEXT,
        active_content_hash TEXT,
        outcome TEXT NOT NULL,
        reason TEXT,
        manifest_version TEXT,
        manifest_content_hash TEXT,
        manifest_min_shell_version TEXT,
        manifest_bundle_url TEXT,
        required_shell_capabilities_count INTEGER NOT NULL DEFAULT 0,
        rollback_to_builtin INTEGER NOT NULL DEFAULT 0,
        rollback_reason TEXT,
        missing_shell_capabilities TEXT NOT NULL DEFAULT '[]',
        missing_runtime_assets TEXT NOT NULL DEFAULT '[]',
        missing_resources TEXT NOT NULL DEFAULT '[]',
        diagnostics TEXT NOT NULL DEFAULT '[]',
        error_message TEXT,
        synced_at INTEGER
      )
    `);
    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    isReadySpy = vi.spyOn(database, 'isReady', 'get').mockReturnValue(true);
    database.getDb = () => dbState.sqlite;
  });

  afterEach(() => {
    database.getDb = originalGetDb;
    isReadySpy.mockRestore();
    dbState.sqlite?.close();
    dbState.sqlite = null;
  });

  it('stores renderer hot-update attempt metadata and retries until synced', () => {
    const storage = new TelemetryStorage();
    const recorded = storage.recordRendererBundleAttempt(createRendererBundleStatus());

    expect(recorded?.id).toBeTruthy();
    const unsynced = storage.getUnsyncedRendererBundleAttempts(10);
    expect(unsynced).toHaveLength(1);
    expect(unsynced[0]).toMatchObject({
      manifestUrl: 'https://oss.example/renderer-bundle/channels/beta/manifest.json',
      sourceChannel: 'beta',
      currentShellVersion: '0.16.93',
      activeVersion: '0.16.92',
      outcome: 'skipped',
      reason: 'missing-shell-capability',
      manifestVersion: '0.17.0-beta.1',
      manifestContentHash: 'b'.repeat(64),
      requiredShellCapabilitiesCount: 2,
      missingShellCapabilities: ['domain:local/newAction'],
      missingRuntimeAssets: ['playwright-browser-runtime'],
      missingResources: ['resources/browser-relay-extension'],
      diagnostics: ['missing-shell-capability'],
    });

    storage.markRendererBundleAttemptsSynced([unsynced[0].id], 200);
    expect(storage.getUnsyncedRendererBundleAttempts(10)).toEqual([]);
  });

  it('persists renderer hot-update disabled reason diagnostics', () => {
    const storage = new TelemetryStorage();
    const baseStatus = createRendererBundleStatus();
    const recorded = storage.recordRendererBundleAttempt(createRendererBundleStatus({
      disabled: true,
      disabledReason: 'CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE',
      activeBundle: null,
      lastAttempt: {
        ...baseStatus.lastAttempt!,
        outcome: 'skipped',
        reason: 'disabled',
        diagnostics: [],
      },
    }));

    expect(recorded?.id).toBeTruthy();
    const unsynced = storage.getUnsyncedRendererBundleAttempts(10);
    expect(unsynced).toHaveLength(1);
    expect(unsynced[0]).toMatchObject({
      activeVersion: null,
      outcome: 'skipped',
      reason: 'disabled',
      diagnostics: ['disabledReason:CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE'],
    });
  });
});
