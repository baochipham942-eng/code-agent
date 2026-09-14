// ============================================================================
// Web 形态 session 域 5 个补齐 action 集成验证（RQ-183 刀 3）
// ============================================================================
//
// import / search / exportMarkdown / exportDiagnostics / getMemoryContext 在
// 刀 2 是 web 形态的 INVALID_ACTION 桩（原 web handler 就没有这些 case，生产是死
// 能力）；刀 3 起走单源表真实现。本文件用与 webServer 生产装配同构的链路
// （defineSessionRoutes('web') + createWebSessionContext + installDomainRoutes，
// HTTP 桥 routes/domain.ts 对 handler 是薄透传）+ 真实 SQLite（initDatabase，
// CODE_AGENT_DATA_DIR 锚进临时目录）逐个验证五个 action 的真实行为：
//   - 响应形状与桌面实现逐字对齐（exportSessionMarkdown / buildSessionLogExport /
//     performCrossSessionSearch / importSession 的返回契约）；
//   - web backend 门（DB 未就绪 → SERVICE_UNAVAILABLE）对五个 action 生效。
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 隔离三件套（都必须先于 import 副作用，vi.hoisted 先于 import 执行；hoisted
// 回调里不能引用顶层 import，路径用环境变量拼接）：
//   1. CODE_AGENT_WEB_MODE=1 + 清 CODE_AGENT_CLI_MODE：nativeLoader 在 CLI 模式
//      （tests/setup.ts 全局设 CODE_AGENT_CLI_MODE=1）下不装载 better-sqlite3；
//   2. CODE_AGENT_DATA_DIR 指进临时目录：appPaths 系（导出诊断包的 logs/audit
//      目录、getUserDataPath）按它解析且模块级记忆化；
//   3. 临时目录落在 globalSetup 的 TMPDIR run 根内——崩溃残留也随 run 根整体回收。
const env = vi.hoisted(() => {
  const snapshot = {
    dataDir: process.env.CODE_AGENT_DATA_DIR,
    cliMode: process.env.CODE_AGENT_CLI_MODE,
    webMode: process.env.CODE_AGENT_WEB_MODE,
  };
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  const dir = `${base}/neo-web-gap-actions-${process.pid}-${Date.now()}`;
  process.env.CODE_AGENT_DATA_DIR = dir;
  process.env.CODE_AGENT_WEB_MODE = '1';
  delete process.env.CODE_AGENT_CLI_MODE;
  return { snapshot, dir };
});

// DatabaseService 构造默认参走 app.getPath('userData')——vitest 下被 setup.ts 的
// electron mock 钉在固定路径 /tmp/mock-electron-userData（跨运行/跨 worker 共享
// 同一个真库文件：UNIQUE 冲突 + 残留污染）。这里文件级重定向单例装配：实现类与
// initialize 全用真的，只把 getDatabase()/initDatabase() 指向本文件专属目录的实例。
const testDb = vi.hoisted(() => ({ service: null as unknown, initialized: false }));

vi.mock('../../../src/host/services/core/databaseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/core/databaseService')>();
  const ensureService = () => {
    if (!testDb.service) {
      testDb.service = new actual.DatabaseService(env.dir);
    }
    return testDb.service as import('../../../src/host/services/core/databaseService').DatabaseService;
  };
  return {
    ...actual,
    getDatabase: () => ensureService(),
    initDatabase: async () => {
      const service = ensureService();
      if (!testDb.initialized) {
        await service.initialize();
        testDb.initialized = true;
      }
      return service;
    },
  };
});

import JSZip from 'jszip';
import type { Message } from '../../../src/shared/contract';
import { initDatabase } from '../../../src/host/services/core/databaseService';
import { getSessionManager } from '../../../src/host/services/infra/sessionManager';
import { installDomainRoutes } from '../../../src/host/ipc/domainRoutes/registry';
import { defineSessionRoutes } from '../../../src/host/ipc/domainRoutes/sessionRoutes';
import { createWebSessionContext } from '../../../src/web/sessionDomainHandler';
import type { HandlerFn } from '../../../src/host/platform';

const SID = 'session-web-gap-actions-proof';
const NEEDLE = 'webgap-needle-content';

type DomainResponse = {
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
};

/** 与 webServer 生产装配同构：单源表 web 形态 + web context，返回 domain:session handler */
function installWebDomainHandler(dbAvailable: boolean): HandlerFn {
  const handlers = new Map<string, HandlerFn>();
  installDomainRoutes(
    { handle: (channel, handler) => { handlers.set(channel, handler); } },
    defineSessionRoutes('web'),
    createWebSessionContext({
      getDbAvailable: () => dbAvailable,
      hasActiveRun: () => false,
      getCurrentSessionId: () => null,
      setCurrentSessionId: () => {},
      getDurableRunReadService: () => undefined,
    }),
  );
  const handler = handlers.get('domain:session');
  if (!handler) throw new Error('domain:session handler was not installed');
  return handler;
}

