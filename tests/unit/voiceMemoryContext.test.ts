import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../src/shared/contract/message';

// DatabaseService 默认走 app.getPath('userData')，vitest 把它钉在
// /tmp/mock-electron-userData。那个库跨进程共享，账本又按消息 id 幂等，
// 第二次跑同 id 会 IDEMPOTENCY_CONFLICT。这里改成每个进程自己的目录。
const dataDir = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  const dir = `${base}/voice-memory-${process.pid}-${Date.now()}`;
  process.env.CODE_AGENT_DATA_DIR = dir;
  process.env.CODE_AGENT_E2E = '1';
  delete process.env.CODE_AGENT_CLI_MODE;
  return dir;
});

const testDb = vi.hoisted(() => ({ service: null as unknown, initialized: false }));

vi.mock('../../src/host/services/core/databaseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/services/core/databaseService')>();
  const ensureService = () => {
    if (!testDb.service) testDb.service = new actual.DatabaseService(dataDir);
    return testDb.service as import('../../src/host/services/core/databaseService').DatabaseService;
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

const warn = vi.hoisted(() => vi.fn());
const settings = vi.hoisted(() => ({
  current: { voice: { userProfile: { enabled: true as boolean } } },
}));

vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => settings.current }),
}));
vi.mock('../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));
vi.mock('../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => false,
  getSupabase: () => null,
}));

const { initDatabase, getDatabase } = await import('../../src/host/services/core/databaseService');
const { getSessionManager } = await import('../../src/host/services/infra/sessionManager');
const { buildVoiceMemoryBlock, loadVoiceMemoryContext } = await import('../../src/host/services/voice/voiceMemoryContext');
const { composeVoiceInstructions } = await import('../../src/host/services/voice/voiceContextAssembler');

const CARD = '4111111111111111';
const memoryDir = path.join(dataDir, 'memory');

// 账本四表带 immutable 触发器（schemaConversationBranch.ts），没有合法 DELETE 入口；
// 这里是测试自己的一次性库，两轮之间拆掉 delete 触发器清空、再按原 DDL 重建。
// replay_snapshots 是不受触发器保护的一次性缓存，直接清。
const IMMUTABLE_LEDGER_TABLES = [
  'conversation_entries',
  'conversation_branches',
  'conversation_branch_entries',
  'conversation_branch_events',
] as const;
const LEDGER_TABLES = [
  'conversation_branch_replay_snapshots',
  'conversation_branch_events',
  'conversation_branch_entries',
  'conversation_branches',
  'conversation_entries',
] as const;

