import { describe, expect, it } from 'vitest';
// @ts-expect-error —— 纯 JS 释放门脚本，无类型声明
import { classifyDesktopShellDiagnostics } from '../../scripts/desktop-shell-diagnostics.mjs';
// @ts-expect-error —— 纯 JS 释放门脚本，无类型声明
import { verifyPackagedDesktopShellEvidence } from '../../scripts/desktop-shell-packaged-smoke.mjs';

function rendererServe(overrides: Record<string, unknown> = {}) {
  return {
    source: 'active',
    reason: 'active-healthy',
    serveDir: '/data/renderer-cache/active',
    builtinDir: '/app/dist/renderer',
    activeDir: '/data/renderer-cache/active',
    activeBundle: { version: '0.20.0', contentHash: 'hash' },
    currentShellVersion: '0.20.0',
    ...overrides,
  };
}

function desktopShellDiagnostics(overrides: Record<string, unknown> = {}) {
  const renderer = rendererServe();
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-24T00:00:00.000Z',
    app: {
      version: '0.20.0',
      mode: 'tauri',
      bundleId: 'com.linchen.code-agent',
      dataDir: '/tmp/agent-neo-smoke',
      webPort: 19777,
      pid: 100,
    },
    boot: {
      stage: 'window-navigated',
      bootId: 'boot-id',
      pid: 100,
      webServerPid: 200,
      diagnosticFile: '/tmp/agent-neo-smoke/logs/desktop-shell-boot-latest.json',
      healthMatchedBootToken: true,
    },
    webServer: {
      url: 'http://localhost:19777',
      health: 'ok',
      pid: 200,
      serverRoot: '/app',
    },
    renderer,
    resources: [
      {
        id: 'web-server-script',
        label: 'webServer bundle',
        kind: 'web-server',
        required: true,
        status: 'present',
        path: '/app/dist/web/webServer.cjs',
      },
      {
        id: 'renderer-index',
        label: 'builtin renderer index',
        kind: 'renderer',
        required: true,
        status: 'present',
        path: '/app/dist/renderer/index.html',
      },
      {
        id: 'bundled-node',
        label: 'bundled Node',
        kind: 'runtime',
        required: true,
        status: 'present',
        path: '/app/dist/bundled-node/bin/node',
      },
    ],
    runtimeAssets: {
      runtimeBaseDir: '/runtime',
      activeManifestPath: '/runtime/active.json',
      assets: [],
      summary: { installed: 0, bundledFallback: 1, missing: 0, unsupported: 0 },
    },
    rendererBundle: null,
    issues: [],
    ...overrides,
  };
}

function boot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-24T00:00:00.000Z',
    pid: 100,
    webPort: 19777,
    stage: 'window-navigated',
    webServerPid: 200,
    healthMatchedBootToken: true,
    diagnosticFile: '/tmp/agent-neo-smoke/logs/desktop-shell-boot-latest.json',
    ...overrides,
  };
}

function health(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    mode: 'web-standalone',
    timestamp: 1,
    handlers: 10,
    pid: 200,
    serverRoot: '/app',
    tauriBootToken: '11111111-1111-4111-8111-111111111111',
    rendererServe: rendererServe(),
    ...overrides,
  };
}

