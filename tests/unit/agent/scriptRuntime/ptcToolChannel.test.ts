// PTC（Code Mode）工具通道：脚本直接调工具，不为每次调用起一个子 agent。
//
// 这里守三件事，每件都对应一处「拿掉就该变红」的把关：
//   1. 名单在 Host 侧二次判定 —— child 是半信任方，它发来的工具名不作数
//   2. 入参必须无损 JSON —— v8.serialize 能带过来 JSON 表达不了的东西
//   3. 失败带 toolName 回传 —— child 据此造 ToolCallError，脚本能 try/catch 后继续
import { describe, expect, it, vi } from 'vitest';
import { handleRpc } from '../../../../src/host/agent/scriptRuntime/primitives';
import { runScriptInSandbox } from '../../../../src/host/agent/scriptRuntime/sandbox';
import type { ScriptRunContext } from '../../../../src/host/agent/scriptRuntime/agentBridge';
import type { RpcRequest } from '../../../../src/host/agent/scriptRuntime/types';

/** 给 vi.fn 用的显式签名——无类型参数时它推断成空元组，mock.calls[0][0] 取不到。 */
type ExecuteTool = NonNullable<ScriptRunContext['executeTool']>;

function toolRequest(name: string, args: unknown): RpcRequest {
  return { id: 1, kind: 'tool', payload: { name, args } as never };
}

function makeCtx(overrides: Partial<ScriptRunContext> = {}): ScriptRunContext {
  return {
    signal: new AbortController().signal,
    budget: { spent: () => 0 },
    emit: () => {},
    ...overrides,
  } as unknown as ScriptRunContext;
}

