import { describe, expect, it } from 'vitest';
import {
  formatSchemaForModel,
  validateToolArgs,
} from '../../../src/host/agent/runtime/toolArgsValidator';
import type { JSONSchema, JSONSchemaProperty } from '../../../src/shared/contract';
import { writeSchema } from '../../../src/host/tools/modules/file/write.schema';
import { bashSchema } from '../../../src/host/tools/modules/shell/bash.schema';

const props: Record<string, JSONSchemaProperty> = {
  path: { type: 'string', description: '文件绝对路径' },
  content: { type: 'string' },
  append: { type: 'boolean', description: '是否追加' },
};

describe('formatSchemaForModel', () => {
  it('renders every field with the full-schema header by default', () => {
    const lines = formatSchemaForModel(props, ['path', 'content']);
    expect(lines[0]).toBe('完整参数 schema：');
    expect(lines).toContain('  - `path`: string (必填) — 文件绝对路径');
    expect(lines).toContain('  - `content`: string (必填)');
    expect(lines).toContain('  - `append`: boolean (可选) — 是否追加');
  });

  it('lists only required fields and the field count when requiredOnly is set', () => {
    const lines = formatSchemaForModel(props, ['path'], true);
    expect(lines[0]).toBe('参数 schema（共 3 个参数，只列必填）：');
    expect(lines.join('\n')).toContain('`path`: string (必填)');
    // 可选字段在 requiredOnly 模式下被省略
    expect(lines.join('\n')).not.toContain('`content`');
    expect(lines.join('\n')).not.toContain('`append`');
  });

  it('falls back to "any" for fields without a declared type', () => {
    // 故意构造缺 type 的畸形 schema（真实数据可能来自旧版/第三方 MCP schema），
    // 测的就是运行时兜底成 "any"；JSONSchemaProperty.type 是必填字段，这里按
    // 已知的"缺字段"输入形状断言。
    const lines = formatSchemaForModel({ x: { description: 'no type' } as JSONSchemaProperty }, []);
    expect(lines.join('\n')).toContain('`x`: any (可选) — no type');
  });
});

describe('validateToolArgs — schema section unchanged (regression)', () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: props,
    required: ['path', 'content'],
  };

  it('still embeds the full schema block on validation failure', () => {
    const result = validateToolArgs('write_file', schema, { append: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 缺 path/content 报错 + 完整 schema 回灌，行为与重构前一致
    expect(result.message).toContain('缺少必填参数 `path`');
    expect(result.message).toContain('缺少必填参数 `content`');
    expect(result.message).toContain('完整参数 schema：');
    expect(result.message).toContain('  - `path`: string (必填) — 文件绝对路径');
    expect(result.message).toContain('</tool-args-validation-error>');
  });
});