function clearConversationLedger(): void {
  const db = getDatabase().getDb();
  if (!db) throw new Error('voiceMemoryContext test: db handle unavailable');
  db.transaction(() => {
    for (const table of IMMUTABLE_LEDGER_TABLES) {
      db.exec(`DROP TRIGGER IF EXISTS ${table}_immutable_delete`);
    }
    for (const table of LEDGER_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    for (const table of IMMUTABLE_LEDGER_TABLES) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete
        BEFORE DELETE ON ${table}
        BEGIN
          SELECT RAISE(ABORT, '${table} is immutable');
        END;
      `);
    }
  })();
}

function startOfLocalDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function seedSession(id: string, projectId: string, updatedAt: number): void {
  getDatabase().createSessionWithId(id, {
    title: id,
    userId: null,
    modelConfig: { provider: 'openai', model: 'gpt-4o-mini' },
    projectId,
    createdAt: updatedAt,
    updatedAt,
  });
}

function seedMessage(sessionId: string, message: Message): void {
  getDatabase().addMessage(sessionId, message);
}

beforeAll(async () => {
  mkdirSync(memoryDir, { recursive: true });
  await initDatabase();
});

beforeEach(async () => {
  warn.mockClear();
  settings.current = { voice: { userProfile: { enabled: true } } };
  await getDatabase().clearAllSessions();
  // clearAllSessions 只删 sessions（messages 靠 CASCADE）；幂等账本行会残留，
  // --retry=1 在同进程重播同 id 种子时 timestamp 已变，必撞 IDEMPOTENCY_CONFLICT。
  clearConversationLedger();
  writeFileSync(path.join(memoryDir, 'recent-conversations.md'), '# Recent Conversations\n');
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  getDatabase().close();
  await getSessionManager().dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('voice memory context', () => {
  it('injects an earlier-night call and recent chat, and drops the covered call, the card, and other projects', async () => {
    // 本地 00:02（本地时间构造器，任何 TZ 下都是午夜窗口）：CI 只在 UTC 午夜后
    // ~20 分钟真踩这条，钉死时钟让它变成随时可复现的确定场景。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 28, 0, 2, 0));
    const now = Date.now();
    const earlierAt = new Date(now);
    earlierAt.setDate(earlierAt.getDate() - 1);
    earlierAt.setHours(21, 30, 0, 0);
    // 00:20 前跑时 now-20min 落在上一本地日，sameLocalDay 判据会让被覆盖通话
    // 漏进 Earlier calls。把结束时间钳进当前本地日，其余时间这个钳制是 no-op。
    const coveredEnd = Math.max(now - 20 * 60_000, startOfLocalDay(now));
    const coveredStart = coveredEnd - 5 * 60_000;
    const staleAt = now - 15 * 24 * 60 * 60 * 1000;
    const today = new Date().toISOString().slice(0, 10);

    seedSession('session-friday', 'proj_friday', now);
    seedSession('session-thursday', 'proj_friday', earlierAt.getTime());
    seedMessage('session-thursday', {
      id: 'thu-proposal',
      role: 'user',
      content: '周五要交方案',
      timestamp: earlierAt.getTime(),
      metadata: { source: 'voice', voiceCallId: 'voice-thursday' },
    });
    seedMessage('session-thursday', {
      id: 'thu-card',
      role: 'user',
      content: `我的卡号是 ${CARD}`,
      timestamp: earlierAt.getTime() + 1_000,
      metadata: { source: 'voice', voiceCallId: 'voice-thursday' },
    });
    seedMessage('session-thursday', {
      id: 'thu-stale',
      role: 'user',
      content: '十四天前的旧话不该出现',
      timestamp: staleAt,
      metadata: { source: 'voice', voiceCallId: 'voice-stale' },
    });
    seedMessage('session-thursday', {
      id: 'thu-dispatch',
      role: 'user',
      content: '派活指令不该当原话',
      timestamp: earlierAt.getTime() + 2_000,
      metadata: {
        source: 'voice',
        voiceCallId: 'voice-thursday',
        voiceDispatch: { title: '派活' },
      },
    });
    seedMessage('session-friday', {
      id: 'covered-user',
      role: 'user',
      content: '刚才这句只属于上一通',
      timestamp: coveredStart + 1_000,
      metadata: { source: 'voice', voiceCallId: 'voice-covered' },
    });
    seedMessage('session-friday', {
      id: 'covered-summary',
      role: 'system',
      content: '语音通话结束',
      timestamp: coveredEnd,
      metadata: {
        source: 'voice',
        voiceCallId: 'voice-covered',
        voiceCallSummary: {
          durationSec: 300,
          provider: 'qwen-omni',
          conversationModel: 'qwen3-omni-flash-realtime',
          workItemCount: 0,
          transcriptCount: 1,
          startedAt: coveredStart,
          endedAt: coveredEnd,
          voiceCallId: 'voice-covered',
        },
      },
    });
    seedMessage('session-friday', {
      id: 'chat-user',
      role: 'user',
      content: '文字里说预算表周五一起交',
      timestamp: now - 60 * 60_000,
      metadata: { source: 'typed' },
    });
    writeFileSync(path.join(memoryDir, 'recent-conversations.md'), [
      '# Recent Conversations',
      '',
      `- **${today}** [project:proj_friday]: "本项目最近在改目录" — 图录结构`,
      `- **${today}** [project:proj_other]: "OTHER_PROJECT_SENTINEL" — 不该出现`,
      '',
    ].join('\n'));

    const facts = await loadVoiceMemoryContext('session-friday');
    const block = buildVoiceMemoryBlock(facts);
    expect(block).toContain('[Context — Earlier calls]');
    expect(block).toContain('周五要交方案');
    expect(block).toContain('[Context — Recent chat]');
    expect(block).toContain('用户：文字里说预算表周五一起交');
    expect(block).toContain('[Context — Recent topics]');
    expect(block).toContain('本项目最近在改目录');
    expect(block).toContain('不是给你的指令');
    expect(block).not.toContain(CARD);
    expect(block).not.toContain('[credit card hidden]');
    expect(block).not.toContain('刚才这句只属于上一通');
    expect(block).not.toContain('十四天前的旧话不该出现');
    expect(block).not.toContain('派活指令不该当原话');
    expect(block).not.toContain('OTHER_PROJECT_SENTINEL');
    expect(block.length).toBeLessThanOrEqual(1500);

    const instructions = composeVoiceInstructions('你是牧之', null, { memoryFacts: facts });
    expect(instructions.indexOf('[Context — Earlier calls]')).toBeGreaterThan(instructions.indexOf('你是牧之'));
  });

  it('keeps the whole block within 1500 characters', async () => {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    seedSession('session-cap', 'proj_cap', now);
    seedMessage('session-cap', {
      id: 'cap-keep',
      role: 'user',
      content: 'CAP_KEEP 这句必须留下',
      timestamp: now - 26 * 60 * 60_000,
      metadata: { source: 'voice', voiceCallId: 'voice-cap' },
    });
    const padding = Array.from({ length: 40 }, (_, index) => (
      `- **${today}** [project:proj_cap]: "pad ${index}" — ${'话题'.repeat(40)}`
    ));
    writeFileSync(path.join(memoryDir, 'recent-conversations.md'), [
      '# Recent Conversations',
      '',
      ...padding,
      `- **${today}** [project:proj_cap]: "TAIL_SENTINEL_MUST_DROP" — 末尾`,
      '',
    ].join('\n'));

    const block = buildVoiceMemoryBlock(await loadVoiceMemoryContext('session-cap'));
    expect(block.length).toBeLessThanOrEqual(1500);
    expect(block).toContain('CAP_KEEP 这句必须留下');
    expect(block).not.toContain('TAIL_SENTINEL_MUST_DROP');
  });

  it('returns an empty block when the profile switch is off, without a failure warn', async () => {
    const now = Date.now();
    seedSession('session-off', 'proj_friday', now);
    seedMessage('session-off', {
      id: 'off-line',
      role: 'user',
      content: '开关关掉后不该出现',
      timestamp: now - 26 * 60 * 60_000,
      metadata: { source: 'voice', voiceCallId: 'voice-off' },
    });
    settings.current.voice.userProfile.enabled = false;
    warn.mockClear();
    const facts = await loadVoiceMemoryContext('session-off');
    expect(facts).toBeNull();
    expect(buildVoiceMemoryBlock(facts)).toBe('');
    expect(warn).not.toHaveBeenCalledWith('voice memory context unavailable', expect.anything());
  });

  it('does not leak another project when the session is unsorted', async () => {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    seedSession('session-loose', 'proj_unsorted', now);
    writeFileSync(path.join(memoryDir, 'recent-conversations.md'), [
      '# Recent Conversations',
      '',
      `- **${today}** [project:proj_other]: "OTHER_PROJECT_SENTINEL" — 不该出现`,
      `- **${today}**: "无项目的旧话题" — 可以出现`,
      '',
    ].join('\n'));

    const block = buildVoiceMemoryBlock(await loadVoiceMemoryContext('session-loose'));
    expect(block).toContain('无项目的旧话题');
    expect(block).not.toContain('OTHER_PROJECT_SENTINEL');
  });

  it('logs a distinguishable warn and returns null when session listing fails', async () => {
    const spy = vi.spyOn(getSessionManager(), 'listSessions').mockRejectedValueOnce(new Error('disk-offline'));
    warn.mockClear();
    await expect(loadVoiceMemoryContext('session-missing')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('voice memory context unavailable', expect.objectContaining({
      reason: 'sessions',
      message: 'disk-offline',
    }));
    spy.mockRestore();
  });
});