describe('PTC 工具通道 · Host 侧把关', () => {
  it('名单外的工具报 UNKNOWN_TOOL，并带 toolName 回传', async () => {
    const executeTool = vi.fn();
    const res = await handleRpc(
      toolRequest('Bash', { command: 'echo hi' }),
      makeCtx({ executeTool, visibleToolNames: ['Read', 'Grep'] }),
    );

    expect(res.ok).toBe(false);
    expect(res.error).toContain('UNKNOWN_TOOL');
    expect(res.toolName).toBe('Bash');
    // 关键：没有落到执行层——「不在名单里」要在管线之前就拒掉
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('未注入 executeTool 时整条通道关闭（fail-closed）', async () => {
    const res = await handleRpc(
      toolRequest('Read', { path: '/tmp/x' }),
      makeCtx({ visibleToolNames: ['Read'] }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('UNKNOWN_TOOL');
  });

  it('缺工具名的请求直接拒', async () => {
    const res = await handleRpc(
      toolRequest('', {}),
      makeCtx({ executeTool: vi.fn(), visibleToolNames: ['Read'] }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('缺少工具名');
  });

  it('名单内 + 合法入参 → 送进注入的工具管线，产出原样回传', async () => {
    const executeTool = vi.fn<ExecuteTool>(async () => ({ ok: true as const, value: { lines: 3 } }));
    const res = await handleRpc(
      toolRequest('Read', { path: '/tmp/x', limit: 3 }),
      makeCtx({ executeTool, visibleToolNames: ['Read'] }),
    );

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ lines: 3 });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0]).toMatchObject({
      name: 'Read',
      args: { path: '/tmp/x', limit: 3 },
    });
  });

  it('工具执行失败时带 toolName 回传（child 据此造 ToolCallError）', async () => {
    const executeTool = vi.fn(async () => ({ ok: false as const, error: '权限被拒绝' }));
    const res = await handleRpc(
      toolRequest('Write', { path: '/etc/passwd' }),
      makeCtx({ executeTool, visibleToolNames: ['Write'] }),
    );

    expect(res.ok).toBe(false);
    expect(res.toolName).toBe('Write');
    expect(res.error).toContain('权限被拒绝');
  });

  // 无损 JSON：每一条都是 JSON 往返会静默改值或抛错的形态
  it.each([
    ['undefined 字段', { path: '/tmp/x', extra: undefined }, 'undefined'],
    ['BigInt', { size: 1n }, 'bigint'],
    ['NaN', { n: Number.NaN }, 'NaN'],
    ['Infinity', { n: Number.POSITIVE_INFINITY }, 'Infinity'],
    ['-0', { n: -0 }, '-0'],
    ['函数', { fn: () => 1 }, 'function'],
    ['Date 对象', { at: new Date(0) }, 'Date'],
    ['Map', { m: new Map() }, 'Map'],
  ])('拒绝入参里的 %s', async (_label, args, expectedFragment) => {
    const executeTool = vi.fn();
    const res = await handleRpc(
      toolRequest('Read', args),
      makeCtx({ executeTool, visibleToolNames: ['Read'] }),
    );

    expect(res.ok).toBe(false);
    expect(res.error).toContain('无损 JSON');
    expect(res.error).toContain(expectedFragment);
    expect(res.toolName).toBe('Read');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('拒绝循环引用', async () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    const res = await handleRpc(
      toolRequest('Read', cyclic),
      makeCtx({ executeTool: vi.fn(), visibleToolNames: ['Read'] }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('循环引用');
  });

  it('拒绝稀疏数组的洞（JSON 往返会变成 null）', async () => {
    // 显式造洞而不写 [1, , 3] 字面量——后者触发 no-sparse-arrays，语义一样
    const sparse: unknown[] = [];
    sparse[0] = 1;
    sparse[2] = 3;
    const res = await handleRpc(
      toolRequest('Read', { items: sparse }),
      makeCtx({ executeTool: vi.fn(), visibleToolNames: ['Read'] }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('undefined');
  });

  it('嵌套结构逐层检查，报出出问题的路径', async () => {
    const res = await handleRpc(
      toolRequest('Read', { a: { b: [{ c: undefined }] } }),
      makeCtx({ executeTool: vi.fn(), visibleToolNames: ['Read'] }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('args.a.b[0].c');
  });

  it('缺省入参当空对象处理，不误伤无参工具', async () => {
    const executeTool = vi.fn<ExecuteTool>(async () => ({ ok: true as const, value: 'ok' }));
    const res = await handleRpc(
      toolRequest('ListTasks', undefined),
      makeCtx({ executeTool, visibleToolNames: ['ListTasks'] }),
    );
    expect(res.ok).toBe(true);
    expect(executeTool.mock.calls[0][0]).toMatchObject({ args: {} });
  });
});

describe('PTC 工具通道 · child 侧命名空间（真进程）', () => {
  function run(script: string, toolNames: string[], onTool: (name: string, args: unknown) => unknown) {
    return runScriptInSandbox({
      script,
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      useOsSandbox: false,
      toolNames,
      onRpc: async (req) => {
        if (req.kind !== 'tool') return { id: req.id, ok: true, result: null };
        const payload = req.payload as { name: string; args: unknown };
        try {
          return { id: req.id, ok: true, result: onTool(payload.name, payload.args) };
        } catch (error) {
          return {
            id: req.id,
            ok: false,
            toolName: payload.name,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
  }

  it('脚本能 await tools.<name>(args) 拿到产出', async () => {
    const outcome = await run(
      `const a = await tools.Read({ path: '/tmp/a' });
       const b = await tools.Grep({ pattern: 'x' });
       return { a, b };`,
      ['Read', 'Grep'],
      (name, args) => ({ name, args }),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      a: { name: 'Read', args: { path: '/tmp/a' } },
      b: { name: 'Grep', args: { pattern: 'x' } },
    });
  });

  it('大中间值留在 child 内处理，不套外层输出字节上限', async () => {
    const intermediate = 'x'.repeat(9 * 1024 * 1024);
    const outcome = await run(
      `const value = await tools.Read({ path: '/tmp/large' }); return value.length;`,
      ['Read'],
      () => intermediate,
    );

    expect(outcome).toEqual({ ok: true, result: intermediate.length });
  }, 20_000);

  it('失败的调用 reject 成 ToolCallError（带 toolName），脚本可 catch 后继续', async () => {
    const outcome = await run(
      `let caught;
       try { await tools.Write({ path: '/etc/passwd' }); }
       catch (error) {
         caught = {
           isToolCallError: error instanceof ToolCallError,
           name: error.name,
           toolName: error.toolName,
           message: error.message,
         };
       }
       const after = await tools.Read({ path: '/tmp/ok' });
       return { caught, after };`,
      ['Read', 'Write'],
      (name) => {
        if (name === 'Write') throw new Error('审批被拒绝');
        return 'still running';
      },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      caught: {
        isToolCallError: true,
        name: 'ToolCallError',
        toolName: 'Write',
        message: '审批被拒绝',
      },
      // 关键：一次失败不掐断整个程序
      after: 'still running',
    });
  });

  it('未开放工具时 tools 是空对象，调用即 TypeError（不静默变 no-op）', async () => {
    const onTool = vi.fn();
    const outcome = await run(
      `try { await tools.Read({}); return 'no-throw'; }
       catch (error) { return error instanceof TypeError ? 'TypeError' : String(error); }`,
      [],
      onTool,
    );

    expect(outcome.result).toBe('TypeError');
    expect(onTool).not.toHaveBeenCalled();
  });

  it('名单外的名字够不着，且 tools 命名空间无原型链可绕', async () => {
    const outcome = await run(
      `return {
         unlisted: typeof tools.Bash,
         proto: Object.getPrototypeOf(tools),
         hasToString: typeof tools.toString,
         frozen: Object.isFrozen(tools),
         keys: Object.keys(tools),
       };`,
      ['Read'],
      () => 'never',
    );

    expect(outcome.result).toEqual({
      unlisted: 'undefined',
      proto: null,
      // Object.create(null) 起手 ⇒ 连 Object.prototype 的东西都摸不到
      hasToString: 'undefined',
      frozen: true,
      keys: ['Read'],
    });
  });

  it('legacy worker 路径开着 PTC 时 fail-loud，不静默把 tools 变成 undefined', async () => {
    const outcome = await runScriptInSandbox({
      script: 'return 1;',
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      useOsSandbox: false,
      legacyWorkerFallback: true,
      toolNames: ['Read'],
      onRpc: async (req) => ({ id: req.id, ok: true, result: null }),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('legacy worker 路径不支持 PTC 工具通道');
  });

  it('工具 stub 不可被脚本改写或删除', async () => {
    const outcome = await run(
      `const results = {};
       try { tools.Read = () => 'hijacked'; results.assign = 'no-throw'; }
       catch (error) { results.assign = 'TypeError'; }
       try { delete tools.Read; results.delete = 'no-throw'; }
       catch (error) { results.delete = 'TypeError'; }
       results.value = await tools.Read({});
       return results;`,
      ['Read'],
      () => 'real',
    );

    // strict mode 下改只读属性抛 TypeError；无论抛不抛，值必须还是真的那个
    expect((outcome.result as Record<string, unknown>).value).toBe('real');
  });
});