// 2026-07-26 真机 trace 实证：模型对 Write 传了 content: ""（合法空文件意图），
// 却被这里的旧逻辑（'' 等同 missing）打回「缺少必填参数 content」——模型的自我诊断
// （"content 不接受空字符串"）是对的，是校验器的谓词错了，不是 Write 的 schema 错了。
// 这两个 describe 用**真实生产 schema**（不是合成 schema）钉住修复覆盖到两个不同工具，
// 证明改的是 validateToolArgs 里那一条共用谓词，不是 Write 的个案 patch。
describe('validateToolArgs — empty string is a valid required value, not "missing" (regression for the 2026-07-26 Write bug)', () => {
  it('Bash description 是可选的用户视角叙事参数', () => {
    const description = bashSchema.inputSchema.properties?.description as { description?: string };
    expect(bashSchema.inputSchema.required).not.toContain('description');
    expect(description.description).toContain('user-facing verb phrase');
    expect(description.description).toContain('same language as the conversation');
  });

  it('Write: content: "" passes validation (真实生产 schema)', () => {
    const result = validateToolArgs('Write', writeSchema.inputSchema, {
      file_path: '/tmp/x.txt',
      content: '',
    });
    expect(result.ok).toBe(true);
  });

  it('Write: content key truly absent still reports missing (别把这条弄丢)', () => {
    const result = validateToolArgs('Write', writeSchema.inputSchema, {
      file_path: '/tmp/x.txt',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('缺少必填参数 `content`');
  });

  it('Bash (另一个工具，证明修复是共用的): command: "" passes validation', () => {
    const result = validateToolArgs('Bash', bashSchema.inputSchema, { command: '' });
    expect(result.ok).toBe(true);
  });

  it('Bash: command key truly absent still reports missing', () => {
    const result = validateToolArgs('Bash', bashSchema.inputSchema, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('缺少必填参数 `command`');
  });
});

// 2026-09-18 夜跑实证（fl-xlsx-chart-report）：read_xlsx 的 sheet 参数声明
// type: ["string","number"]（union），旧 isTypeCompatible 只比单个字符串，数组进了
// 模板字面量变成 "string,number"，任何实参都不等于它 ⇒ 模型 6 次调用全被拒。
// 这组用例钉住 union type 的三类判决 + 文案口径（" | " 连接，与
// toolSchemaValidator.formatExpectedType 一致）。
describe('validateToolArgs — JSON Schema union type (regression for the 2026-09-18 read_xlsx bug)', () => {
  const unionSchema: JSONSchema = {
    type: 'object',
    properties: {
      sheet: { type: ['string', 'number'], description: '工作表名称或索引' },
    },
    required: [],
  };

  it('union type: string 实参通过', () => {
    const result = validateToolArgs('read_xlsx', unionSchema, { sheet: '说明' });
    expect(result.ok).toBe(true);
  });

  it('union type: number 实参通过', () => {
    const result = validateToolArgs('read_xlsx', unionSchema, { sheet: 2 });
    expect(result.ok).toBe(true);
  });

  it('union type: 不在联合里的类型被拒，文案用 " | " 连接', () => {
    const result = validateToolArgs('read_xlsx', unionSchema, { sheet: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('参数 `sheet` 类型错误：期望 string | number，实际是 boolean');
  });

  it('union type 含 integer 时 number 实参通过（integer 兼容规则对数组成员同样适用）', () => {
    const intUnion: JSONSchema = {
      type: 'object',
      properties: { row: { type: ['string', 'integer'] } },
      required: [],
    };
    expect(validateToolArgs('t', intUnion, { row: 7 })).toEqual({ ok: true });
    expect(validateToolArgs('t', intUnion, { row: 'seven' })).toEqual({ ok: true });
  });

  it('formatSchemaForModel 渲染 union type 为 "string | number"', () => {
    const lines = formatSchemaForModel(unionSchema.properties ?? {}, []);
    expect(lines.join('\n')).toContain('`sheet`: string | number (可选) — 工作表名称或索引');
  });
});

// 同一夜跑的第二段症状：模型试参数名 sheet_name，旧校验器对未识别参数名静默跳过
// （if (!propSchema?.type) continue），工具端再静默回落第一个工作表——两头都不吭声，
// 模型拿不到"参数名不存在"的事实。修复：只在 additionalProperties === false 时拒，
// 未声明的 schema 维持 JSON Schema 默认（允许额外键）不误伤存量工具。
describe('validateToolArgs — unknown field names (regression for the 2026-09-18 read_xlsx bug)', () => {
  const closedSchema: JSONSchema = {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      sheet: { type: ['string', 'number'] },
      format: { type: 'string' },
      max_rows: { type: 'number' },
    },
    required: ['file_path'],
    additionalProperties: false,
  };

  it('additionalProperties:false 时未识别参数名被拒并列出全量可接受参数', () => {
    const result = validateToolArgs('read_xlsx', closedSchema, {
      file_path: '/tmp/a.xlsx',
      sheet_name: '说明',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('未识别的参数 `sheet_name`，本工具只接受：file_path, sheet, format, max_rows');
    expect(result.issues).toEqual([
      { field: 'sheet_name', reason: 'unknown_field' },
    ]);
  });

  it('未声明 additionalProperties 时未识别参数名照旧放行（存量工具默认行为不变）', () => {
    const openSchema: JSONSchema = {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    };
    const result = validateToolArgs('legacy_tool', openSchema, {
      file_path: '/tmp/a.xlsx',
      whatever_extra: 'x',
    });
    expect(result.ok).toBe(true);
  });

  it('additionalProperties:true 时未识别参数名也放行', () => {
    const result = validateToolArgs('read_xlsx', { ...closedSchema, additionalProperties: true }, {
      file_path: '/tmp/a.xlsx',
      sheet_name: '说明',
    });
    expect(result.ok).toBe(true);
  });
});
