import { describe, expect, it } from 'vitest';
import { validateToolInputSchema } from '../../../src/host/tools/toolSchemaValidator';
import { notebookEditSchema } from '../../../src/host/tools/modules/file/notebookEdit.schema';
import { mcpInvokeSchema } from '../../../src/host/tools/modules/mcp/mcpInvoke.schema';
import { visualEditSchema } from '../../../src/host/tools/modules/vision/visualEdit.schema';
import { toolSearchSchema } from '../../../src/host/tools/modules/search/toolSearch.schema';
import { recommendCapabilitySchema } from '../../../src/host/tools/modules/planning/recommendCapability.schema';
import { webSearchSchema } from '../../../src/host/tools/modules/network/webSearch.schema';

// §1.3：被删的 9 处手写校验，坏输入现在必须由 schema 层接住
// （不是“没报错”，是“换个地方报”）。逐条对照工单删除清单。

describe('§1.3 deleted inline validations are covered by inputSchema', () => {
  it('#1 notebook_edit: missing notebook_path reported by schema', () => {
    const issues = validateToolInputSchema(notebookEditSchema.inputSchema, { new_source: 'x' });
    expect(issues.some((i) => i.field_path === 'notebook_path' && i.category === 'missing_required')).toBe(true);
  });

  it('#1 notebook_edit: non-string notebook_path reported by schema', () => {
    const issues = validateToolInputSchema(notebookEditSchema.inputSchema, { notebook_path: 42, new_source: 'x' });
    expect(issues.some((i) => i.field_path === 'notebook_path' && i.category === 'type_mismatch')).toBe(true);
  });

  it('#2 notebook_edit: missing new_source reported by schema', () => {
    const issues = validateToolInputSchema(notebookEditSchema.inputSchema, { notebook_path: '/tmp/a.ipynb' });
    expect(issues.some((i) => i.field_path === 'new_source' && i.category === 'missing_required')).toBe(true);
  });

  it('#3 mcp_invoke: missing server/tool reported by schema', () => {
    const issues = validateToolInputSchema(mcpInvokeSchema.inputSchema, {});
    expect(issues.some((i) => i.field_path === 'server' && i.category === 'missing_required')).toBe(true);
    expect(issues.some((i) => i.field_path === 'tool' && i.category === 'missing_required')).toBe(true);
  });

  it('#4 visual_edit: missing file reported by schema', () => {
    const issues = validateToolInputSchema(visualEditSchema.inputSchema, { line: 1, userIntent: '改色' });
    expect(issues.some((i) => i.field_path === 'file' && i.category === 'missing_required')).toBe(true);
  });

  it('#5 visual_edit: line 0 / -1 / 1.5 reported by schema', () => {
    for (const bad of [0, -1, 1.5]) {
      const issues = validateToolInputSchema(visualEditSchema.inputSchema, { file: '/tmp/a.ts', line: bad, userIntent: 'x' });
      expect(issues.length, `line=${bad} should be rejected`).toBeGreaterThan(0);
      expect(issues.some((i) => i.field_path === 'line')).toBe(true);
    }
  });

  it('#5 visual_edit: positive integer line passes schema', () => {
    const issues = validateToolInputSchema(visualEditSchema.inputSchema, { file: '/tmp/a.ts', line: 3, userIntent: 'x' });
    expect(issues).toHaveLength(0);
  });

  it('#6 visual_edit: empty / whitespace-only userIntent reported by schema', () => {
    for (const bad of ['', '   ']) {
      const issues = validateToolInputSchema(visualEditSchema.inputSchema, { file: '/tmp/a.ts', line: 1, userIntent: bad });
      expect(issues.some((i) => i.field_path === 'userIntent' && i.category === 'constraint_violation')).toBe(true);
    }
  });

  it('#7 ToolSearch: empty / whitespace-only query reported by schema', () => {
    for (const bad of ['', '   ', 42, undefined]) {
      const issues = validateToolInputSchema(toolSearchSchema.inputSchema, { query: bad });
      expect(issues.length, `query=${String(bad)} should be rejected`).toBeGreaterThan(0);
      expect(issues.some((i) => i.field_path === 'query')).toBe(true);
    }
  });

  it('#8 recommend_capability: empty / whitespace-only requiredCapability reported by schema', () => {
    for (const bad of ['', '   ']) {
      const issues = validateToolInputSchema(recommendCapabilitySchema.inputSchema, { requiredCapability: bad });
      expect(issues.some((i) => i.field_path === 'requiredCapability' && i.category === 'constraint_violation')).toBe(true);
    }
    const missing = validateToolInputSchema(recommendCapabilitySchema.inputSchema, {});
    expect(missing.some((i) => i.field_path === 'requiredCapability' && i.category === 'missing_required')).toBe(true);
  });

  it('#9 WebSearch: missing / empty query reported by schema', () => {
    const missing = validateToolInputSchema(webSearchSchema.inputSchema, {});
    expect(missing.some((i) => i.field_path === 'query' && i.category === 'missing_required')).toBe(true);
    const empty = validateToolInputSchema(webSearchSchema.inputSchema, { query: '' });
    expect(empty.some((i) => i.field_path === 'query' && i.category === 'constraint_violation')).toBe(true);
  });
});
