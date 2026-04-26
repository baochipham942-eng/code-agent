import { describe, expect, it } from 'vitest';
import {
  buildBrowserWorkbenchStatusRows,
  getBrowserWorkbenchOperationalHint,
  getBrowserWorkbenchReadinessTone,
} from '../../../src/renderer/utils/workbenchPresentation';
import type { WorkbenchActionTrace } from '../../../src/shared/contract/desktop';

const trace: WorkbenchActionTrace = {
  id: 'trace-123',
  targetKind: 'browser',
  toolName: 'browser_action',
  action: 'navigate',
  mode: 'headless',
  startedAtMs: 1,
};

describe('browser workbench presentation', () => {
  it('builds managed browser status rows with active tab and trace', () => {
    const leaseExpiresAtMs = Date.now() + 30_000;
    const browserSession = {
      managedSession: {
        running: true,
        tabCount: 1,
        activeTab: {
          id: 'tab-1',
          title: 'Docs',
          url: 'https://example.com/docs',
        },
        mode: 'headless' as const,
        sessionId: 'session-main',
        profileMode: 'isolated',
        profileId: 'profile-preview',
        profileDir: '/Users/linchen/Library/Application Support/code-agent/private-profile-preview',
        artifactDir: '/Users/linchen/Downloads/ai/code-agent/.workbench/artifacts/run-42',
        lease: {
          leaseId: 'lease-preview',
          owner: 'browser-action',
          acquiredAtMs: 1,
          lastHeartbeatAtMs: 2,
          expiresAtMs: leaseExpiresAtMs,
          ttlMs: 30_000,
          status: 'active' as const,
        },
        proxy: {
          mode: 'http' as const,
          server: 'http://127.0.0.1:7890',
          bypass: ['localhost', '127.0.0.1'],
          source: 'request' as const,
          regionHint: 'us-west',
        },
        lastTrace: trace,
      },
      computerSurface: null,
      preview: {
        mode: 'managed' as const,
        title: 'Docs',
        url: 'https://example.com/docs',
        surfaceMode: 'headless',
        traceId: 'trace-preview',
        sessionId: 'session-preview',
        profileMode: 'isolated',
        profileId: 'profile-preview',
        artifactDirSummary: '.../run-42',
        lease: {
          leaseId: 'lease-preview',
          owner: 'browser-action',
          acquiredAtMs: 1,
          lastHeartbeatAtMs: 2,
          expiresAtMs: leaseExpiresAtMs,
          ttlMs: 30_000,
          status: 'active' as const,
        },
        proxy: {
          mode: 'http' as const,
          server: 'http://127.0.0.1:7890',
          bypass: ['localhost', '127.0.0.1'],
          source: 'request' as const,
          regionHint: 'us-west',
        },
      },
      blocked: false,
    };

    const rows = buildBrowserWorkbenchStatusRows({
      mode: 'managed',
      browserSession,
    });

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Status', value: 'Running', tone: 'ready' }),
      expect.objectContaining({ label: 'Session', value: 'session-preview' }),
      expect.objectContaining({ label: 'Mode', value: 'headless' }),
      expect.objectContaining({ label: 'Profile', value: 'isolated / profile-preview' }),
      expect.objectContaining({ label: 'Scope', value: 'artifact: .../run-42' }),
      expect.objectContaining({ label: 'Lease', value: expect.stringContaining('active /') }),
      expect.objectContaining({ label: 'Proxy', value: 'http / us-west / bypass 2' }),
      expect.objectContaining({ label: 'Tab', value: 'Docs' }),
      expect.objectContaining({ label: 'Trace', value: 'trace-preview' }),
    ]));
    expect(JSON.stringify(rows)).not.toContain('/Users/linchen/Library');
    expect(JSON.stringify(rows)).not.toContain('/Users/linchen/Downloads/ai/code-agent/.workbench');
    expect(JSON.stringify(rows)).not.toContain('127.0.0.1:7890');
    expect(getBrowserWorkbenchOperationalHint({
      mode: 'managed',
      browserSession,
    })).toBe('browser_action 会使用托管浏览器。');
  });

  it('falls back to a workspace scope summary for managed browser rows', () => {
    const browserSession = {
      managedSession: {
        running: true,
        tabCount: 0,
        activeTab: null,
        mode: 'visible' as const,
        profileDir: '/Users/linchen/Library/Application Support/code-agent/managed-browser-profile',
        workspaceScope: '/Users/linchen/Downloads/ai/code-agent',
      },
      computerSurface: null,
      preview: {
        mode: 'managed' as const,
        surfaceMode: 'visible',
      },
      blocked: false,
    };

    const rows = buildBrowserWorkbenchStatusRows({
      mode: 'managed',
      browserSession,
    });

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Profile', value: 'persistent / managed-browser-profile' }),
      expect.objectContaining({ label: 'Scope', value: 'workspace: .../code-agent' }),
    ]));
    expect(JSON.stringify(rows)).not.toContain('/Users/linchen/Library');
    expect(JSON.stringify(rows)).not.toContain('/Users/linchen/Downloads/ai');
  });

  it('builds desktop computer surface rows with foreground context', () => {
    const browserSession = {
      managedSession: {
        running: false,
        tabCount: 0,
        activeTab: null,
      },
      computerSurface: {
        id: 'surface-1',
        mode: 'foreground_fallback' as const,
        platform: 'darwin',
        ready: true,
        background: false,
        requiresForeground: true,
        approvalScope: 'session_app' as const,
        safetyNote: 'Computer Surface 会作用于当前前台 app/window；没有后台隔离。',
        approvedApps: [],
        deniedApps: [],
        lastAction: {
          ...trace,
          id: 'trace-computer',
          targetKind: 'computer' as const,
          toolName: 'computer_use',
          action: 'observe',
          mode: 'foreground_fallback',
        },
      },
      preview: {
        mode: 'desktop' as const,
        frontmostApp: 'Google Chrome',
        title: 'Example Docs',
        url: 'https://example.com/docs',
        surfaceMode: 'foreground_fallback',
        traceId: 'trace-computer',
      },
      blocked: false,
    };

    expect(buildBrowserWorkbenchStatusRows({
      mode: 'desktop',
      browserSession,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Surface', value: 'Foreground fallback (current window)', tone: 'ready' }),
      expect.objectContaining({ label: 'App', value: 'Google Chrome' }),
      expect.objectContaining({ label: 'Window', value: 'Example Docs' }),
      expect.objectContaining({ label: 'Trace', value: 'trace-computer' }),
    ]));
    expect(getBrowserWorkbenchOperationalHint({
      mode: 'desktop',
      browserSession,
    })).toBe('Computer Surface 会作用于当前前台 app/window；没有后台隔离。');
  });

  it('describes background Accessibility surface without implying foreground focus', () => {
    const browserSession = {
      managedSession: {
        running: false,
        tabCount: 0,
        activeTab: null,
      },
      computerSurface: {
        id: 'surface-1',
        mode: 'background_ax' as const,
        platform: 'darwin',
        ready: true,
        background: true,
        requiresForeground: false,
        approvalScope: 'session_app' as const,
        safetyNote: 'Computer Surface 会通过 macOS Accessibility 操作指定 app/window；坐标类动作仍需前台窗口兜底。',
        targetApp: 'Finder',
        approvedApps: [],
        deniedApps: [],
      },
      preview: {
        mode: 'desktop' as const,
        frontmostApp: null,
        title: null,
        url: null,
        surfaceMode: 'background_ax',
        traceId: null,
      },
      blocked: false,
    };

    expect(buildBrowserWorkbenchStatusRows({
      mode: 'desktop',
      browserSession,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Surface', value: 'Background Accessibility surface', tone: 'ready' }),
      expect.objectContaining({ label: 'App', value: 'Finder' }),
    ]));
    expect(getBrowserWorkbenchOperationalHint({
      mode: 'desktop',
      browserSession,
    })).toBe('Computer Surface 会通过 macOS Accessibility 操作指定 app/window；坐标类动作仍需前台窗口兜底。');
  });

  it('uses blocked detail as the operational hint', () => {
    const browserSession = {
      managedSession: {
        running: false,
        tabCount: 0,
        activeTab: null,
      },
      computerSurface: null,
      preview: null,
      blocked: true,
      blockedDetail: '托管浏览器未启动。',
    };

    expect(getBrowserWorkbenchOperationalHint({
      mode: 'managed',
      browserSession,
    })).toBe('托管浏览器未启动。');
    expect(getBrowserWorkbenchReadinessTone({ ready: true })).toBe('ready');
    expect(getBrowserWorkbenchReadinessTone({ ready: false })).toBe('blocked');
    expect(getBrowserWorkbenchReadinessTone({ ready: false, tone: 'neutral' })).toBe('neutral');
  });
});
