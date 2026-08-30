import { beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../src/host/tools/registry';
import type { ToolSchema } from '../../../src/host/protocol/tools';

// Registry 层的 deny 过滤是 --disallowed-tools 复用的既有能力（getSchemasForMode）。
// 本文件锁定该契约，防止裁剪链路复用时语义漂移。

function makeSchema(name: string, readOnly = true): ToolSchema {
  return {
    name,
    description: `${name} tool`,
    category: 'fs',
    readOnly,
    permissionLevel: readOnly ? 'read' : 'write',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'string' },
  };
}

describe('ToolRegistry.getSchemasForMode deny filtering', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    for (const name of ['Bash', 'Edit', 'Read', 'skill:pdf']) {
      registry.register(makeSchema(name, name !== 'Bash' && name !== 'Edit'), async () => {
        throw new Error('loader should not run in this test');
      });
    }
  });

  it('deny 集从 schema 面移除（含 skill:<name> 延迟工具）', () => {
    const schemas = registry.getSchemasForMode({ deny: new Set(['Bash', 'skill:pdf']) });
    expect(schemas.map((schema) => schema.name)).toEqual(['Edit', 'Read']);
  });

  it('无 deny 时返回全集（无 flag 行为不变）', () => {
    const schemas = registry.getSchemasForMode({});
    expect(schemas.map((schema) => schema.name)).toEqual(['Bash', 'Edit', 'Read', 'skill:pdf']);
  });
});
