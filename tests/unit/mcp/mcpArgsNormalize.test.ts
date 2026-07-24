import { describe, expect, it } from 'vitest';
import { normalizeMcpToolArgs } from '../../../src/host/mcp/mcpArgsNormalize';

const FIELD_LIST = 'bitable.v1.appTableField.list';

describe('normalizeMcpToolArgs — 飞书 field.list path 重嵌', () => {
  it('把顶层拍平的 app_token/table_id 重新包回 path', () => {
    const out = normalizeMcpToolArgs('lark', FIELD_LIST, {
      app_token: 'appXXX',
      table_id: 'tblYYY',
    });
    expect(out).toEqual({ path: { app_token: 'appXXX', table_id: 'tblYYY' } });
  });

  it('把塞进 params 的 app_token/table_id 重新包回 path，保留 params 其余键', () => {
    const out = normalizeMcpToolArgs('lark', FIELD_LIST, {
      params: { app_token: 'appXXX', table_id: 'tblYYY', page_size: 50 },
    });
    expect(out).toEqual({
      path: { app_token: 'appXXX', table_id: 'tblYYY' },
      params: { page_size: 50 },
    });
  });

  it('顶层与 path 混合：顶层缺失键从 path 已有值不被覆盖', () => {
    const out = normalizeMcpToolArgs('lark', FIELD_LIST, {
      app_token: 'appTOP',
      path: { table_id: 'tblIN' },
    });
    expect(out).toEqual({ path: { app_token: 'appTOP', table_id: 'tblIN' } });
  });

  it('已摆对 path 的入参 no-op（返回同一引用）', () => {
    const args = { path: { app_token: 'appXXX', table_id: 'tblYYY' }, params: { page_size: 50 } };
    const out = normalizeMcpToolArgs('lark', FIELD_LIST, args);
    expect(out).toBe(args);
  });

  it('path 已在但缺 table_id：从顶层补齐', () => {
    const out = normalizeMcpToolArgs('lark', FIELD_LIST, {
      table_id: 'tblYYY',
      path: { app_token: 'appXXX' },
    });
    expect(out).toEqual({ path: { app_token: 'appXXX', table_id: 'tblYYY' } });
  });

  it('顶层优先于 params（同键都在时取顶层，params 内该键仍被剥离）', () => {
    const out = normalizeMcpToolArgs('lark', FIELD_LIST, {
      app_token: 'appTOP',
      table_id: 'tblTOP',
      params: { app_token: 'appPARAM', table_id: 'tblPARAM', page_size: 20 },
    });
    expect(out).toEqual({
      path: { app_token: 'appTOP', table_id: 'tblTOP' },
      params: { app_token: 'appPARAM', table_id: 'tblPARAM', page_size: 20 },
    });
  });

  it('非飞书 field.list 工具：原样透传（同一引用）', () => {
    const recordSearch = { app_token: 'appXXX', table_id: 'tblYYY' };
    expect(normalizeMcpToolArgs('lark', 'bitable.v1.appTableRecord.search', recordSearch)).toBe(recordSearch);

    const other = { foo: 1 };
    expect(normalizeMcpToolArgs('github', 'search_code', other)).toBe(other);
  });

  it('field.list 但无 app_token/table_id 可搬：no-op', () => {
    const args = { params: { page_size: 50 } };
    expect(normalizeMcpToolArgs('lark', FIELD_LIST, args)).toBe(args);
  });
});
