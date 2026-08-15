// SDK 投影：工具目录 → 模型可读的 TS 声明。
// 守两条承重性质：确定性（同一工具集渲染两次逐字节相同，KV cache 前缀稳定的前提）
// 和覆盖面恰好等于受支持子集（集合外形状必须抛，不许静默降级成宽类型）。
import { describe, expect, it } from 'vitest';
import { renderToolsSdk, type SdkToolProjection } from '../../../../src/host/agent/scriptRuntime/toolsSdk';
import type { JSONSchema } from '../../../../src/shared/contract';

function tool(overrides: Partial<SdkToolProjection> & { name: string }): SdkToolProjection {
  return {
    description: `${overrides.name} 的说明`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } as JSONSchema,
    outputSchema: { type: 'string' } as JSONSchema,
    ...overrides,
  };
}

describe('renderToolsSdk · 确定性', () => {
  it('同一工具集渲染两次逐字节相同', () => {
    const tools = [tool({ name: 'Read' }), tool({ name: 'Grep' })];
    expect(renderToolsSdk(tools)).toBe(renderToolsSdk(tools));
  });

  it('输入顺序不影响输出——按名字字典序', () => {
    const a = renderToolsSdk([tool({ name: 'Write' }), tool({ name: 'Grep' }), tool({ name: 'Read' })]);
    const b = renderToolsSdk([tool({ name: 'Read' }), tool({ name: 'Write' }), tool({ name: 'Grep' })]);
    expect(a).toBe(b);
    // 字典序：Grep < Read < Write
    expect(a.indexOf('Grep:')).toBeLessThan(a.indexOf('Read:'));
    expect(a.indexOf('Read:')).toBeLessThan(a.indexOf('Write:'));
  });

  it('对象属性也按名字排序，不跟着 schema 的书写顺序漂', () => {
    const schema = {
      type: 'object',
      properties: { zeta: { type: 'string' }, alpha: { type: 'number' } },
      required: ['zeta', 'alpha'],
    } as JSONSchema;
    const out = renderToolsSdk([tool({ name: 'T', inputSchema: schema })]);
    expect(out.indexOf('alpha:')).toBeLessThan(out.indexOf('zeta:'));
  });

  it('空工具集产出结构完整的空声明（不是空字符串）', () => {
    const out = renderToolsSdk([]);
    expect(out).toContain('interface ToolArgsMap {}');
    expect(out).toContain('interface ToolOutputMap {}');
    expect(out).toContain('declare const tools');
  });
});

