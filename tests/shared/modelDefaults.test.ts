import { describe, expect, it } from 'vitest';
import { resolveConfiguredDefaultProvider } from '../../src/shared/modelDefaults';

describe('resolveConfiguredDefaultProvider', () => {
  it('treats models.default as authoritative over the legacy alias', () => {
    expect(resolveConfiguredDefaultProvider({
      default: 'custom-tokenrhythm',
      defaultProvider: 'deepseek',
    }, 'longcat')).toBe('custom-tokenrhythm');
  });

  it('keeps the legacy alias only as a compatibility fallback', () => {
    expect(resolveConfiguredDefaultProvider({
      defaultProvider: 'custom-tokenrhythm',
    }, 'longcat')).toBe('custom-tokenrhythm');
  });
});
