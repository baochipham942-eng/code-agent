import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../src/host/tools/registry';
import type { ToolLoader, ToolSchema } from '../../../src/host/protocol/tools';
import { assertSupportedJsonSchema } from '../../../src/host/tools/outputSchema';

const loader = (async () => {
  throw new Error('loader should remain lazy');
}) as ToolLoader;

function schema(outputSchema?: ToolSchema['outputSchema']): ToolSchema {
  return {
    name: 'test_tool',
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    outputSchema,
    category: 'fs',
    permissionLevel: 'read',
  };
}

describe('tool output schema registration', () => {
  it('accepts explicit scalar, array, and object roots', () => {
    expect(() => assertSupportedJsonSchema({ type: 'string' })).not.toThrow();
    expect(() => assertSupportedJsonSchema({
      type: 'array',
      items: { type: 'number' },
    })).not.toThrow();
    expect(() => assertSupportedJsonSchema({
      type: 'object',
      properties: { value: { type: 'boolean' } },
      required: ['value'],
    })).not.toThrow();
  });

  it('fails loud for object roots without properties', () => {
    expect(() => assertSupportedJsonSchema({ type: 'object' }))
      .toThrow('with type object must declare properties');
  });

  it('fails loud for unsupported nested schema types during registration', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(schema({
      type: 'object',
      properties: { count: { type: 'integer' } },
    }), loader)).toThrow('test_tool.outputSchema.properties.count.type');
    expect(registry.has('test_tool')).toBe(false);
  });

  it('temporarily accepts a missing schema while coverage is being filled', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(schema(), loader)).not.toThrow();
  });
});
