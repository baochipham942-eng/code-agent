// ============================================================================
// Session 域路由表装配单测（RQ-183 刀 2 / 刀 3）
// ============================================================================
//
// 钉死 web 形态表与桌面形态表的可观察行为：
//   1. 刀 3 补齐的 5 个原 desktop-only gap action（import / search / exportMarkdown /
//      exportDiagnostics / getMemoryContext）在 web 形态走真实现分发到
//      ctx.sessions()（不再是 INVALID_ACTION 桩），参数与响应原样透传；
//   2. 未知 action 的兜底文案两形态各自保持既有错误契约
//      （web: `Unknown session action: x` / 桌面: `Unknown action: x`）；
//   3. 表 handler 的 INVALID_PAYLOAD 校验在触碰 ctx 之前发生；
//   4. 桌面 context 的 AppService 门（未初始化 → 'Services not initialized'）。
// 表/schema/shellCapabilities 三面集合对账与 web:false 棘轮清零由
// tests/scripts/domainRouteParity.test.ts 盯；真实 DB 的端到端行为由
// tests/integration/session/webGapActions.test.ts 盯。
import { describe, expect, it, vi } from 'vitest';
import { installDomainRoutes } from '../../../../src/host/ipc/domainRoutes/registry';
import {
  createDesktopSessionContext,
  defineSessionRoutes,
  sessionRoutes,
} from '../../../../src/host/ipc/domainRoutes/sessionRoutes';
import type { SessionCommandContext } from '../../../../src/host/ipc/domainRoutes/sessionRoutes';

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

/** 只够桩与前置校验用的哑 context：任何 service 面访问都记噪（不该被摸到） */
function createDummyContext(): SessionCommandContext {
  const fail = vi.fn(() => {
    throw new Error('dummy context must not be touched by this action');
  });
  const ctx = {
    sessions: fail,
    ensureBackend: vi.fn(async () => {}),
    listSessions: fail,
    loadSession: fail,
    decorateLoadedSession: vi.fn(async () => {}),
    deleteSession: fail,
    updateSession: fail,
    forkSession: fail,
    rewindConversation: fail,
    restoreConversationRewind: fail,
    invalidateAfterWrite: vi.fn(async () => {}),
    modelOverride: { switchModel: fail, getOverride: fail, clearOverride: fail },
  };
  return ctx as unknown as SessionCommandContext;
}

