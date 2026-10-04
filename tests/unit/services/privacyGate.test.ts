import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { explainPrivacyFlags, resolvePrivacyFlags } from '../../../src/shared/observability/privacyFlags';

const ALL_ON = { posthog: true, cloudUpload: true, langfuse: true, crashReporting: true };

function clearChannelMocks(): void {
  mocks.setPostHogEnabled.mockClear();
  mocks.setCrashReportingEnabled.mockClear();
  mocks.uploaderSetEnabled.mockClear();
  mocks.langfuseSetEnabled.mockClear();
  mocks.flushPendingCrashReport.mockClear();
}

describe('resolvePrivacyFlags', () => {
  beforeEach(() => {
    vi.stubEnv('DO_NOT_TRACK', '');
    vi.stubEnv('NEO_DISABLE_TELEMETRY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults every channel to on', () => {
    expect(resolvePrivacyFlags(undefined, {})).toEqual(ALL_ON);
    expect(resolvePrivacyFlags({}, {})).toEqual(ALL_ON);
  });

  it('honors each per-channel privacy field', () => {
    expect(resolvePrivacyFlags({
      privacy: {
        posthogEnabled: false,
        cloudUploadEnabled: true,
        langfuseEnabled: false,
        crashReportingEnabled: false,
      },
    }, {})).toEqual({
      posthog: false,
      cloudUpload: true,
      langfuse: false,
      crashReporting: false,
    });
  });

  it('falls back to legacy usageDataEnabled for all three usage channels', () => {
    expect(resolvePrivacyFlags({ privacy: { usageDataEnabled: false } }, {})).toEqual({
      posthog: false,
      cloudUpload: false,
      langfuse: false,
      crashReporting: true,
    });
    expect(explainPrivacyFlags({ privacy: { usageDataEnabled: true } }, {}).posthog)
      .toEqual({ enabled: true, source: 'legacy:usageDataEnabled' });
  });

  it('falls back to legacy langfuse.enabled only when usageDataEnabled is absent', () => {
    expect(resolvePrivacyFlags({ langfuse: { enabled: false } }, {})).toEqual({
      posthog: false,
      cloudUpload: false,
      langfuse: false,
      crashReporting: true,
    });
    expect(explainPrivacyFlags({ langfuse: { enabled: false } }, {}).cloudUpload.source)
      .toBe('legacy:langfuse.enabled');
    expect(explainPrivacyFlags({ langfuse: { enabled: true } }, {}).langfuse.source)
      .toBe('legacy:langfuse.enabled');
    expect(explainPrivacyFlags({ langfuse: {} }, {}).posthog.source).toBe('default');
  });

  it('lets a per-channel field override both legacy fields', () => {
    const explained = explainPrivacyFlags({
      privacy: { usageDataEnabled: false, posthogEnabled: true },
      langfuse: { enabled: true },
    }, {});
    expect(explained.posthog).toEqual({ enabled: true, source: 'settings.privacy.posthogEnabled' });
    expect(explained.cloudUpload).toEqual({ enabled: false, source: 'legacy:usageDataEnabled' });
    expect(explained.langfuse).toEqual({ enabled: false, source: 'legacy:usageDataEnabled' });
  });

  it('ignores non-boolean junk and keeps the next fallback', () => {
    expect(resolvePrivacyFlags({
      privacy: { usageDataEnabled: 'false', posthogEnabled: 0, cloudUploadEnabled: null },
      langfuse: { enabled: 'yes' },
    }, {}).posthog).toBe(true);
    expect(explainPrivacyFlags({
      privacy: { posthogEnabled: 1 },
      langfuse: { enabled: false },
    }, {}).posthog.source).toBe('legacy:langfuse.enabled');
  });
});

describe('applyPrivacyFlags', () => {
  beforeEach(() => {
    clearChannelMocks();
    vi.stubEnv('DO_NOT_TRACK', '');
    vi.stubEnv('NEO_DISABLE_TELEMETRY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('wires each channel to its own flag', () => {
    applyPrivacyFlags({ posthog: false, cloudUpload: true, langfuse: false, crashReporting: true });

    expect(mocks.setPostHogEnabled).toHaveBeenCalledWith(false);
    expect(mocks.uploaderSetEnabled).toHaveBeenCalledWith(true);
    expect(mocks.langfuseSetEnabled).toHaveBeenCalledWith(false);
    expect(mocks.setCrashReportingEnabled).toHaveBeenCalledWith(true);
  });

  it.each([
    ['posthog', 'posthogEnabled', mocks.setPostHogEnabled],
    ['cloudUpload', 'cloudUploadEnabled', mocks.uploaderSetEnabled],
    ['langfuse', 'langfuseEnabled', mocks.langfuseSetEnabled],
  ] as const)('turning off only %s leaves the other usage channels enabled', (_channel, field, turnedOff) => {
    const flags = resolvePrivacyFlags({ privacy: { [field]: false } }, {});
    applyPrivacyFlags(flags);

    expect(turnedOff).toHaveBeenCalledWith(false);
    for (const other of [mocks.setPostHogEnabled, mocks.uploaderSetEnabled, mocks.langfuseSetEnabled]) {
      if (other !== turnedOff) expect(other).toHaveBeenCalledWith(true);
    }
    expect(mocks.setCrashReportingEnabled).toHaveBeenCalledWith(true);
  });

  it('legacy usageDataEnabled:false still turns all three usage channels off', () => {
    applyPrivacyFlags(resolvePrivacyFlags({ privacy: { usageDataEnabled: false } }, {}));

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
    expect(mocks.uploaderSetEnabled).toHaveBeenCalledWith(true);
    expect(mocks.langfuseSetEnabled).toHaveBeenCalledWith(true);
    expect(mocks.setCrashReportingEnabled).toHaveBeenCalledWith(true);
    // 启动期暂存的 crash 检测必须在开关生效后才补报（顺序：先 apply 再 flush）
    expect(mocks.flushPendingCrashReport).toHaveBeenCalledTimes(1);
    expect(mocks.flushPendingCrashReport.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.setCrashReportingEnabled.mock.invocationCallOrder[0]);
    expect(listeners).toHaveLength(1);

    listeners[0]({ privacy: { cloudUploadEnabled: false, crashReportingEnabled: false } } as AppSettings);
    expect(mocks.setPostHogEnabled).toHaveBeenLastCalledWith(true);
    expect(mocks.uploaderSetEnabled).toHaveBeenLastCalledWith(false);
    expect(mocks.langfuseSetEnabled).toHaveBeenLastCalledWith(true);
    expect(mocks.setCrashReportingEnabled).toHaveBeenLastCalledWith(false);
  });

  it.each([
    ['DO_NOT_TRACK', '1'],
    ['DO_NOT_TRACK', 'True'],
    ['DO_NOT_TRACK', ' 1 '],
    ['NEO_DISABLE_TELEMETRY', 'true'],
    ['NEO_DISABLE_TELEMETRY', '1'],
  ] as const)('%s=%j forces posthog, cloudUpload, langfuse, and crash reporting off', (name, value) => {
    vi.stubEnv('DO_NOT_TRACK', '');
    vi.stubEnv('NEO_DISABLE_TELEMETRY', '');
    vi.stubEnv(name, value);
    const listeners: Array<(s: AppSettings) => void> = [];
    installPrivacyGate({
      getSettings: () => ({
        privacy: {
          posthogEnabled: true,
          cloudUploadEnabled: true,
          langfuseEnabled: true,
          crashReportingEnabled: true,
        },
      }),
      onSettingsUpdated: (cb: (s: AppSettings) => void) => listeners.push(cb),
    } as never);

    expect(mocks.setPostHogEnabled).toHaveBeenCalledWith(false);
    expect(mocks.uploaderSetEnabled).toHaveBeenCalledWith(false);
    expect(mocks.langfuseSetEnabled).toHaveBeenCalledWith(false);
    expect(mocks.setCrashReportingEnabled).toHaveBeenCalledWith(false);
  });

  it.each(['0', 'false', 'no', '2'] as const)('DO_NOT_TRACK=%j is not an opt-out', (value) => {
    vi.stubEnv('DO_NOT_TRACK', value);
    vi.stubEnv('NEO_DISABLE_TELEMETRY', 'false');
    installPrivacyGate({
      getSettings: () => ({
        privacy: {
          posthogEnabled: true,
          cloudUploadEnabled: true,
          langfuseEnabled: true,
          crashReportingEnabled: true,
        },
      }),
      onSettingsUpdated: () => {},
    } as never);

    expect(mocks.setPostHogEnabled).toHaveBeenCalledWith(true);
    expect(mocks.uploaderSetEnabled).toHaveBeenCalledWith(true);
    expect(mocks.langfuseSetEnabled).toHaveBeenCalledWith(true);
    expect(mocks.setCrashReportingEnabled).toHaveBeenCalledWith(true);
  });

  it('records env:DO_NOT_TRACK when both opt-out variables are affirmative', () => {
    const explained = explainPrivacyFlags({
      privacy: { posthogEnabled: true, crashReportingEnabled: true },
    }, { DO_NOT_TRACK: '1', NEO_DISABLE_TELEMETRY: 'true' });
    expect(explained.posthog).toEqual({ enabled: false, source: 'env:DO_NOT_TRACK' });
    expect(explained.cloudUpload.source).toBe('env:DO_NOT_TRACK');
    expect(explained.langfuse.source).toBe('env:DO_NOT_TRACK');
    expect(explained.crashReporting).toEqual({ enabled: false, source: 'env:DO_NOT_TRACK' });
  });
});
