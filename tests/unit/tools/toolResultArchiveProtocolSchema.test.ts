import { beforeEach, describe, expect, it } from 'vitest';
import { toolResultArchiveSchema } from '../../../src/main/tools/modules/file/toolResultArchive.schema';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/main/tools/protocolRegistry';

describe('read_tool_result_archive protocol schema', () => {
  beforeEach(() => {
    resetProtocolRegistry();
  });

  it('registers the real archive reader schema in the protocol registry', async () => {
    const registry = getProtocolRegistry();
    const schema = registry.getSchemas().find((toolSchema) => toolSchema.name === 'read_tool_result_archive');

    expect(schema?.inputSchema).toEqual(toolResultArchiveSchema.inputSchema);
    expect(schema?.inputSchema.required).toEqual(['artifact_id']);
    expect(schema?.readOnly).toBe(true);
    expect(schema?.allowInPlanMode).toBe(true);

    const handler = await registry.resolve('read_tool_result_archive');
    expect(handler.schema).toEqual(toolResultArchiveSchema);
  });
});
