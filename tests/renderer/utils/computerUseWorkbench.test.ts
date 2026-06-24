import { describe, expect, it } from 'vitest';
import type { ComputerSurfaceState } from '../../../src/renderer/services/nativeDesktop';
import {
  buildComputerUseTargets,
  buildRecentComputerUseAction,
  describeComputerUseFailures,
} from '../../../src/renderer/utils/computerUseWorkbench';

function makeSurface(overrides: Partial<ComputerSurfaceState> = {}): ComputerSurfaceState {
  return {
    id: 'surface-1',
    mode: 'foreground_fallback',
    platform: 'darwin',
    ready: true,
    background: false,
    requiresForeground: true,
    approvalScope: 'session_app',
    safetyNote: 'Foreground fallback',
    targetApp: 'Safari',
    approvedApps: [],
    deniedApps: [],
    lastAction: null,
    ...overrides,
  };
}

describe('computerUseWorkbench', () => {
  it('builds app and window candidates from frontmost, surface, and recent activity', () => {
    const targets = buildComputerUseTargets({
      frontmost: {
        platform: 'darwin',
        capturedAtMs: 1000,
        appName: 'Safari',
        bundleId: 'com.apple.Safari',
        windowTitle: 'Docs',
      },
      surface: makeSurface({
        targetApp: 'Preview',
        lastSnapshot: {
          capturedAtMs: 900,
          appName: 'Preview',
          windowTitle: 'Design.pdf',
        },
        approvedApps: ['Notes'],
        deniedApps: ['Mail'],
      }),
      recentEvents: [
        {
          id: 'event-1',
          capturedAtMs: 800,
          appName: 'Code',
          windowTitle: 'ComputerUsePanel.tsx',
          fingerprint: 'f1',
        },
      ],
    });

    expect(targets.map((target) => [target.source, target.appName, target.windowTitle])).toEqual([
      ['frontmost', 'Safari', 'Docs'],
      ['surface', 'Preview', 'Design.pdf'],
      ['approved', 'Notes', undefined],
      ['denied', 'Mail', undefined],
      ['recent', 'Code', 'ComputerUsePanel.tsx'],
    ]);
  });

  it('reuses the existing browser/computer action preview for recent action risk summaries', () => {
    const summary = buildRecentComputerUseAction(makeSurface({
      mode: 'background_ax',
      background: true,
      requiresForeground: false,
      targetApp: 'Finder',
      lastAction: {
        id: 'trace-1',
        targetKind: 'computer',
        toolName: 'computer_use',
        action: 'get_ax_elements',
        mode: 'background_ax',
        startedAtMs: 1000,
        completedAtMs: 1100,
        evidenceSummary: ['2 candidates'],
      },
    }));

    expect(summary?.preview).toMatchObject({
      surface: 'computer',
      summary: '读取后台 AX 元素',
      target: 'Finder',
      risk: 'read',
      riskLabel: '只读',
      mode: 'background_ax',
      traceId: 'trace-1',
    });
  });

  it('explains provider, permission, foreground, and AX quality degradation', () => {
    const explanations = describeComputerUseFailures({
      nativeAvailable: false,
      desktopProviderError: 'Computer Surface state unavailable',
      permissions: {
        schemaVersion: 1,
        platform: 'darwin',
        checkedAtMs: 1000,
        bundleId: 'com.linchen.code-agent.dev',
        permissions: [
          {
            kind: 'screenCapture',
            label: 'Screen Recording',
            status: 'denied',
            required: false,
            detail: 'Screen Recording permission not granted.',
          },
          {
            kind: 'accessibility',
            label: 'Accessibility',
            status: 'wrong_bundle_id',
            required: true,
            detail: 'Authorized production bundle only.',
          },
          {
            kind: 'microphone',
            label: 'Microphone',
            status: 'needs_restart',
            required: true,
            detail: 'Restart after grant.',
          },
          { kind: 'notifications', status: 'unknown', required: false, label: 'Notifications' },
        ],
        summary: {
          granted: 0,
          denied: 1,
          needsRestart: 1,
          wrongBundleId: 1,
          unknown: 1,
          unsupported: 0,
        },
      },
      surface: makeSurface({
        failureKind: 'ax_tree_poor',
        axQuality: {
          score: 0.2,
          grade: 'poor',
          elementCount: 4,
          labeledElementCount: 1,
          withAxPathCount: 1,
          unlabeledRatio: 0.75,
          missingAxPathRatio: 0.75,
          duplicateLabelRoleCount: 2,
          roleCounts: { AXGroup: 4 },
          reasons: ['mostly unlabeled elements'],
        },
      }),
      targets: [],
      selectedTargetApp: 'Safari',
      elementsError: 'AX unavailable',
    });

    expect(explanations.map((item) => item.id)).toEqual(expect.arrayContaining([
      'native-runtime-unavailable',
      'desktop-provider-error',
      'screenCapture:denied',
      'accessibility:wrong_bundle_id',
      'automation-per-app',
      'failure:ax_tree_poor',
      'foreground-fallback',
      'ax-quality-poor',
      'elements-error',
      'no-targets',
    ]));
    expect(explanations.find((item) => item.id === 'failure:ax_tree_poor')?.detail)
      .toContain('Electron');
  });
});
