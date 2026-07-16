import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), 'utf8');

type Rgb = [number, number, number];

const hexToRgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

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

const readHexVariable = (theme: string, variable: string): Rgb => {
  const value = theme.match(new RegExp(`${variable}\\s*:\\s*(#[0-9A-F]{6})`, 'i'))?.[1];
  if (!value) throw new Error(`Missing hex value for ${variable}`);
  return hexToRgb(value);
};

const semanticTokens = [
  ['surface-faint', '--surface-faint'],
  ['surface-subtle', '--surface-subtle'],
  ['surface-hover', '--surface-hover'],
  ['border-faint', '--border-faint'],
  ['border-muted', '--border-muted'],
  ['border-hover', '--border-hover'],
] as const;

const statusTextTokens = [
  ['status-success', '--status-text-success'],
  ['status-warning', '--status-text-warning'],
  ['status-error', '--status-text-error'],
  ['status-warning-soft', '--status-text-warning-soft'],
] as const;

const themeFiles = [
  'src/renderer/styles/themes/light.css',
  'src/renderer/styles/themes/dark.css',
  'src/renderer/styles/themes/high-contrast-light.css',
  'src/renderer/styles/themes/high-contrast-dark.css',
];

describe('chat semantic theme tokens', () => {
  it('registers surface, border, and status text semantic colors in Tailwind', () => {
    const tailwindConfig = readSource('tailwind.config.js');

    for (const [name, variable] of [...semanticTokens, ...statusTextTokens]) {
      expect(tailwindConfig).toContain(`'${name}': 'var(${variable})'`);
    }

    expect(tailwindConfig).toContain("DEFAULT: 'var(--color-success)'");
    expect(tailwindConfig).toContain("DEFAULT: 'var(--color-warning)'");
    expect(tailwindConfig).toContain("DEFAULT: 'var(--color-error)'");
  });

  it.each(themeFiles)('defines every new variable in %s', (themeFile) => {
    const theme = readSource(themeFile);

    for (const [, variable] of [...semanticTokens, ...statusTextTokens]) {
      expect(theme).toMatch(new RegExp(`${variable}\\s*:`));
    }
  });

  it('restores the original dark chat status text literals', () => {
    const darkTheme = readSource('src/renderer/styles/themes/dark.css');

    expect(darkTheme).toContain('--status-text-success: #6EE7B7;');
    expect(darkTheme).toContain('--status-text-warning: #FCD34D;');
    expect(darkTheme).toContain('--status-text-error: #FCA5A5;');
    expect(darkTheme).toContain('--status-text-warning-soft: #FEF3C7;');
  });

  it.each([
    'src/renderer/styles/themes/light.css',
    'src/renderer/styles/themes/high-contrast-light.css',
  ])('keeps warning text above 4.5:1 on the layered warning background in %s', (themeFile) => {
    const theme = readSource(themeFile);
    const baseBackground = hexToRgb('#FAFAFA');
    const warningBackground = composite(hexToRgb('#F59E0B'), baseBackground, 0.1);

    expect(theme).toContain('--status-text-warning: #92400E;');
    expect(theme).toContain('--status-text-warning-soft: #92400E;');
    expect(contrast(readHexVariable(theme, '--status-text-warning'), warningBackground))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(readHexVariable(theme, '--status-text-warning-soft'), warningBackground))
      .toBeGreaterThanOrEqual(4.5);
  });

  it('uses dedicated status text classes in the targeted chat components', () => {
    const chatView = readSource('src/renderer/components/ChatView.tsx');
    const turnCard = readSource('src/renderer/components/features/chat/TurnCard.tsx');
    const getToneClass = turnCard.match(/function getToneClass[\s\S]*?\n}/)?.[0] ?? '';
    const recoveryBanner = chatView.match(/const StreamRecoveryBanner[\s\S]*?\n};/)?.[0] ?? '';

    expect(getToneClass).toContain('text-status-success');
    expect(getToneClass).toContain('text-status-warning');
    expect(getToneClass).toContain('text-status-error');
    expect(getToneClass).not.toMatch(/text-(success|warning|error)(?:\W|$)/);
    expect(recoveryBanner).toContain('text-status-warning-soft');
    expect(recoveryBanner).toContain('dark:text-status-warning-soft/80');
    expect(recoveryBanner).toContain('dark:text-status-warning-soft/60');
    expect(recoveryBanner).toContain('[.high-contrast-dark_&]:text-status-warning-soft/80');
    expect(recoveryBanner).toContain('[.high-contrast-dark_&]:text-status-warning-soft/60');
    expect(recoveryBanner).not.toContain('className="mt-1 text-status-warning-soft/80"');
    expect(recoveryBanner).not.toContain('className="mt-1 text-xs text-status-warning-soft/60"');
    expect(recoveryBanner).not.toMatch(/text-warning(?:\W|$)/);
  });

  it('removes the named dark-only literals from their targeted chat UI fragments', () => {
    const chatView = readSource('src/renderer/components/ChatView.tsx');
    const turnCard = readSource('src/renderer/components/features/chat/TurnCard.tsx');
    const toolStepGroup = readSource('src/renderer/components/features/chat/ToolStepGroup.tsx');
    const traceNodeRenderer = readSource('src/renderer/components/features/chat/TraceNodeRenderer.tsx');
    const getToneClass = turnCard.match(/function getToneClass[\s\S]*?\n}/)?.[0] ?? '';

    expect(chatView).not.toContain('text-amber-100');
    expect(chatView).not.toContain('hover:border-white/[0.18] hover:bg-white/[0.05]');
    expect(turnCard).not.toContain('border-white/[0.035] bg-white/[0.012]');
    expect(getToneClass).not.toContain('text-emerald-300');
    expect(getToneClass).not.toContain('text-amber-300');
    expect(getToneClass).not.toContain('text-red-300');
    expect(toolStepGroup).not.toContain('hover:bg-white/[0.018]');
    expect(traceNodeRenderer).not.toContain(
      'bg-zinc-800/60 border border-white/[0.06]',
    );
  });
});
