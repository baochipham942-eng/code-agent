import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];

const readSource = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), 'utf8');

const hexToRgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const readHexVariable = (theme: string, variable: string): Rgb => {
  const value = theme.match(new RegExp(`${variable}\\s*:\\s*(#[0-9A-F]{6})`, 'i'))?.[1];
  if (!value) throw new Error(`Missing hex value for ${variable}`);
  return hexToRgb(value);
};

const readRgbTripletVariable = (theme: string, variable: string): Rgb => {
  const match = theme.match(new RegExp(
    `${variable}\\s*:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`,
  ));
  if (!match) throw new Error(`Missing RGB triplet for ${variable}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const readRgbaVariable = (theme: string, variable: string): { color: Rgb; alpha: number } => {
  const match = theme.match(new RegExp(
    `${variable}\\s*:\\s*rgba\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*([0-9.]+)\\s*\\)`,
  ));
  if (!match) throw new Error(`Missing rgba value for ${variable}`);
  return {
    color: [Number(match[1]), Number(match[2]), Number(match[3])],
    alpha: Number(match[4]),
  };
};

const composite = (foreground: Rgb, background: Rgb, alpha: number): Rgb =>
  foreground.map((channel, index) =>
    channel * alpha + background[index] * (1 - alpha),
  ) as Rgb;

const luminance = (color: Rgb): number => {
  const [red, green, blue] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

const contrast = (foreground: Rgb, background: Rgb): number => {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
};

const themeFiles = [
  ['light', 'src/renderer/styles/themes/light.css'],
  ['dark', 'src/renderer/styles/themes/dark.css'],
] as const;

describe('read-only session notice theme tokens', () => {
  it('uses semantic border and surface tokens instead of a zinc border', () => {
    const notice = readSource(
      'src/renderer/components/features/chat/ChatInput/ReadOnlySessionNotice.tsx',
    );

    expect(notice).toContain('border-border-default bg-surface-subtle');
    expect(notice).not.toMatch(/border-[^"'`]*zinc-/);
  });

  it.each(themeFiles)('keeps the layered %s notice edge visibly distinct', (_name, path) => {
    const theme = readSource(path);
    const page = readHexVariable(theme, '--bg-void');
    const surface = readRgbaVariable(theme, '--surface-subtle');
    const border = readRgbaVariable(theme, '--border-default');
    const card = composite(surface.color, page, surface.alpha);
    const edge = composite(border.color, card, border.alpha);

    expect(contrast(edge, card)).toBeGreaterThanOrEqual(1.15);
  });

  it('does not reduce the dark edge contrast from the zinc implementation', () => {
    const theme = readSource('src/renderer/styles/themes/dark.css');
    const page = readHexVariable(theme, '--bg-void');
    const surface = readRgbaVariable(theme, '--surface-subtle');
    const border = readRgbaVariable(theme, '--border-default');
    const card = composite(surface.color, page, surface.alpha);
    const edge = composite(border.color, card, border.alpha);

    const oldCard = composite(readRgbTripletVariable(theme, '--zinc-900'), page, 0.6);
    const oldEdge = readRgbTripletVariable(theme, '--zinc-800');

    expect(contrast(edge, card)).toBeGreaterThanOrEqual(contrast(oldEdge, oldCard));
  });
});
