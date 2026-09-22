import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('uiStore toast channel stays deleted', () => {
  it('does not keep a second toast store after toast moved to useToast', () => {
    expect(existsSync(resolve('src/renderer/stores/uiStore.ts'))).toBe(false);
    const toastSource = readFileSync(resolve('src/renderer/hooks/useToast.ts'), 'utf8');
    expect(toastSource).not.toMatch(/stores\/uiStore/);
  });
});
