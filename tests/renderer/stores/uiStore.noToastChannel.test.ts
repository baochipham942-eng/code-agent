import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('uiStore toast channel stays deleted', () => {
  it('does not export a second toast API', () => {
    const source = readFileSync(resolve('src/renderer/stores/uiStore.ts'), 'utf8');
    expect(source).not.toMatch(/\bshowToast\b/);
    expect(source).not.toMatch(/\bhideToast\b/);
    expect(source).not.toMatch(/\bclearToasts\b/);
    expect(source).not.toMatch(/export function useToast/);
  });
});