describe('defineSessionRoutes 表面差异', () => {
  it('全量表 46 个 action，与 web 形态同集合（桩替换的是 handler 不是键）', () => {
    expect(Object.keys(sessionRoutes.actions)).toHaveLength(46);
    expect(Object.keys(defineSessionRoutes('web').actions).sort())
      .toEqual(Object.keys(sessionRoutes.actions).sort());
  });

  it('刀 3 补齐的 4 个 service 型 gap action 在 web 形态分发到 sessions() 并透传响应', async () => {
    const { registered, target } = createTarget();
    const svc = {
      exportSessionDiagnostics: vi.fn(async (sessionId: string) => ({ diagnostics: `diag:${sessionId}` })),
      exportSessionMarkdown: vi.fn(async (sessionId: string) => ({ markdown: `md:${sessionId}` })),
      getMemoryContext: vi.fn(async (sessionId: string) => ({ memory: `ctx:${sessionId}` })),
      importSession: vi.fn(async (data: unknown) => `imported:${String(data)}`),
    };
    installDomainRoutes(target, defineSessionRoutes('web'), {
      ...createDummyContext(),
      sessions: async () => svc,
    } as unknown as SessionCommandContext);
    const invoke = registered.get('domain:session');

    await expect(invoke?.(undefined, { action: 'exportDiagnostics', payload: { sessionId: 's1' } }))
      .resolves.toEqual({ success: true, data: { diagnostics: 'diag:s1' } });
    await expect(invoke?.(undefined, { action: 'exportMarkdown', payload: { sessionId: 's1' } }))
      .resolves.toEqual({ success: true, data: { markdown: 'md:s1' } });
    await expect(invoke?.(undefined, { action: 'getMemoryContext', payload: { sessionId: 's1', query: 'q' } }))
      .resolves.toEqual({ success: true, data: { memory: 'ctx:s1' } });
    await expect(invoke?.(undefined, { action: 'import', payload: { data: { id: 'x' } } }))
      .resolves.toEqual({ success: true, data: 'imported:[object Object]' });

    expect(svc.exportSessionDiagnostics).toHaveBeenCalledWith('s1');
    expect(svc.exportSessionMarkdown).toHaveBeenCalledWith('s1');
    expect(svc.getMemoryContext).toHaveBeenCalledWith('s1', undefined, 'q');
    expect(svc.importSession).toHaveBeenCalledWith({ id: 'x' });
  });

  it('search 在 web 形态走 performCrossSessionSearch 真链路（取 sessions().listSessions 拼标题表）', async () => {
    const { registered, target } = createTarget();
    const svc = {
      listSessions: vi.fn(async () => [{ id: 's1', title: 'T' }]),
    };
    installDomainRoutes(target, defineSessionRoutes('web'), {
      ...createDummyContext(),
      sessions: async () => svc,
    } as unknown as SessionCommandContext);

    const response = await registered.get('domain:session')?.(undefined, {
      action: 'search',
      payload: { query: 'needle' },
    }) as { success: boolean; data: { query: string; results: unknown[] } };

    expect(response.success).toBe(true);
    expect(response.data.query).toBe('needle');
    expect(response.data.results).toEqual([]);
    expect(svc.listSessions).toHaveBeenCalledWith({ includeArchived: true });
  });

  it('gap action 的 backend 门失败（sessions() 抛 SERVICE_UNAVAILABLE）仍先落 code', async () => {
    const { registered, target } = createTarget();
    const unavailable = Object.assign(new Error('SessionManager not available'), {
      code: 'SERVICE_UNAVAILABLE',
    });
    installDomainRoutes(target, defineSessionRoutes('web'), {
      ...createDummyContext(),
      sessions: async () => {
        throw unavailable;
      },
    } as unknown as SessionCommandContext);
    for (const action of ['exportDiagnostics', 'exportMarkdown', 'getMemoryContext', 'import', 'search']) {
      await expect(
        registered.get('domain:session')?.(undefined, { action, payload: { sessionId: 's1', query: 'q' } }),
      ).resolves.toEqual({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'SessionManager not available' },
      });
    }
  });

  it('未知 action 兜底文案：web `Unknown session action:` / 桌面 `Unknown action:`', async () => {
    for (const [surface, message] of [
      ['web', 'Unknown session action: bogus'],
      ['desktop', 'Unknown action: bogus'],
    ] as const) {
      const { registered, target } = createTarget();
      installDomainRoutes(target, defineSessionRoutes(surface), createDummyContext());
      await expect(
        registered.get('domain:session')?.(undefined, { action: 'bogus' }),
      ).resolves.toEqual({
        success: false,
        error: { code: 'INVALID_ACTION', message },
      });
    }
  });

  it('表 handler 的 INVALID_PAYLOAD 校验先于 ctx（getModelOverride 缺 sessionId）', async () => {
    const { registered, target } = createTarget();
    installDomainRoutes(target, defineSessionRoutes('web'), createDummyContext());
    await expect(
      registered.get('domain:session')?.(undefined, { action: 'getModelOverride', payload: {} }),
    ).resolves.toEqual({
      success: false,
      error: { code: 'INVALID_PAYLOAD', message: 'sessionId is required' },
    });
  });
});

describe('createDesktopSessionContext（AppService 直连门）', () => {
  it('AppService 未初始化 → sessions() 抛 Services not initialized（原桌面语义）', async () => {
    const ctx = createDesktopSessionContext(() => null);
    await expect(ctx.sessions()).rejects.toThrow('Services not initialized');
    await expect(ctx.ensureBackend()).rejects.toThrow('Services not initialized');
  });

  it('AppService 可用时 sessions() 直连返回（无包装）', async () => {
    const svc = { listSessions: async () => [] } as unknown as import('../../../../src/shared/contract/appService').AgentApplicationService;
    const ctx = createDesktopSessionContext(() => svc);
    await expect(ctx.sessions()).resolves.toBe(svc);
  });
});
