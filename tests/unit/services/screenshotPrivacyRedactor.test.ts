import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  redactScreenshotFile,
  selectScreenshotRedactionRegions,
  shouldRedactScreenshotFromText,
} from '../../../src/host/services/activity/screenshotPrivacyRedactor';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-privacy-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createSplitImage(filePath: string): Promise<void> {
  const left = await sharp({
    create: {
      width: 20,
      height: 20,
      channels: 3,
      background: '#000000',
    },
  }).png().toBuffer();

  const right = await sharp({
    create: {
      width: 20,
      height: 20,
      channels: 3,
      background: '#ffffff',
    },
  }).png().toBuffer();

  await sharp({
    create: {
      width: 40,
      height: 20,
      channels: 3,
      background: '#000000',
    },
  })
    .composite([{ input: right, left: 20, top: 0 }, { input: left, left: 0, top: 0 }])
    .png()
    .toFile(filePath);
}

async function pixelRed(filePath: string, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(filePath)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return data[offset];
}

describe('screenshotPrivacyRedactor', () => {
  it('detects text that should trigger screenshot pixel redaction', () => {
    expect(shouldRedactScreenshotFromText('checkout card 4242 4242 4242 4242')).toBe(true);
    expect(shouldRedactScreenshotFromText('reviewing roadmap diff')).toBe(false);
  });

  it('blurs only the requested screenshot region', async () => {
    const filePath = path.join(tmpDir, 'screen.png');
    await createSplitImage(filePath);

    await redactScreenshotFile(filePath, {
      overwrite: true,
      regions: [{ x: 18, y: 0, width: 4, height: 20 }],
      blurSigma: 4,
      reason: 'test-region',
    });

    expect(await pixelRed(filePath, 10, 10)).toBe(0);
    expect(await pixelRed(filePath, 30, 10)).toBe(255);
    const redactedBoundary = await pixelRed(filePath, 19, 10);
    expect(redactedBoundary).toBeGreaterThan(0);
    expect(redactedBoundary).toBeLessThan(255);
  });

  it('uses OCR/text regions as local screenshot redaction candidates', () => {
    const regions = selectScreenshotRedactionRegions({
      ocr: {
        textRegions: [
          { x: 1, y: 2, width: 3, height: 4, text: 'normal heading' },
          { x: 10, y: 12, width: 30, height: 8, text: 'card 4242 4242 4242 4242' },
        ],
      },
    }, 'Visible card 4242 4242 4242 4242');

    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ x: 10, y: 12, width: 30, height: 8 });
  });

  it('supports normalized OCR regions for local pixel redaction', async () => {
    const filePath = path.join(tmpDir, 'screen.png');
    await createSplitImage(filePath);

    await redactScreenshotFile(filePath, {
      overwrite: true,
      regions: [{ x: 0.45, y: 0, width: 0.1, height: 1, normalized: true }],
      blurSigma: 4,
      reason: 'test-normalized-region',
    });

    expect(await pixelRed(filePath, 10, 10)).toBe(0);
    expect(await pixelRed(filePath, 30, 10)).toBe(255);
    const redactedBoundary = await pixelRed(filePath, 19, 10);
    expect(redactedBoundary).toBeGreaterThan(0);
    expect(redactedBoundary).toBeLessThan(255);
  });

  it('supports full-frame blur for sensitive screenshot fallback', async () => {
    const filePath = path.join(tmpDir, 'screen.png');
    await createSplitImage(filePath);

    await redactScreenshotFile(filePath, {
      overwrite: true,
      fullFrame: true,
      blurSigma: 8,
      reason: 'test-full-frame',
    });

    const boundary = await pixelRed(filePath, 19, 10);
    expect(boundary).toBeGreaterThan(0);
    expect(boundary).toBeLessThan(255);
  });
});
