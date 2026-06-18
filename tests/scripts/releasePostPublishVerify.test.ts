import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ReleasePostPublishVerificationError,
  auditServerLogs,
  verifyReleasePostPublish,
} from '../../scripts/release-post-publish-verify.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const baseUrl = 'https://agentneo.test';
const manifestUrl = 'https://oss.test/renderer-bundle/latest/manifest.json';
const releaseRecordUrl = 'https://oss.test/renderer-bundle/latest/release-record.json';

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function textResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html', ...(init.headers ?? {}) },
  });
}

function redirectResponse(location: string) {
  return new Response('', {
    status: 302,
    headers: { location },
  });
}

function envelope(kind: string, payload: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    kind,
    keyId: 'test-key',
    contentHash: 'sha256:'.concat('a'.repeat(64)),
    signature: 'test-signature',
    expiresAt: '2099-01-01T00:00:00.000Z',
    payload,
  };
}

function createFetch(overrides: Record<string, Response> = {}) {
  return async (url: string | URL) => {
    const href = String(url);
    const parsed = new URL(href);
    const key = `${parsed.pathname}?${parsed.searchParams.toString()}`;
    if (overrides[href]) return overrides[href].clone();
    if (overrides[key]) return overrides[key].clone();

    if (parsed.pathname === '/api/update' && parsed.searchParams.get('action') === 'check') {
      return jsonResponse({
        success: true,
        hasUpdate: true,
        latestVersion: '0.17.1',
        releaseNotes: 'Release notes',
        source: 'github_releases',
      });
    }
    if (parsed.pathname === '/api/update' && parsed.searchParams.get('action') === 'health') {
      return jsonResponse({ ok: true, source: 'github_releases' });
    }
    if (parsed.pathname === '/api/update' && parsed.searchParams.get('action') === 'download') {
      const suffix = parsed.searchParams.get('arch') === 'x64' ? 'x64' : 'arm64';
      return redirectResponse(`https://oss.test/v0.17.1/Agent-Neo-0.17.1-${suffix}.dmg`);
    }
    if (parsed.pathname === '/code-agent/' || parsed.pathname === '/code-agent') {
      return textResponse(`
        <p class="download-version" id="download-version">最新版本：正在读取</p>
        <script>fetch('/api/update?action=check&version=0.0.0&platform=darwin&channel=stable')</script>
      `);
    }
    if (parsed.pathname === '/api/v1/control-plane') {
      return jsonResponse(envelope('renderer_bundle_rollout', {
        version: '0.17.1',
        manifestUrl,
        rollbackToBuiltin: false,
      }));
    }
    if (href === manifestUrl) {
      return jsonResponse(envelope('renderer_bundle', {
        version: '0.17.1',
        bundleUrl: 'https://oss.test/renderer-bundle/latest/bundle.tar.gz',
        rollbackToBuiltin: false,
      }));
    }
    if (href === releaseRecordUrl) {
      return jsonResponse({
        kind: 'renderer_bundle_release_record',
        version: '0.17.1',
        rollbackToBuiltin: false,
      });
    }
    return jsonResponse({ error: 'not_found', href }, { status: 404 });
  };
}

function writeFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'release-post-publish-fixture-'));
  writeFileSync(join(dir, 'app-update.json'), JSON.stringify({
    success: true,
    hasUpdate: true,
    latestVersion: '0.17.1',
    releaseNotes: 'Release notes',
  }));
  writeFileSync(join(dir, 'update-health.json'), JSON.stringify({ ok: true, source: 'github_releases' }));
  writeFileSync(join(dir, 'download-darwin-arm64.json'), JSON.stringify({
    status: 302,
    headers: { location: 'https://oss.test/v0.17.1/Agent-Neo-0.17.1-arm64.dmg' },
  }));
  writeFileSync(join(dir, 'download-darwin-x64.json'), JSON.stringify({
    status: 302,
    headers: { location: 'https://oss.test/v0.17.1/Agent-Neo-0.17.1-x64.dmg' },
  }));
  writeFileSync(join(dir, 'distribution-page.html'), `
    <p class="download-version" id="download-version">最新版本：正在读取</p>
    <script>fetch('/api/update?action=check&version=0.0.0&platform=darwin&channel=stable')</script>
  `);
  writeFileSync(join(dir, 'control-plane-renderer-rollout.json'), JSON.stringify(envelope('renderer_bundle_rollout', {
    version: '0.17.1',
    manifestUrl,
    rollbackToBuiltin: false,
  })));
  writeFileSync(join(dir, 'renderer-manifest.json'), JSON.stringify(envelope('renderer_bundle', {
    version: '0.17.1',
    bundleUrl: 'https://oss.test/renderer-bundle/latest/bundle.tar.gz',
    rollbackToBuiltin: false,
  })));
  writeFileSync(join(dir, 'renderer-release-record.json'), JSON.stringify({
    kind: 'renderer_bundle_release_record',
    version: '0.17.1',
    rollbackToBuiltin: false,
  }));
  writeFileSync(join(dir, 'server-logs.ndjson'), '{"level":"info","message":"ok","status":200}\n');
  return dir;
}

describe('release post-publish verifier', () => {
  it('passes fixture-backed production checks while surfacing GitHub metadata fallback as a warning', async () => {
    const result = await verifyReleasePostPublish({
      version: '0.17.1',
      baseUrl,
      manifestUrl,
      releaseRecordUrl,
      fetchImpl: createFetch(),
    });

    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'cloud_api_metadata_fallback' }),
      expect.objectContaining({ code: 'server_log_audit_skipped' }),
      expect.objectContaining({ code: 'distribution_page_version_is_dynamic' }),
    ]));
    expect(result.summary.renderer.controlPlane.version).toBe('0.17.1');
  });

  it('fails when control-plane renderer rollout is behind and rolling back to builtin', async () => {
    await expect(verifyReleasePostPublish({
      version: '0.17.1',
      baseUrl,
      manifestUrl,
      releaseRecordUrl,
      fetchImpl: createFetch({
        '/api/v1/control-plane?artifact=renderer_bundle_rollout': jsonResponse(envelope('renderer_bundle_rollout', {
          version: '0.16.101',
          rollbackToBuiltin: true,
        })),
      }),
    })).rejects.toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ code: 'version_mismatch', label: 'control-plane renderer rollout' }),
        expect.objectContaining({ code: 'control_plane_renderer_rollback_enabled' }),
      ]),
    } satisfies Partial<ReleasePostPublishVerificationError>);
  });

  it('flags DEP0169 warnings in exported server logs', () => {
    const result = auditServerLogs([
      '{"level":"error","message":"(node:1) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized."}',
      '{"level":"info","message":"ok","status":200}',
    ].join('\n'));

    expect(result.failures).toEqual([
      expect.objectContaining({ code: 'server_log_dep0169' }),
    ]);
  });

  it('flags Vercel responseStatusCode 5xx entries in exported server logs', () => {
    const result = auditServerLogs([
      '{"level":"info","requestPath":"/api/update","responseStatusCode":503}',
    ].join('\n'));

    expect(result.failures).toEqual([
      expect.objectContaining({ code: 'server_log_5xx', status: 503 }),
    ]);
  });

  it('supports fixture-dir dry runs from the CLI', () => {
    const fixtureDir = writeFixtureDir();
    const result = spawnSync('node', [
      'scripts/release-post-publish-verify.mjs',
      '--version',
      '0.17.1',
      '--fixture-dir',
      fixtureDir,
      '--json',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'cloud_api_metadata_fallback' }),
        expect.objectContaining({ code: 'distribution_page_version_is_dynamic' }),
      ]),
    });
  });
});
