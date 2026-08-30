import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../../src/host/plugins/pluginValidator';

function manifest(surface: string): Record<string, unknown> {
  return {
    id: 'surface-test',
    name: 'Surface Test',
    version: '1.0.0',
    main: 'index.js',
    surfaces: [surface],
  };
}

describe('plugin manifest surfaces', () => {
  it('accepts wired surfaces and rejects the removed skills, theme, and language values', () => {
    expect(validateManifest(manifest('tools')).valid).toBe(true);
    for (const removed of ['skills', 'theme', 'language']) {
      const result = validateManifest(manifest(removed));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: 'surfaces',
        message: `Unknown surface '${removed}'. Valid: tools, internal-feature`,
      });
    }
  });
});
