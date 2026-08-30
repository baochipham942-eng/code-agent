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

  it('accepts omitted capability declarations and enforces arrays, namespaced keys, uniqueness, and own-key', () => {
    expect(validateManifest(manifest('tools')).valid).toBe(true);

    expect(validateManifest({ ...manifest('tools'), depends: 'plugin:provider' }).errors)
      .toContainEqual({ field: 'depends', message: "'depends' must be an array" });
    expect(validateManifest({ ...manifest('tools'), depends: ['provider'] }).errors[0])
      .toMatchObject({ field: 'depends', message: expect.stringContaining('Invalid capability key') });
    expect(validateManifest({ ...manifest('tools'), depends: ['plugin:provider', 'plugin:provider'] }).errors)
      .toContainEqual({ field: 'depends', message: "'depends' must not contain duplicate capability keys" });
    expect(validateManifest({ ...manifest('tools'), provides: ['plugin:alias'] }).errors)
      .toContainEqual({
        field: 'provides',
        message: "'provides' must include the plugin's own capability key 'plugin:surface-test'",
      });
  });
});
