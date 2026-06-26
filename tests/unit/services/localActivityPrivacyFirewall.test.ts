import { describe, expect, it } from 'vitest';
import type { DesktopActivityEvent } from '../../../src/shared/contract';
import {
  sanitizeLocalActivityEvent,
  sanitizeLocalActivityText,
} from '../../../src/host/services/activity/localActivityPrivacyFirewall';

function makeEvent(overrides: Partial<DesktopActivityEvent> = {}): DesktopActivityEvent {
  return {
    id: 'event-1',
    capturedAtMs: 1_800_000,
    appName: 'Safari',
    bundleId: 'com.apple.Safari',
    windowTitle: 'Checkout alice@example.com card 4242 4242 4242 4242',
    browserUrl: 'https://example.test/pay?token=abc123#secret',
    browserTitle: 'Payment',
    documentPath: '/Users/linchen/private/report.md',
    sessionState: null,
    idleSeconds: 0,
    powerSource: null,
    onAcPower: null,
    batteryPercent: null,
    batteryCharging: null,
    screenshotPath: '/Users/linchen/Library/Application Support/code-agent/native-desktop/screenshots/screenshot-1.jpg',
    analyzeText: 'Visible email alice@example.com and SSN 123-45-6789',
    fingerprint: 'fp-1',
    ...overrides,
  };
}

describe('local activity privacy firewall', () => {
  it('sanitizes desktop activity events before they leave local storage adapters', () => {
    const sanitized = sanitizeLocalActivityEvent(makeEvent(), { hideScreenshotPath: true });
    const json = JSON.stringify(sanitized);

    expect(sanitized.browserUrl).toBe('https://example.test/pay');
    expect(sanitized.screenshotPath).toBe('[screenshot hidden]');
    expect(sanitized.windowTitle).toContain('[credit card hidden]');
    expect(sanitized.analyzeText).toContain('[ssn hidden]');
    expect(sanitized.documentPath).toContain('~/private/report.md');
    expect(json).not.toContain('alice@example.com');
    expect(json).not.toContain('4242 4242 4242 4242');
    expect(json).not.toContain('token=abc123');
    expect(json).not.toContain('/Users/linchen');
    expect(json).not.toContain('123-45-6789');
  });

  it('keeps non-sensitive text useful for activity search and summaries', () => {
    expect(sanitizeLocalActivityText('Reviewing roadmap and PR diff')).toBe('Reviewing roadmap and PR diff');
  });
});
