import { describe, expect, it } from 'vitest';
import {
  formatSchemaForModel,
  validateToolArgs,
} from '../../../src/host/agent/runtime/toolArgsValidator';
import type { JSONSchema, JSONSchemaProperty } from '../../../src/shared/contract';

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
    const lines = formatSchemaForModel({ x: { description: 'no type' } }, []);
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