async function seedSession(): Promise<void> {
  const database = await initDatabase();
  database.createSessionWithId(SID, {
    title: 'Web Gap Actions Proof',
    modelConfig: { provider: 'openai', model: 'gpt-test' },
    engine: { kind: 'native' },
  });
  const messages: Array<Pick<Message, 'id' | 'role' | 'content' | 'timestamp'>> = [
    { id: 'web-gap-u1', role: 'user', content: `find the ${NEEDLE}`, timestamp: Date.parse('2026-09-14T10:00:00.000Z') },
    { id: 'web-gap-a1', role: 'assistant', content: `here is the ${NEEDLE} answer`, timestamp: Date.parse('2026-09-14T10:00:01.000Z') },
  ];
  for (const message of messages) {
    database.addMessage(SID, message as Message);
  }
}

describe('web 形态 session 域 5 个补齐 action（刀 3）', () => {
  let invoke: HandlerFn;

  beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    await seedSession();
  });

  afterAll(async () => {
    if (testDb.service) {
      await (testDb.service as import('../../../src/host/services/core/databaseService').DatabaseService).close();
    }
    await getSessionManager().dispose();
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('CODE_AGENT_DATA_DIR', env.snapshot.dataDir);
    restore('CODE_AGENT_CLI_MODE', env.snapshot.cliMode);
    restore('CODE_AGENT_WEB_MODE', env.snapshot.webMode);
    fs.rmSync(env.dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    invoke = installWebDomainHandler(true);
  });

  it('exportMarkdown：返回 markdown + 建议文件名 + stats，正文含会话消息', async () => {
    const response = await invoke(null, {
      action: 'exportMarkdown',
      payload: { sessionId: SID },
    }) as DomainResponse;

    expect(response.success).toBe(true);
    const data = response.data as { markdown: string; suggestedFileName: string; stats: unknown };
    expect(data.markdown).toContain(NEEDLE);
    expect(data.suggestedFileName).toMatch(/\.md$/);
    expect(data.stats).toBeTruthy();
  });

  it('exportDiagnostics：返回 base64 ZIP 包（package-v2），transcript 含会话消息', async () => {
    const response = await invoke(null, {
      action: 'exportDiagnostics',
      payload: { sessionId: SID },
    }) as DomainResponse;

    expect(response.success).toBe(true);
    const data = response.data as { content: string; suggestedFileName: string; encoding: string };
    expect(data.encoding).toBe('base64');
    expect(data.suggestedFileName).toMatch(/^neo-session-.*\.zip$/);
    const zip = await JSZip.loadAsync(Buffer.from(data.content, 'base64'));
    const transcript = await zip.file('transcript.jsonl')?.async('string');
    expect(transcript).toContain(NEEDLE);
  });

  it('import：吃 export 的产物，落库为新 session 并返回新 id', async () => {
    const exported = await invoke(null, { action: 'export', payload: { sessionId: SID } }) as DomainResponse;
    expect(exported.success).toBe(true);

    const response = await invoke(null, {
      action: 'import',
      payload: { data: exported.data },
    }) as DomainResponse;

    expect(response.success).toBe(true);
    const newId = response.data as string;
    expect(typeof newId).toBe('string');
    expect(newId).not.toBe(SID);
    const database = await initDatabase();
    const messages = database.getMessages(newId);
    expect(messages).toHaveLength(2);
    expect(messages.some((message) => message.content.includes(NEEDLE))).toBe(true);
  });

  it('search：按 sessionIds 水合 DB 后命中消息，结果带 sessionId 与会话标题', async () => {
    const response = await invoke(null, {
      action: 'search',
      payload: { query: NEEDLE, options: { sessionIds: [SID] } },
    }) as DomainResponse;

    expect(response.success).toBe(true);
    const data = response.data as {
      query: string;
      totalMatches: number;
      sessionsWithMatches: number;
      results: Array<{ sessionId: string; sessionTitle?: string; messageId: string }>;
    };
    expect(data.query).toBe(NEEDLE);
    expect(data.totalMatches).toBeGreaterThan(0);
    expect(data.sessionsWithMatches).toBe(1);
    expect(data.results[0]).toMatchObject({
      sessionId: SID,
      sessionTitle: 'Web Gap Actions Proof',
      messageId: expect.any(String),
    });
  });

  it('getMemoryContext：返回既有空上下文契约（memoryTriggerService 已移除）', async () => {
    const response = await invoke(null, {
      action: 'getMemoryContext',
      payload: { sessionId: SID, workingDirectory: '/tmp', query: 'anything' },
    }) as DomainResponse;

    expect(response.success).toBe(true);
    expect(response.data).toEqual({
      projectKnowledge: [],
      relevantCode: [],
      recentConversations: [],
      userPreferences: {},
      stats: { projectKnowledgeCount: 0, relevantCodeCount: 0, conversationCount: 0, retrievalTimeMs: 0 },
    });
  });

  it('backend 门：DB 未就绪时五个 action 一律 SERVICE_UNAVAILABLE（门序保持）', async () => {
    const gated = installWebDomainHandler(false);
    for (const action of ['exportDiagnostics', 'exportMarkdown', 'getMemoryContext', 'import', 'search']) {
      await expect(
        gated(null, { action, payload: { sessionId: SID, query: 'q', data: {} } }),
      ).resolves.toEqual({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'SessionManager not available' },
      });
    }
  });
});
