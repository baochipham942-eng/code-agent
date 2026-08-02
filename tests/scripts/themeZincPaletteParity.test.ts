import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const THEME_DIR = resolve(process.cwd(), 'src/renderer/styles/themes');
const THEME_FILES = [
  'dark.css',
  'light.css',
  'high-contrast-dark.css',
  'high-contrast-light.css',
] as const;

type ZincPalette = Map<string, string>;

const readZincPalette = (fileName: string): ZincPalette => {
  const css = readFileSync(resolve(THEME_DIR, fileName), 'utf8');
  return new Map(
    [...css.matchAll(/^\s*(--zinc-[\w-]+)\s*:\s*([^;]+);/gm)]
      .map((match) => [match[1], match[2].trim()] as const),
  );
};

const palettes = new Map(
  THEME_FILES.map((fileName) => [fileName, readZincPalette(fileName)] as const),
);

describe('theme zinc palette parity gate', () => {
  it('keeps every theme aligned with the dark theme zinc key set', () => {
    const referenceFile = THEME_FILES[0];
    const referenceKeys = [...palettes.get(referenceFile)!.keys()].sort();
    const mismatches: string[] = [];

    expect(referenceKeys.length, `${referenceFile} must define at least one --zinc-* token`).toBeGreaterThan(0);

    for (const fileName of THEME_FILES.slice(1)) {
      const actualKeys = [...palettes.get(fileName)!.keys()].sort();
      const missing = referenceKeys.filter((key) => !actualKeys.includes(key));
      const extra = actualKeys.filter((key) => !referenceKeys.includes(key));

      if (missing.length > 0) mismatches.push(`${fileName} missing: ${missing.join(', ')}`);
      if (extra.length > 0) mismatches.push(`${fileName} extra: ${extra.join(', ')}`);
    }

    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it.each(THEME_FILES)('%s uses space-separated decimal RGB triplets', (fileName) => {
    const invalid: string[] = [];

    for (const [key, value] of palettes.get(fileName)!) {
      if (!/^\d{1,3} \d{1,3} \d{1,3}$/.test(value)) {
        invalid.push(`${key}: ${value}`);
        continue;
      }

      const channels = value.split(' ').map(Number);
      if (channels.some((channel) => channel < 0 || channel > 255)) {
        invalid.push(`${key}: ${value}`);
      }
    }

    expect(invalid, `${fileName} invalid --zinc-* values:\n${invalid.join('\n')}`).toEqual([]);
  });
});
