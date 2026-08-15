import type { JSONSchema, JSONSchemaProperty } from '../../shared/contract';

const SUPPORTED_TYPES = new Set(['object', 'string', 'number', 'boolean', 'array']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSchemaNode(
  schema: JSONSchema | JSONSchemaProperty,
  path: string,
): void {
  if (!isRecord(schema)) {
    throw new Error(`${path} must be a JSON Schema object`);
  }

  const type = schema.type;
  if (typeof type !== 'string' || !SUPPORTED_TYPES.has(type)) {
    throw new Error(`${path}.type must be one of object, string, number, boolean, array`);
  }

  if (type === 'object') {
    if (!Object.prototype.hasOwnProperty.call(schema, 'properties') || !isRecord(schema.properties)) {
      throw new Error(`${path} with type object must declare properties`);
    }
    const properties = schema.properties;
    for (const [name, child] of Object.entries(properties)) {
      assertSchemaNode(child as JSONSchemaProperty, `${path}.properties.${name}`);
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string')) {
        throw new Error(`${path}.required must be an array of property names`);
      }
      const missing = schema.required.filter((name) => !(name in properties));
      if (missing.length > 0) {
        throw new Error(`${path}.required references undeclared properties: ${missing.join(', ')}`);
      }
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
      throw new Error(`${path}.additionalProperties must be a boolean`);
    }
    return;
  }

  if (type === 'array') {
    if (!schema.items) {
      throw new Error(`${path} with type array must declare items`);
    }
    assertSchemaNode(schema.items, `${path}.items`);
    return;
  }

  if ('properties' in schema || 'items' in schema) {
    throw new Error(`${path} with scalar type ${type} cannot declare properties or items`);
  }
}

/**
 * PTC/Code Mode 能稳定投影的 JSON Schema 子集。
 * 注册期调用，任何不受支持的产出契约都直接抛错，禁止静默降级。
 */
export function assertSupportedJsonSchema(schema: JSONSchema, label = 'outputSchema'): void {
  assertSchemaNode(schema, label);
}
