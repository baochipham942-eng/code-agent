import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../src/shared/contract/settings';

const mocks = vi.hoisted(() => ({
  setPostHogEnabled: vi.fn(),
  setCrashReportingEnabled: vi.fn(),
  uploaderSetEnabled: vi.fn(),
  langfuseSetEnabled: vi.fn(),
  flushPendingCrashReport: vi.fn(),
}));

vi.mock('../../../src/host/observability/crashMarker', () => ({
  flushPendingCrashReport: mocks.flushPendingCrashReport,
}));

vi.mock('../../../src/host/observability/posthogNode', () => ({
  setPostHogEnabled: mocks.setPostHogEnabled,
}));
vi.mock('../../../src/host/observability/sentryNode', () => ({
  setCrashReportingEnabled: mocks.setCrashReportingEnabled,
}));
vi.mock('../../../src/host/telemetry/telemetryUploaderService', () => ({
  getTelemetryUploaderService: () => ({ setEnabled: mocks.uploaderSetEnabled }),
}));
vi.mock('../../../src/host/services/infra/langfuseService', () => ({
  getLangfuseService: () => ({ setEnabled: mocks.langfuseSetEnabled }),
}));

import { applyPrivacyFlags, installPrivacyGate } from '../../../src/host/observability/privacyGate';
import { resolvePrivacyFlags } from '../../../src/shared/observability/privacyFlags';

describe('resolvePrivacyFlags', () => {
  it('defaults both switches to on', () => {
    expect(resolvePrivacyFlags(undefined)).toEqual({ usageData: true, crashReporting: true });
    expect(resolvePrivacyFlags({})).toEqual({ usageData: true, crashReporting: true });
  });

  it('honors the new privacy fields', () => {
    expect(resolvePrivacyFlags({
      privacy: { usageDataEnabled: false, crashReportingEnabled: false },
    })).toEqual({ usageData: false, crashReporting: false });
  });

  it('falls back to legacy langfuse.enabled for usage data', () => {
    expect(resolvePrivacyFlags({ langfuse: { enabled: false } }).usageData).toBe(false);
    expect(resolvePrivacyFlags({ langfuse: { enabled: true } }).usageData).toBe(true);
  });

  it('lets the new field override the legacy one', () => {
    expect(resolvePrivacyFlags({
      privacy: { usageDataEnabled: true },
      langfuse: { enabled: false },
    }).usageData).toBe(true);
  });
});

describe('applyPrivacyFlags', () => {
  beforeEach(() => {
    mocks.setPostHogEnabled.mockClear();
    mocks.setCrashReportingEnabled.mockClear();
    mocks.uploaderSetEnabled.mockClear();
    mocks.langfuseSetEnabled.mockClear();
  });

  it('fans usageData out to PostHog + uploader + Langfuse, crashReporting to Sentry', () => {
    applyPrivacyFlags({ usageData: false, crashReporting: true });

    expect(mocks.setPostHogEnabled).toHaveBeenCalledWith(false);
    expect(mocks.uploaderSetEnabled).toHaveBeenCalledWith(false);
    expect(mocks.langfuseSetEnabled).toHaveBeenCalledWith(false);
    expect(mocks.setCrashReportingEnabled).toHaveBeenCalledWith(true);
  });

  it('installPrivacyGate applies at boot and replays on settings updates', () => {
    const listeners: Array<(s: AppSettings) => void> = [];
    const fakeConfigService = {
      getSettings: () => ({ privacy: { usageDataEnabled: true } }) as AppSettings,
      onSettingsUpdated: (cb: (s: AppSettings) => void) => listeners.push(cb),
    };
    installPrivacyGate(fakeConfigService as never);

    expect(mocks.setPostHogEnabled).toHaveBeenCalledWith(true);
    // 启动期暂存的 crash 检测必须在开关生效后才补报（顺序：先 apply 再 flush）
    expect(mocks.flushPendingCrashReport).toHaveBeenCalledTimes(1);
    expect(mocks.flushPendingCrashReport.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.setCrashReportingEnabled.mock.invocationCallOrder[0]);
    expect(listeners).toHaveLength(1);

    listeners[0]({ privacy: { usageDataEnabled: false, crashReportingEnabled: false } } as AppSettings);
    expect(mocks.setPostHogEnabled).toHaveBeenLastCalledWith(false);
    expect(mocks.setCrashReportingEnabled).toHaveBeenLastCalledWith(false);
    expect(mocks.uploaderSetEnabled).toHaveBeenLastCalledWith(false);
  });
});
