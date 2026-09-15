// ============================================================================
// Domain Routes 原语单测（RQ-183 刀 1）
// ============================================================================
//
// 钉死 registry 三件事的契约：
//   1. defineDomainRoutes 返回可枚举表（channel + actions keys 即集合）；
//   2. installDomainRoutes 的分发语义对齐 session.ipc.ts 现状：未知 action →
//      INVALID_ACTION，handler 抛错 → 领域 code 优先 / INTERNAL_ERROR 兜底；
//   3. 装配前双向防漂移校验：表带 schema 未声明的 action、或表缺 schema 声明的
//      action，都拒绝装配（编译期穷尽之外的运行时兜底）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { channelSchema } from '../../../../src/shared/ipc/schemas/core';
import type { DomainRouteTable } from '../../../../src/shared/ipc/domainRoutes';
import {
  defineDomainRoutes,
  installDomainRoutes,
} from '../../../../src/host/ipc/domainRoutes/registry';

// 结构枚举器挂既有函数对象上（knip 生产档无测试入口，独立 export 必成 dead export）
const { extractDomainActions } = installDomainRoutes;

type Invoke = (event: unknown, raw: unknown) => Promise<unknown>;

function createTarget() {
  const registered = new Map<string, Invoke>();
  return {
    registered,
    target: {
      handle: (channel: string, fn: Invoke) => {
        registered.set(channel, fn);
      },
    },
  };
}

interface TestCtx {
  prefix: string;
}

class DomainTestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// enum-action 最小表形态（与 demo.ts 同款，独立构造保持单测自包含）
const EnumRequestSchema = z.object({
  action: z.enum(['echo', 'ping']),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

// discriminatedUnion 形态（与 admin.ts REQUEST 同族）
const ListReq = z.object({ action: z.literal('list'), payload: z.object({ q: z.string() }) });
const CreateReq = z.object({ action: z.literal('create'), payload: z.object({ name: z.string() }) });
const UnionRequestSchema = z.discriminatedUnion('action', [ListReq, CreateReq]);

const enumTable = defineDomainRoutes(
  channelSchema({ channel: 'domain:test-enum', payload: EnumRequestSchema }),
  {
    // ctx 显式注解：Ctx 在 handler 签名的逆变位，字面量推断不出具体类型
    echo: async (ctx: TestCtx, payload) => ({ message: `${ctx.prefix}:${String(payload ?? '')}` }),
    ping: async (ctx: TestCtx) => ({ pong: ctx.prefix }),
  },
);

const unionTable = defineDomainRoutes(
  channelSchema({ channel: 'domain:test-union', payload: UnionRequestSchema }),
  {
    list: async (ctx: TestCtx, payload) => ({ prefix: ctx.prefix, q: payload?.q }),
    create: async (ctx: TestCtx, payload) => ({ prefix: ctx.prefix, name: payload?.name }),
  },
);

// 编译期棘轮（ai-review Nit 2026-09-14）：enum 单对象表的 payload 类型不得退化为
// undefined（Extract 对非联合请求必得 never 的坑）；退化则 42 赋不进 → tsc-tests 红
type EnumEchoPayload = Parameters<typeof enumTable.actions.echo>[1];
const _enumPayloadProbe: EnumEchoPayload = 42;
void _enumPayloadProbe;

describe('extractDomainActions', () => {
  it('enum-action object 形态：提取 z.enum 字面量集合', () => {
    expect(extractDomainActions(EnumRequestSchema)).toEqual(new Set(['echo', 'ping']));
  });

  it('discriminatedUnion 形态：提取各成员 action 字面量', () => {
    expect(extractDomainActions(UnionRequestSchema)).toEqual(new Set(['list', 'create']));
  });

  it('认不出的形态返回空集合（调用方自举纪律兜底）', () => {
    expect(extractDomainActions(z.string())).toEqual(new Set());
    expect(extractDomainActions(undefined)).toEqual(new Set());
  });
});

describe('defineDomainRoutes', () => {
  it('返回可枚举的表：channel + actions keys 即 action 集合', () => {
    expect(enumTable.channel).toBe('domain:test-enum');
    expect(Object.keys(enumTable.actions).sort()).toEqual(['echo', 'ping']);
  });
});

describe('installDomainRoutes', () => {
  it('按 action 分发，handler 收到注入的 ctx 与 payload，成功走 { success: true, data }', async () => {
    const { registered, target } = createTarget();
    installDomainRoutes(target, enumTable, { prefix: 'neo' });

    const invoke = registered.get('domain:test-enum');
    expect(invoke).toBeDefined();
    await expect(invoke?.(undefined, { action: 'echo', payload: 'hi' })).resolves.toEqual({
      success: true,
      data: { message: 'neo:hi' },
    });
    await expect(invoke?.(undefined, { action: 'ping' })).resolves.toEqual({
      success: true,
      data: { pong: 'neo' },
    });
  });

  it('discriminatedUnion 表的各 action payload 按成员 schema 类型分发', async () => {
    const { registered, target } = createTarget();
    installDomainRoutes(target, unionTable, { prefix: 'neo' });

    await expect(
      registered.get('domain:test-union')?.(undefined, { action: 'list', payload: { q: 'kw' } }),
    ).resolves.toEqual({ success: true, data: { prefix: 'neo', q: 'kw' } });
  });

  it('未知 action → INVALID_ACTION 兜底（对齐 session.ipc.ts 现状语义）', async () => {
    const { registered, target } = createTarget();
    installDomainRoutes(target, enumTable, { prefix: 'neo' });

    await expect(
      registered.get('domain:test-enum')?.(undefined, { action: 'nope' }),
    ).resolves.toEqual({
      success: false,
      error: { code: 'INVALID_ACTION', message: 'Unknown action: nope' },
    });
    // request 缺 action 字段与 request 为 null 同样落兜底
    await expect(registered.get('domain:test-enum')?.(undefined, {})).resolves.toEqual({
      success: false,
      error: { code: 'INVALID_ACTION', message: 'Unknown action: undefined' },
    });
    await expect(registered.get('domain:test-enum')?.(undefined, null)).resolves.toEqual({
      success: false,
      error: { code: 'INVALID_ACTION', message: 'Unknown action: undefined' },
    });
    // Object.prototype 继承键（toString/constructor）不是合法 action，不许被当 handler 分发
    await expect(registered.get('domain:test-enum')?.(undefined, { action: 'toString' })).resolves.toEqual({
      success: false,
      error: { code: 'INVALID_ACTION', message: 'Unknown action: toString' },
    });
    await expect(registered.get('domain:test-enum')?.(undefined, { action: 'constructor' })).resolves.toEqual({
      success: false,
      error: { code: 'INVALID_ACTION', message: 'Unknown action: constructor' },
    });
  });

  it('unknownActionMessage 覆盖默认兜底文案（域错误契约逐字保持）', async () => {
    const table = defineDomainRoutes(
      channelSchema({ channel: 'domain:test-msg', payload: EnumRequestSchema }),
      {
        echo: async () => null,
        ping: async () => null,
      },
      { unknownActionMessage: (action) => `Unknown session action: ${String(action)}` },
    );
    const { registered, target } = createTarget();
    installDomainRoutes(target, table, { prefix: 'neo' });

    await expect(
      registered.get('domain:test-msg')?.(undefined, { action: 'nope' }),
    ).resolves.toEqual({
      success: false,
      error: { code: 'INVALID_ACTION', message: 'Unknown session action: nope' },
    });
  });

  it('handler 抛错 → INTERNAL_ERROR + message（无领域 code 判定时）', async () => {
    const boomTable = defineDomainRoutes(
      channelSchema({ channel: 'domain:test-boom', payload: EnumRequestSchema }),
      {
        echo: async () => {
          throw new Error('kaboom');
        },
        ping: async () => null,
      },
    );
    const { registered, target } = createTarget();
    installDomainRoutes(target, boomTable, { prefix: 'neo' });

    await expect(registered.get('domain:test-boom')?.(undefined, { action: 'echo' })).resolves.toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'kaboom' },
    });
  });

  it('handler 抛领域错误 → resolveErrorCode 命中时传递领域 code（对齐 session.ipc.ts:315-329）', async () => {
    const domainTable = defineDomainRoutes(
      channelSchema({ channel: 'domain:test-code', payload: EnumRequestSchema }),
      {
        echo: async () => {
          throw new DomainTestError('SESSION_FORK_FAILED', 'cannot fork');
        },
        ping: async () => null,
      },
      {
        resolveErrorCode: (error) => (error instanceof DomainTestError ? error.code : undefined),
      },
    );
    const { registered, target } = createTarget();
    installDomainRoutes(target, domainTable, { prefix: 'neo' });

    await expect(registered.get('domain:test-code')?.(undefined, { action: 'echo' })).resolves.toEqual({
      success: false,
      error: { code: 'SESSION_FORK_FAILED', message: 'cannot fork' },
    });
  });

  it('unknownActionCode / mapError / rawResponse：既有域错误契约与带 data 的失败响应逐字透传（DESKTOP 刀）', async () => {
    const table = defineDomainRoutes(
      channelSchema({ channel: 'domain:test-raw', payload: EnumRequestSchema }),
      {
        echo: async () => ({ success: false, error: { code: 'AUDIO_START_FAILED', message: 'no sox' }, data: { capturing: false } }),
        ping: async () => {
          throw 'not-an-error';
        },
      },
      {
        rawResponse: true,
        unknownActionCode: 'UNKNOWN_ACTION',
        mapError: (error, action) => ({ code: 'DESKTOP_ERROR', message: `${String(action)}:${error instanceof Error ? error.message : 'Unknown error'}` }),
      },
    );
    const { registered, target } = createTarget();
    installDomainRoutes(target, table, { prefix: 'neo' });
    const call = registered.get('domain:test-raw');

    await expect(call?.(undefined, { action: 'echo' })).resolves.toEqual({
      success: false,
      error: { code: 'AUDIO_START_FAILED', message: 'no sox' },
      data: { capturing: false },
    });
    await expect(call?.(undefined, { action: 'ping' })).resolves.toEqual({
      success: false,
      error: { code: 'DESKTOP_ERROR', message: 'ping:Unknown error' },
    });
    await expect(call?.(undefined, { action: 'nope' })).resolves.toEqual({
      success: false,
      error: { code: 'UNKNOWN_ACTION', message: 'Unknown action: nope' },
    });
  });

  it('mapError 返回 details 时原样透传；不返回 details 时 error 无 details 键（AGENT_ENGINE 刀）', async () => {
    const table = defineDomainRoutes(
      channelSchema({ channel: 'domain:test-details', payload: EnumRequestSchema }),
      {
        echo: async () => {
          throw Object.assign(new Error('no fork'), { engine: 'codex' });
        },
        ping: async () => {
          throw new Error('plain');
        },
      },
      {
        rawResponse: true,
        mapError: (error) => (
          error instanceof Error && 'engine' in error
            ? { code: 'CAPABILITY_UNSUPPORTED', message: error.message, details: { engine: error.engine } }
            : { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) }
        ),
      },
    );
    const { registered, target } = createTarget();
    installDomainRoutes(target, table, { prefix: 'neo' });
    const call = registered.get('domain:test-details');

    await expect(call?.(undefined, { action: 'echo' })).resolves.toEqual({
      success: false,
      error: { code: 'CAPABILITY_UNSUPPORTED', message: 'no fork', details: { engine: 'codex' } },
    });
    const plain = await call?.(undefined, { action: 'ping' }) as { error: Record<string, unknown> };
    expect(plain.error).toEqual({ code: 'INTERNAL_ERROR', message: 'plain' });
    expect(Object.keys(plain.error)).toEqual(['code', 'message']);
  });

  it('guard：分发前拦截（未知 action 也先过门）；放行后照常分发；门抛错走错误映射（PROMPT 刀）；门收到装配 ctx（TASK 刀）', async () => {
    let mode: 'block' | 'pass' | 'throw' = 'block';
    let seenCtx: unknown;
    const table = defineDomainRoutes(
      channelSchema({ channel: 'domain:test-guard', payload: EnumRequestSchema }),
      { echo: async () => 'echoed', ping: async () => null },
      {
        guard: (action, ctx) => {
          seenCtx = ctx;
          if (mode === 'throw') throw new Error(`guard boom ${String(action)}`);
          return mode === 'block' ? { success: false, error: { code: 'FORBIDDEN', message: 'nope' } } : null;
        },
      },
    );
    const { registered, target } = createTarget();
    installDomainRoutes(target, table, { prefix: 'neo' });
    const call = registered.get('domain:test-guard');

    await expect(call?.(undefined, { action: 'echo' })).resolves.toEqual({ success: false, error: { code: 'FORBIDDEN', message: 'nope' } });
    await expect(call?.(undefined, { action: 'bogus' })).resolves.toEqual({ success: false, error: { code: 'FORBIDDEN', message: 'nope' } });
    mode = 'pass';
    await expect(call?.(undefined, { action: 'echo' })).resolves.toEqual({ success: true, data: 'echoed' });
    await expect(call?.(undefined, { action: 'bogus' })).resolves.toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
    mode = 'throw';
    await expect(call?.(undefined, { action: 'echo' })).resolves.toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'guard boom echo' } });
    expect(seenCtx).toEqual({ prefix: 'neo' });
  });

  it('guard 收到请求 payload（SETTINGS 刀：门按 payload 判定）；未知 action 与缺 payload 同样传入', async () => {
    const seen: unknown[] = [];
    const table = defineDomainRoutes(
      channelSchema({ channel: 'domain:test-guard-payload', payload: EnumRequestSchema }),
      { echo: async () => 'echoed', ping: async () => null },
      {
        guard: (_action, _ctx, payload) => {
          seen.push(payload);
          return (payload as { admin?: boolean } | undefined)?.admin ? { success: false, error: { code: 'FORBIDDEN', message: 'admin only' } } : null;
        },
      },
    );
    const { registered, target } = createTarget();
    installDomainRoutes(target, table, { prefix: 'neo' });
    const call = registered.get('domain:test-guard-payload');

    await expect(call?.(undefined, { action: 'echo', payload: { admin: true } })).resolves.toEqual({ success: false, error: { code: 'FORBIDDEN', message: 'admin only' } });
    await expect(call?.(undefined, { action: 'echo', payload: { admin: false } })).resolves.toEqual({ success: true, data: 'echoed' });
    await expect(call?.(undefined, { action: 'bogus', payload: { admin: true } })).resolves.toEqual({ success: false, error: { code: 'FORBIDDEN', message: 'admin only' } });
    await call?.(undefined, { action: 'echo' });
    expect(seen).toEqual([{ admin: true }, { admin: false }, { admin: true }, undefined]);
  });

  it('表带 schema 未声明的 action → 拒绝装配', () => {
    const { target } = createTarget();
    const drifted = {
      ...enumTable,
      actions: { ...enumTable.actions, bogus: async () => null },
    } as DomainRouteTable<{ action: string }, TestCtx>;

    expect(() => installDomainRoutes(target, drifted, { prefix: 'neo' })).toThrow(
      /bogus/,
    );
  });

  it('表缺 schema 声明的 action → 拒绝装配（对称兜底）', () => {
    const { target } = createTarget();
    const { ping, ...partial } = enumTable.actions;
    void ping;
    const drifted = { ...enumTable, actions: partial } as DomainRouteTable<
      { action: string },
      TestCtx
    >;

    expect(() => installDomainRoutes(target, drifted, { prefix: 'neo' })).toThrow(/ping/);
  });

  it('schema 提取到 0 个 action → 拒绝装配（自举纪律）', () => {
    const { target } = createTarget();
    const unrecognized = defineDomainRoutes(
      channelSchema({ channel: 'domain:test-bad-schema', payload: z.string() as unknown as z.ZodType<{ action: string }> }),
      {} as never,
    );

    expect(() => installDomainRoutes(target, unrecognized, { prefix: 'neo' })).toThrow(/0 个 action/);
  });
});
