// ============================================================================
// Session 域路由表装配单测（RQ-183 刀 2）
// ============================================================================
//
// 钉死 web 形态表与桌面形态表的可观察差异：
//   1. 5 个 desktop-only gap action 在 web 形态是 INVALID_ACTION 桩（生产行为平移，
//      且桩先过 backend 门——对齐原 web handler「门在 switch 之前」的顺序）；
//   2. 未知 action 的兜底文案两形态各自保持既有错误契约
//      （web: `Unknown session action: x` / 桌面: `Unknown action: x`）；
//   3. 表 handler 的 INVALID_PAYLOAD 校验在触碰 ctx 之前发生；
//   4. 桌面 context 的 AppService 门（未初始化 → 'Services not initialized'）。
// 表/schema/shellCapabilities 三面集合对账由 tests/scripts/domainRouteParity.test.ts 盯。
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

  it('web 形态的 5 个暂缓 action → 先过 backend 门再 INVALID_ACTION（生产行为平移）', async () => {
    const { registered, target } = createTarget();
    const ctx = createDummyContext();
    installDomainRoutes(target, defineSessionRoutes('web'), ctx);
    const invoke = registered.get('domain:session');

    for (const action of ['exportDiagnostics', 'exportMarkdown', 'getMemoryContext', 'import', 'search']) {
      await expect(invoke?.(undefined, { action, payload: { sessionId: 's1' } })).resolves.toEqual({
        success: false,
        error: { code: 'INVALID_ACTION', message: `Unknown session action: ${action}` },
      });
    }
    expect(ctx.ensureBackend).toHaveBeenCalledTimes(5);
  });

  it('web 形态的暂缓 action 在 DB 未就绪时仍先落 SERVICE_UNAVAILABLE（门序保持）', async () => {
    const { registered, target } = createTarget();
    installDomainRoutes(target, defineSessionRoutes('web'), {
      ...createDummyContext(),
      ensureBackend: async () => {
        const error = new Error('SessionManager not available') as Error & { code: string };
        error.code = 'SERVICE_UNAVAILABLE';
        throw error;
      },
    });
    await expect(
      registered.get('domain:session')?.(undefined, { action: 'search', payload: {} }),
    ).resolves.toEqual({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'SessionManager not available' },
    });
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
