import { describe, expect, it } from 'vitest';
import {
  buildRendererReleaseRecord,
  formatRendererReleaseRecordMarkdown,
} from '../../../scripts/renderer-release-record.mjs';

describe('renderer release record', () => {
  it('builds auditable release records from renderer manifests and manifest diffs', () => {
    const record = buildRendererReleaseRecord({
      createdAt: '2026-06-06T12:00:00.000Z',
      channel: 'latest',
      cohort: 'staff',
      rolloutPercent: 25,
      bundleBaseUrl: 'https://oss.example/renderer-bundle/latest',
      snapshotBaseUrl: 'https://oss.example/renderer-bundle/v0.17.0',
      manifest: {
        version: '0.17.0',
        minShellVersion: '0.16.93',
        contentHash: 'a'.repeat(64),
        bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
        requiredShellCapabilities: [
          'domain:update/check',
          'domain:mcp/listTools',
          'native:tauri/desktop_get_capabilities',
        ],
        requiredRuntimeAssets: ['playwright-browser-runtime', 'onnxruntime-vad'],
        requiredResources: ['resources/browser-relay-extension'],
      },
      manifestDiff: {
        fieldChanges: [
          { field: 'version', base: '0.16.93', head: '0.17.0' },
        ],
        addedRequiredShellCapabilities: ['domain:mcp/listTools'],
        removedRequiredShellCapabilities: [],
        addedRequiredRuntimeAssets: ['playwright-browser-runtime'],
        removedRequiredRuntimeAssets: [],
        addedRequiredResources: ['resources/browser-relay-extension'],
        removedRequiredResources: [],
      },
      git: {
        repository: 'linchen/code-agent',
        ref: 'refs/heads/main',
        sha: 'abc123',
        actor: 'linchen',
        workflow: 'Publish Renderer Bundle (hot update)',
        runId: '42',
        runAttempt: '1',
      },
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      kind: 'renderer_bundle_release_record',
      createdAt: '2026-06-06T12:00:00.000Z',
      channel: 'latest',
      rollout: {
        channel: 'latest',
        cohort: 'staff',
        percent: 25,
      },
      version: '0.17.0',
      minShellVersion: '0.16.93',
      rollbackToBuiltin: false,
      contentHash: 'a'.repeat(64),
      requiredShellCapabilitiesCount: 3,
      requiredShellCapabilitiesByLayer: {
        domain: 2,
        native: 1,
      },
      requiredRuntimeAssetsCount: 2,
      requiredResourcesCount: 1,
      urls: {
        latestManifest: 'https://oss.example/renderer-bundle/latest/manifest.json',
        latestBundle: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
        latestReleaseRecord: 'https://oss.example/renderer-bundle/latest/release-record.json',
        snapshotManifest: 'https://oss.example/renderer-bundle/v0.17.0/manifest.json',
        snapshotBundle: 'https://oss.example/renderer-bundle/v0.17.0/bundle.tar.gz',
        snapshotReleaseRecord: 'https://oss.example/renderer-bundle/v0.17.0/release-record.json',
      },
      git: {
        repository: 'linchen/code-agent',
        sha: 'abc123',
      },
    });
    expect(record.requiredShellCapabilities).toEqual([
      'domain:mcp/listTools',
      'domain:update/check',
      'native:tauri/desktop_get_capabilities',
    ]);
    expect(record.requiredRuntimeAssets).toEqual(['onnxruntime-vad', 'playwright-browser-runtime']);
    expect(record.requiredResources).toEqual(['resources/browser-relay-extension']);
    expect(formatRendererReleaseRecordMarkdown(record)).toContain('Renderer Bundle Release Record');
    expect(formatRendererReleaseRecordMarkdown(record)).toContain('Cohort: staff');
    expect(formatRendererReleaseRecordMarkdown(record)).toContain('Rollout percent: 25');
    expect(formatRendererReleaseRecordMarkdown(record)).toContain('Required shell capabilities: 3 (domain=2, native=1)');
    expect(formatRendererReleaseRecordMarkdown(record)).toContain('Required runtime assets: 2');
    expect(formatRendererReleaseRecordMarkdown(record)).toContain('Required resources: 1');
  });

  it('rejects invalid rollout percentages', () => {
    expect(() =>
      buildRendererReleaseRecord({
        manifest: {
          version: '0.17.0',
          minShellVersion: '0.16.93',
          contentHash: 'a'.repeat(64),
          bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
        },
        rolloutPercent: 100.5,
      }),
    ).toThrow(/rolloutPercent/);
  });

  it('records rollback releases without bundle URLs', () => {
    const record = buildRendererReleaseRecord({
      createdAt: '2026-06-06T12:00:00.000Z',
      bundleBaseUrl: 'https://oss.example/renderer-bundle/latest',
      snapshotBaseUrl: 'https://oss.example/renderer-bundle/v0.17.0',
      manifest: {
        version: '0.17.0',
        minShellVersion: '0.16.93',
        rollbackToBuiltin: true,
        rollbackReason: 'bad overlay',
      },
    });

    expect(record).toMatchObject({
      rollbackToBuiltin: true,
      rollbackReason: 'bad overlay',
      requiredShellCapabilitiesCount: 0,
      requiredRuntimeAssetsCount: 0,
      requiredResourcesCount: 0,
      urls: {
        latestBundle: null,
        snapshotBundle: null,
      },
    });
    expect(record).not.toHaveProperty('contentHash');
    expect(record).not.toHaveProperty('bundleUrl');
  });
});
