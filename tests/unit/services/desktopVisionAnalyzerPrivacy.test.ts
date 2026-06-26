import { describe, expect, it } from 'vitest';
import {
  buildScreenshotRedactionOptionsForAnalysis,
  sanitizeDesktopVisionAnalyzeText,
} from '../../../src/host/services/desktop/desktopVisionAnalyzer';

describe('DesktopVisionAnalyzer privacy', () => {
  it('sanitizes local screenshot analysis before persistence', () => {
    const sanitized = sanitizeDesktopVisionAnalyzeText([
      'Visible email alice@example.com',
      'Credit card 4242 4242 4242 4242',
      'Local file /Users/linchen/private/plan.png',
      'SSN 123-45-6789',
    ].join('\n'));

    expect(sanitized).toContain('[credit card hidden]');
    expect(sanitized).toContain('[ssn hidden]');
    expect(sanitized).not.toContain('alice@example.com');
    expect(sanitized).not.toContain('4242 4242 4242 4242');
    expect(sanitized).not.toContain('/Users/linchen');
    expect(sanitized).not.toContain('123-45-6789');
  });

  it('prefers OCR regions over full-frame screenshot redaction when boxes are available', () => {
    const options = buildScreenshotRedactionOptionsForAnalysis(
      'Visible card 4242 4242 4242 4242',
      JSON.stringify({
        ocrRegions: [
          { x: 0.1, y: 0.2, width: 0.3, height: 0.1, text: 'card 4242 4242 4242 4242' },
        ],
      }),
    );

    expect(options?.fullFrame).toBeUndefined();
    expect(options?.reason).toBe('analysis-sensitive-regions');
    expect(options?.regions).toHaveLength(1);
  });

  it('falls back to full-frame screenshot redaction when sensitive analysis has no boxes', () => {
    const options = buildScreenshotRedactionOptionsForAnalysis(
      'Visible card 4242 4242 4242 4242',
      JSON.stringify({ appName: 'Browser' }),
    );

    expect(options?.fullFrame).toBe(true);
    expect(options?.reason).toBe('analysis-sensitive-text');
  });
});
