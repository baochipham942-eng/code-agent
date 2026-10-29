import { describe, expect, it, vi, afterEach } from 'vitest';
import { normalizeMcpToolArgs } from '../../../src/host/mcp/mcpArgsNormalize';
import { traceMcpArgsNormalized } from '../../../src/host/mcp/mcpCallTrace';
import { MCPClient } from '../../../src/host/mcp/mcpClient';
import { getTelemetryService } from '../../../src/host/telemetry/telemetryService';

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

describe('traceMcpArgsNormalized — 改写留痕（N-CONNECTOR-POLISH-AUDIT-FU5）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('改写发生：恰一条 mcp.args_normalized，只带键名不带值', () => {
    const addSpanEvent = vi.spyOn(getTelemetryService(), 'addSpanEvent');
    const original = { app_token: 'secret-ish-token', table_id: 'tblYYY' };
    const normalized = normalizeMcpToolArgs('lark', FIELD_LIST, original);
    expect(normalized).not.toBe(original);

    traceMcpArgsNormalized('span-1', 'lark', FIELD_LIST, original, normalized);

    expect(addSpanEvent).toHaveBeenCalledTimes(1);
    const [spanId, eventName, attrs] = addSpanEvent.mock.calls[0];
    expect(spanId).toBe('span-1');
    expect(eventName).toBe('mcp.args_normalized');
    expect(attrs).toMatchObject({ 'mcp.server': 'lark', 'mcp.tool': FIELD_LIST });
    // 只有顶层键名（app_token/table_id 被搬走、path 新增），绝不出现参数值
    expect(attrs?.['mcp.args_changed_keys']).toBe('app_token,path,table_id');
    expect(JSON.stringify(attrs)).not.toContain('secret-ish-token');
  });

  it('引用相等（无改写）：不发事件', () => {
    const addSpanEvent = vi.spyOn(getTelemetryService(), 'addSpanEvent');
    const args = { path: { app_token: 'a', table_id: 'b' } };

    traceMcpArgsNormalized('span-1', 'lark', FIELD_LIST, args, args);

    expect(addSpanEvent).not.toHaveBeenCalled();
  });

  it('spanId 缺失：不抛（tracing 不可用不影响执行）', () => {
    const original = { app_token: 'a', table_id: 'b' };
    const normalized = { path: { app_token: 'a', table_id: 'b' } };
    expect(() => traceMcpArgsNormalized(undefined, 'lark', FIELD_LIST, original, normalized)).not.toThrow();
  });

  it('接线：mcpClient.callTool 在 registry 改写入参时发出该事件（变异守卫）', async () => {
    // 这条走真 callTool 包装（span + normalize + trace 接线），不是直测 helper——
    // 反向变异（删掉 callTool 里的 traceMcpArgsNormalized 调用）必须红在这一条上。
    const client = new MCPClient();
    const addSpanEvent = vi.spyOn(getTelemetryService(), 'addSpanEvent');
    vi.spyOn((client as unknown as { registry: { normalizeToolArgs: unknown } }).registry, 'normalizeToolArgs')
      .mockReturnValue({ path: { app_token: 'a', table_id: 'b' } });
    (client as unknown as { callToolInternal: unknown }).callToolInternal = vi.fn(async () => ({
      success: true, output: 'ok',
    }));

    await client.callTool('call-1', 'lark', FIELD_LIST, { app_token: 'a', table_id: 'b' });

    const call = addSpanEvent.mock.calls.find(([, name]) => name === 'mcp.args_normalized');
    expect(call).toBeDefined();
    expect(call?.[0]).toEqual(expect.any(String));
    expect(JSON.stringify(call?.[2])).not.toContain('app_token\":\"a');
  });
});