describe('renderToolsSdk · 类型映射', () => {
  it('标量与数组按受支持子集映射', () => {
    const out = renderToolsSdk([
      tool({
        name: 'T',
        inputSchema: {
          type: 'object',
          properties: {
            s: { type: 'string' },
            n: { type: 'number' },
            b: { type: 'boolean' },
            list: { type: 'array', items: { type: 'string' } },
          },
          required: ['s', 'n', 'b', 'list'],
        } as JSONSchema,
        outputSchema: { type: 'boolean' } as JSONSchema,
      }),
    ]);

    expect(out).toContain('s: string;');
    expect(out).toContain('n: number;');
    expect(out).toContain('b: boolean;');
    expect(out).toContain('list: string[];');
    expect(out).toContain('T: boolean;');
  });

  it('required 之外的属性标可选', () => {
    const out = renderToolsSdk([
      tool({
        name: 'T',
        inputSchema: {
          type: 'object',
          properties: { must: { type: 'string' }, maybe: { type: 'string' } },
          required: ['must'],
        } as JSONSchema,
      }),
    ]);
    expect(out).toContain('must: string;');
    expect(out).toContain('maybe?: string;');
  });

  it('对象数组用 Array<{...}> 而不是 {...}[]', () => {
    const out = renderToolsSdk([
      tool({
        name: 'T',
        outputSchema: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        } as JSONSchema,
      }),
    ]);
    expect(out).toContain('Array<{');
  });

  it('integer 映射成 number（入参侧真实存在，TS 里就是 number）', () => {
    const out = renderToolsSdk([
      tool({
        name: 'T',
        inputSchema: {
          type: 'object',
          properties: { line: { type: 'integer' } },
          required: ['line'],
        } as JSONSchema,
      }),
    ]);
    expect(out).toContain('line: number;');
  });

  it('enum 渲染成字面量联合，不退回 string（真实目录里 99 处）', () => {
    const out = renderToolsSdk([
      tool({
        name: 'T',
        inputSchema: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['create', 'update', 'delete'] } },
          required: ['action'],
        } as JSONSchema,
      }),
    ]);
    expect(out).toContain('action: "create" | "update" | "delete";');
  });

  it('数组形态的 type 渲染成联合', () => {
    const out = renderToolsSdk([
      tool({
        name: 'T',
        inputSchema: {
          type: 'object',
          properties: { sheet: { type: ['string', 'number'] } },
          required: ['sheet'],
        } as unknown as JSONSchema,
      }),
    ]);
    expect(out).toContain('sheet: string | number;');
  });

  it('入参侧的自由数组降成 unknown[] 而不是 unknown（保住「这是数组」）', () => {
    const out = renderToolsSdk([
      tool({
        name: 'T',
        inputSchema: {
          type: 'object',
          properties: { operations: { type: 'array' } },
        } as JSONSchema,
      }),
    ]);
    expect(out).toContain('operations?: unknown[]');
    expect(out).toContain('未声明元素形状');
  });

  it('入参侧的自由对象降级但留痕，不静默换宽类型', () => {
    const out = renderToolsSdk([
      tool({
        name: 'T',
        inputSchema: {
          type: 'object',
          properties: { metadata: { type: 'object' } },
        } as JSONSchema,
      }),
    ]);
    expect(out).toContain('Record<string, unknown>');
    expect(out).toContain('未声明具体形状');
  });

  it('工具 description 变成 JSDoc 挂在入参上，不丢失', () => {
    const out = renderToolsSdk([tool({ name: 'Read', description: '读取一个文件' })]);
    expect(out).toContain('/** 读取一个文件 */');
  });

  it('多行 description 渲染成多行 JSDoc', () => {
    const out = renderToolsSdk([tool({ name: 'T', description: '第一行\n第二行' })]);
    expect(out).toContain('   * 第一行');
    expect(out).toContain('   * 第二行');
  });

  it('非法标识符的工具名加引号（脚本得写 tools["my-tool"]）', () => {
    const out = renderToolsSdk([tool({ name: 'my-tool' })]);
    expect(out).toContain('"my-tool":');
  });
});

describe('renderToolsSdk · 集合外形状必须抛，不静默降级', () => {
  it.each([
    ['未声明 type', { properties: {} }],
    ['null 不在受支持集合里', { type: 'null' }],
    ['object 缺 properties', { type: 'object' }],
    ['array 缺 items', { type: 'array' }],
  ])('%s', (_label, bad) => {
    expect(() => renderToolsSdk([tool({ name: 'T', outputSchema: bad as JSONSchema })])).toThrow();
  });

  it('抛错要指出是哪个工具的哪个字段', () => {
    expect(() =>
      renderToolsSdk([
        tool({
          name: 'Broken',
          outputSchema: {
            type: 'object',
            properties: { bad: { type: 'null' } },
            required: ['bad'],
          } as JSONSchema,
        }),
      ]),
    ).toThrow(/Broken\.outputSchema\.properties\.bad/);
  });
});

describe('renderToolsSdk · 给模型的说明', () => {
  it('把「只有打印或返回的才回到对话」写给模型，不靠系统悄悄裁剪', () => {
    const out = renderToolsSdk([tool({ name: 'T' })]);
    expect(out).toContain('只有你打印或返回的内容会回到对话里');
  });

  it('声明 ToolCallError 带 toolName，脚本才知道能 catch 后继续', () => {
    const out = renderToolsSdk([tool({ name: 'T' })]);
    expect(out).toContain('declare class ToolCallError extends Error');
    expect(out).toContain('readonly toolName: ToolName;');
  });

  it('无损 JSON 约束写进说明（Host 侧会逐次拒绝，模型要提前知道）', () => {
    const out = renderToolsSdk([tool({ name: 'T' })]);
    expect(out).toContain('无损 JSON');
  });
});
