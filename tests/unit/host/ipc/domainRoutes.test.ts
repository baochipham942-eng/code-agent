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
  extractDomainActions,
  installDomainRoutes,
} from '../../../../src/host/ipc/domainRoutes/registry';

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
    echo: async (ctx, payload) => ({ message: `${ctx.prefix}:${String(payload ?? '')}` }),
    ping: async (ctx) => ({ pong: ctx.prefix }),
  },
);

const unionTable = defineDomainRoutes(
  channelSchema({ channel: 'domain:test-union', payload: UnionRequestSchema }),
  {
    list: async (ctx, payload) => ({ prefix: ctx.prefix, q: payload?.q }),
    create: async (ctx, payload) => ({ prefix: ctx.prefix, name: payload?.name }),
  },
);

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
