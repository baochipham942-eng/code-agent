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
