import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../src/main/tools/registry';
import { registerMigratedTools } from '../../../src/main/tools/modules';
import { browserSchema } from '../../../src/main/plugins/builtin/browserControl/browser.schema';
import { browserActionSchema } from '../../../src/main/plugins/builtin/browserControl/browserAction.schema';
import { computerSchema } from '../../../src/main/plugins/builtin/computerUse/computer.schema';
import { computerUseSchema } from '../../../src/main/plugins/builtin/computerUse/computerUse.schema';
import type { ToolSchema } from '../../../src/main/protocol/tools';

const pluginSchemas = new Map<string, ToolSchema>([
  [browserSchema.name, browserSchema],
  [browserActionSchema.name, browserActionSchema],
  [computerSchema.name, computerSchema],
  [computerUseSchema.name, computerUseSchema],
]);

function propertiesOf(schemaName: string): Record<string, unknown> {
  const schema = pluginSchemas.get(schemaName);
  if (!schema) throw new Error(`schema not found: ${schemaName}`);
  return (schema.inputSchema.properties || {}) as Record<string, unknown>;
}

function actionEnumOf(schemaName: string): string[] {
  const action = propertiesOf(schemaName).action as { enum?: string[] } | undefined;
  return action?.enum || [];
}

describe('vision protocol schemas', () => {
  it('exposes managed browser actions through protocol registry schemas', () => {
    const browserProps = propertiesOf('Browser');
    const browserActions = actionEnumOf('Browser');
    const browserActionActions = actionEnumOf('browser_action');

    expect(browserActions).toContain('set_viewport');
    expect(browserActions).toContain('get_dom_snapshot');
    expect(browserActionActions).toContain('set_viewport');
    expect(browserActionActions).toContain('get_dom_snapshot');
    expect(browserProps).toHaveProperty('width');
    expect(browserProps).toHaveProperty('height');
    expect(browserProps).toHaveProperty('tabId');
  });

  it('exposes computer background Accessibility selectors through protocol registry schemas', () => {
    const computerProps = propertiesOf('Computer');
    const computerUseProps = propertiesOf('computer_use');
    const computerActions = actionEnumOf('Computer');
    const computerUseActions = actionEnumOf('computer_use');

    expect(computerActions).toContain('get_ax_elements');
    expect(computerUseActions).toContain('get_ax_elements');
    expect(computerProps).toHaveProperty('targetApp');
    expect(computerProps).toHaveProperty('axPath');
    expect(computerUseProps).toHaveProperty('targetApp');
    expect(computerUseProps).toHaveProperty('axPath');
  });

  it('registers visual_edit with a real write schema', () => {
    const registry = new ToolRegistry();
    registerMigratedTools(registry);
    const schema = registry.getSchemas().find((item) => item.name === 'visual_edit');

    expect(schema?.permissionLevel).toBe('write');
    expect(schema?.inputSchema.required).toEqual(['file', 'line', 'userIntent']);
  });
});
