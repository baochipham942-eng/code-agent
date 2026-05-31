import { beforeEach, describe, expect, it } from 'vitest';
import { sessionManagerSchema } from '../../../src/main/tools/modules/session/sessionManager.schema';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/main/tools/protocolRegistry';

describe('SessionManager protocol schema', () => {
  beforeEach(() => {
    resetProtocolRegistry();
  });

  it('registers the real SessionManager schema in the protocol registry', async () => {
    const registry = getProtocolRegistry();
    const schema = registry.getSchemas().find((toolSchema) => toolSchema.name === 'SessionManager');

    expect(schema?.inputSchema).toEqual(sessionManagerSchema.inputSchema);
    expect(schema?.inputSchema.required).toEqual(['action']);
    expect(schema?.inputSchema.properties).toHaveProperty('handoffContent');
    expect(schema?.inputSchema.properties).not.toHaveProperty('delete');

    const handler = await registry.resolve('SessionManager');
    expect(handler.schema).toEqual(sessionManagerSchema);
  });
});
