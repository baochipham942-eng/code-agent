// PTC 的 SDK 投影接线：模型在写脚本前从工具描述里看到工具签名。
// 三条守着：默认关不改变现有行为、开启后 SDK 真的进描述、失败必须留痕而不是静默回落。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_FLAG = process.env.CODE_AGENT_PTC_ENABLED;

async function loadSchema() {
  vi.resetModules();
  return (await import('../../../../src/host/tools/modules/multiagent/workflow.schema')).workflowSchema;
}

/** 让 getProtocolToolSchemas 返回指定工具表——registry 未初始化时它静默返回 []。 */
function mockRegistry(schemas: unknown[]) {
  vi.doMock('../../../../src/host/tools/protocolToolRegistration', () => ({
    getProtocolToolSchemas: () => schemas,
  }));
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.CODE_AGENT_PTC_ENABLED;
  else process.env.CODE_AGENT_PTC_ENABLED = ORIGINAL_FLAG;
  vi.doUnmock('../../../../src/host/tools/protocolToolRegistration');
});

describe('PTC SDK 投影 · 接线', () => {
  it('默认关：描述里没有 SDK，现有行为零改变', async () => {
    delete process.env.CODE_AGENT_PTC_ENABLED;
    const schema = await loadSchema();
    const rendered = schema.dynamicDescription?.() ?? schema.description;
    expect(rendered).toBe(schema.description);
    expect(rendered).not.toContain('declare const tools');
  });

  it('开启后 SDK 进入描述，模型写脚本前就能看到签名', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    mockRegistry([
      {
        name: 'Read',
        description: '读取文件',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        outputSchema: { type: 'string' },
      },
    ]);
    const schema = await loadSchema();
    const rendered = schema.dynamicDescription?.() ?? '';

    expect(rendered).toContain(schema.description);
    expect(rendered).toContain('declare const tools');
    expect(rendered).toContain('Read: {');
    expect(rendered).toContain('/** 读取文件 */');
  });

  it('工具表里排除 workflow 自身（模型是通过它进来的）', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    mockRegistry([
      { name: 'workflow', description: '自己', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'string' } },
      { name: 'Read', description: '读取', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'string' } },
    ]);
    const schema = await loadSchema();
    const rendered = schema.dynamicDescription?.() ?? '';
    const declBlock = rendered.slice(rendered.indexOf('interface ToolArgsMap'));

    expect(declBlock).toContain('Read:');
    expect(declBlock).not.toContain('workflow:');
  });

  it('注册表为空时回落静态描述并留痕——不产出「你一个工具都没有」的 SDK', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    mockRegistry([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = await loadSchema();
    const rendered = schema.dynamicDescription?.() ?? '';

    expect(rendered).toBe(schema.description);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('工具注册表为空'));
  });

  it('渲染抛错时回落静态描述并留痕，不打挂整张工具表', async () => {
    process.env.CODE_AGENT_PTC_ENABLED = '1';
    mockRegistry([
      {
        name: 'Broken',
        description: '产出契约与投影口径漂了',
        inputSchema: { type: 'object', properties: {} },
        // null 不在受支持集合里 → 产出侧 strict 会抛
        outputSchema: { type: 'null' },
      },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = await loadSchema();
    const rendered = schema.dynamicDescription?.() ?? '';

    expect(rendered).toBe(schema.description);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SDK 投影渲染失败'));
  });
});
