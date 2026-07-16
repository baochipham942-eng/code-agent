import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), 'utf8');

const semanticTokens = [
  ['surface-faint', '--surface-faint'],
  ['surface-subtle', '--surface-subtle'],
  ['surface-hover', '--surface-hover'],
  ['border-faint', '--border-faint'],
  ['border-muted', '--border-muted'],
  ['border-hover', '--border-hover'],
] as const;

const themeFiles = [
  'src/renderer/styles/themes/light.css',
  'src/renderer/styles/themes/dark.css',
  'src/renderer/styles/themes/high-contrast-light.css',
  'src/renderer/styles/themes/high-contrast-dark.css',
];

describe('chat semantic theme tokens', () => {
  it('registers surface, border, and status semantic colors in Tailwind', () => {
    const tailwindConfig = readSource('tailwind.config.js');

    for (const [name, variable] of semanticTokens) {
      expect(tailwindConfig).toContain(`'${name}': 'var(${variable})'`);
    }

    expect(tailwindConfig).toContain("DEFAULT: 'var(--color-success)'");
    expect(tailwindConfig).toContain("DEFAULT: 'var(--color-warning)'");
    expect(tailwindConfig).toContain("DEFAULT: 'var(--color-error)'");
  });

  it.each(themeFiles)('defines every new variable in %s', (themeFile) => {
    const theme = readSource(themeFile);

    for (const [, variable] of semanticTokens) {
      expect(theme).toMatch(new RegExp(`${variable}\\s*:`));
    }
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
