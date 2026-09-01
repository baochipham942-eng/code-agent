import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../../src/host/plugins/pluginValidator';

function manifest(surface: string): Record<string, unknown> {
  return {
    id: 'surface-test',
    name: 'Surface Test',
    version: '1.0.0',
    main: 'index.js',
    surfaces: [surface],
    ...(surface === 'ui' ? {
      pluginUi: {
        sdkVersion: { renderer: 'fixture-version' },
        rendererEntry: 'dist/renderer/index.js',
        rendererStyles: 'dist/renderer/index.css',
      },
    } : {}),
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
        message: `Unknown surface '${removed}'. Valid: tools, internal-feature, ui`,
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

  it('accepts UI slot requests from the public catalog and rejects missing seats', () => {
    const valid = validateManifest({
      ...manifest('ui'),
      uiSlots: ['workspace.page', 'conversation.turnTail'],
    });
    expect(valid.valid).toBe(true);

    const missing = validateManifest({ ...manifest('ui'), uiSlots: ['missing.seat'] });
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContainEqual({
      field: 'uiSlots',
      message: '插件申请的座位 "missing.seat" 不存在，请检查 uiSlots。',
    });
  });

  it('requires UI requests to opt into the ui surface', () => {
    expect(validateManifest({ ...manifest('ui'), uiSlots: [] }).errors)
      .toContainEqual({
        field: 'uiSlots',
        message: '插件声明 ui surface 时，uiSlots 至少要申请一个座位。',
      });
    expect(validateManifest({ ...manifest('tools'), uiSlots: ['workspace.page'] }).errors)
      .toContainEqual({
        field: 'surfaces',
        message: "申请 uiSlots 的插件必须在 surfaces 中包含 'ui'。",
      });
  });
});