describe('desktop shell diagnostics classification', () => {
  it('passes healthy packaged shell evidence without leaking the boot token', () => {
    const diagnostics = desktopShellDiagnostics();
    const result = verifyPackagedDesktopShellEvidence({
      boot: boot(),
      health: health(),
      desktopShellResponse: { success: true, data: diagnostics },
      bootFile: '/tmp/agent-neo-smoke/logs/desktop-shell-boot-latest.json',
      healthUrl: 'http://localhost:19777/api/health',
      diagnosticsEndpoint: 'http://localhost:19777/api/domain/diagnostics/desktopShell',
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.summary).toMatchObject({
      evidenceReady: true,
      webHealth: 'ok',
      rendererSource: 'active',
      classificationStatus: 'ok',
    });
    expect(result.evidence.health).toMatchObject({ hasTauriBootToken: true });
    expect(JSON.stringify(result)).not.toContain('11111111-1111-4111-8111-111111111111');
  });

  it('classifies port occupation, boot token mismatch, resource loss, renderer fallback, and runtime asset loss', () => {
    const diagnostics = desktopShellDiagnostics({
      boot: {
        stage: 'failed',
        webServerPid: 201,
        healthMatchedBootToken: false,
        diagnosticFile: '/tmp/agent-neo-smoke/logs/desktop-shell-boot-latest.json',
      },
      webServer: {
        url: 'http://localhost:19777',
        health: 'boot-token-mismatch',
        pid: 201,
      },
      renderer: rendererServe({
        source: 'builtin',
        reason: 'active-index-missing',
        activeBundle: { version: '0.19.0', contentHash: 'old' },
      }),
      resources: [
        {
          id: 'web-server-script',
          label: 'webServer bundle',
          kind: 'web-server',
          required: true,
          status: 'missing',
          path: '/app/dist/web/webServer.cjs',
        },
      ],
      runtimeAssets: {
        runtimeBaseDir: '/runtime',
        activeManifestPath: '/runtime/active.json',
        assets: [
          {
            id: 'sharp-image-runtime',
            label: 'Image processing components',
            delivery: 'bundled',
            state: 'missing',
            nodeModules: [{ name: 'sharp', path: '/app/node_modules/sharp', exists: false, source: 'bundled' }],
          },
          {
            id: 'playwright-browser-runtime',
            label: 'Browser automation components',
            delivery: 'optional',
            state: 'missing',
            nodeModules: [],
          },
        ],
        summary: { installed: 0, bundledFallback: 0, missing: 2, unsupported: 0 },
      },
      issues: [
        {
          severity: 'error',
          code: 'desktop-shell-port-occupied',
          message: '端口 19777 被其他进程占用',
        },
      ],
    });

    const classification = classifyDesktopShellDiagnostics(diagnostics);
    const codes = classification.issues.map((issue: { code: string }) => issue.code);

    expect(classification.status).toBe('failed');
    expect(codes).toEqual(expect.arrayContaining([
      'desktop_shell_port_occupied',
      'desktop_shell_boot_token_mismatch',
      'desktop_shell_required_resource_missing',
      'desktop_shell_renderer_fallback',
      'desktop_shell_runtime_asset_missing',
    ]));
    for (const code of [
      'desktop_shell_port_occupied',
      'desktop_shell_boot_token_mismatch',
      'desktop_shell_required_resource_missing',
      'desktop_shell_renderer_fallback',
      'desktop_shell_runtime_asset_missing',
    ]) {
      expect(classification.issues.find((issue: { code: string }) => issue.code === code)?.action).toBeTruthy();
    }
  });

  it('treats a fresh-install builtin renderer fallback as informational', () => {
    const classification = classifyDesktopShellDiagnostics(desktopShellDiagnostics({
      renderer: rendererServe({
        source: 'builtin',
        reason: 'no-active-meta',
        activeBundle: null,
      }),
    }));

    expect(classification.status).toBe('ok');
    expect(classification.issues).toContainEqual(expect.objectContaining({
      severity: 'info',
      code: 'desktop_shell_renderer_fallback',
    }));
  });

  it('fails packaged smoke evidence when the three sources disagree', () => {
    const diagnostics = desktopShellDiagnostics({
      renderer: rendererServe({ source: 'builtin', reason: 'hot-update-disabled', activeBundle: null }),
    });
    const result = verifyPackagedDesktopShellEvidence({
      boot: boot({ webServerPid: 200 }),
      health: health({ pid: 222, rendererServe: rendererServe({ source: 'active', reason: 'active-healthy' }) }),
      desktopShellResponse: { success: true, data: diagnostics },
      bootFile: '/tmp/agent-neo-smoke/logs/desktop-shell-boot-latest.json',
      healthUrl: 'http://localhost:19777/api/health',
      diagnosticsEndpoint: 'http://localhost:19777/api/domain/diagnostics/desktopShell',
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'desktop_shell_pid_mismatch' }),
      expect.objectContaining({ code: 'desktop_shell_renderer_health_mismatch' }),
    ]));
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'desktop_shell_renderer_fallback' }),
    ]));
  });
});
