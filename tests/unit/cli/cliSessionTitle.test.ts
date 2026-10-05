// ============================================================================
// N-CLI-SESSION-TITLE — CLI 会话按首条用户消息起标题，四处占位判断同一口径
// ============================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.unmock('better-sqlite3');

const previousDataDir = process.env.CODE_AGENT_DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-session-title-'));
process.env.CODE_AGENT_DATA_DIR = tempDir;

const quick = vi.hoisted(() => ({
  available: false,
  hold: false,
  pending: null as null | ((value: { success: boolean; content: string }) => void),
}));

vi.mock('../../../src/host/model/quickModel', () => ({
  isQuickModelAvailable: () => quick.available,
  quickTask: () => new Promise((resolve) => {
    if (quick.hold) {
      quick.pending = resolve as (value: { success: boolean; content: string }) => void;
      return;
    }
    resolve({ success: false, content: '' });
  }),
}));

vi.mock('../../../src/host/telemetry/telemetryCollector', () => ({
  getTelemetryCollector: () => ({ updateSessionTitle: () => undefined }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { Message, ModelConfig } from '../../../src/shared/contract';
import { persistAgentLoopMessageToSession } from '../../../src/cli/bootstrap';
import { CLISessionManager } from '../../../src/cli/session';
import { getCLIDatabase } from '../../../src/cli/database';
import {
  deriveFallbackSessionTitle,
  isPlaceholderSessionTitle,
} from '../../../src/shared/sessionTitlePlaceholder';
import { isPlaceholderSessionTitle as webIsPlaceholderSessionTitle } from '../../../src/web/helpers/webSessionStore';
import { readNamedChatTitle } from '../../../src/host/telemetry/telemetrySessionTitleBackfill';
import { SessionManager } from '../../../src/host/services/infra/sessionManager';
import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';

const LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const modelConfig: ModelConfig = {
  provider: 'deepseek',
  model: 'deepseek-chat',
};

const USER_TEXT = 'hello from the user';

beforeAll(async () => {
  // 生产路径先 initializeCLIServices 再落消息。库未就绪时 ensureSession 直接返回，首条消息会撞外键。
  await getCLIDatabase().initialize();
});

function userMessage(id: string, content: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    role: 'user',
    content,
    timestamp: 1_700_000_000_000,
    ...extra,
  };
}

function readTitle(sessionId: string): string | null {
  const row = getCLIDatabase().getDb()?.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as
    | { title: string }
    | undefined;
  return row?.title ?? null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForQuickTask(): Promise<void> {
  for (let i = 0; i < 50 && !quick.pending; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(quick.pending).toBeTypeOf('function');
}

describe('CLI session titles', () => {
  let manager: CLISessionManager;

  beforeEach(() => {
    quick.available = false;
    quick.hold = false;
    quick.pending = null;
    manager = new CLISessionManager();
  });

  it('agent-loop path derives the stored title from the first user message', async () => {
    const sessionId = 'cli_session_agent_loop_1';
    await persistAgentLoopMessageToSession(manager, userMessage('msg-agent', 'fix the login redirect\nmore detail'), {
      sessionId,
      modelConfig,
      workingDirectory: tempDir,
    });
    await settle();

    expect(readTitle(sessionId)).toBe('fix the login redirect');
  });

  it('strips appshot blocks before the fallback title', async () => {
    const sessionId = 'cli_session_appshot_1';
    const content = [
      '<appshot app="a" name="Notes" captured="2026-09-07T00:00:00.000Z">',
      'window text',
      '</appshot>',
      'rename the export button',
    ].join('\n');
    await persistAgentLoopMessageToSession(manager, userMessage('msg-appshot', content), {
      sessionId,
      modelConfig,
      workingDirectory: tempDir,
    });
    await settle();

    expect(readTitle(sessionId)).toBe('rename the export button');
  });

  it('does not overwrite a title the user set while the model call is in flight', async () => {
    quick.available = true;
    quick.hold = true;
    const sessionId = 'cli_session_rename_1';
    const pending = persistAgentLoopMessageToSession(manager, userMessage('msg-rename', 'hello there'), {
      sessionId,
      modelConfig,
      workingDirectory: tempDir,
    });
    await waitForQuickTask();

    await manager.updateSession(sessionId, { title: 'Kept by user' });
    quick.pending?.({ success: true, content: '模型起的标题' });
    await pending;
    await settle();

    expect(readTitle(sessionId)).toBe('Kept by user');
  });

  it('does not retitle when the same message is persisted again', async () => {
    const session = await manager.createSession({
      title: 'CLI Session',
      modelConfig,
      workingDirectory: tempDir,
    });
    const message = userMessage('msg-dup', 'should not apply on the duplicate');
    getCLIDatabase().addMessage(session.id, message);

    await persistAgentLoopMessageToSession(manager, message, {
      sessionId: session.id,
      modelConfig,
      workingDirectory: tempDir,
    });
    await settle();

    expect(readTitle(session.id)).toBe('CLI Session');
  });

  it('does not title from a meta user message', async () => {
    const sessionId = 'cli_session_meta_1';
    await persistAgentLoopMessageToSession(
      manager,
      userMessage('msg-meta', 'meta prompt that must not title', { isMeta: true }),
      { sessionId, modelConfig, workingDirectory: tempDir },
    );
    await settle();

    expect(readTitle(sessionId)).toBe('CLI Session');
  });

  it('does not title from a rewound user message', async () => {
    const sessionId = 'cli_session_rewound_1';
    await persistAgentLoopMessageToSession(
      manager,
      userMessage('msg-rewound', 'rewound prompt that must not title', { visibility: 'rewound' }),
      { sessionId, modelConfig, workingDirectory: tempDir },
    );
    await settle();

    expect(readTitle(sessionId)).toBe('CLI Session');
  });
});

describe('placeholder predicate call sites', () => {
  const cases = [
    ['CLI Session', true],
    ['CLI Session 2026/9/7 10:00:00', true],
    ['Session x', true],
    ['New Chat', true],
    ['', true],
    ['Ship the login fix', false],
  ] as const;

  let telemetryDb: Database.Database;

  beforeEach(() => {
    quick.available = false;
    quick.hold = false;
    quick.pending = null;
  });

  afterAll(() => {
    telemetryDb?.close();
  });

  it('session manager, web, telemetry, and CLI treat the same titles as placeholders', async () => {
    telemetryDb = new Database(':memory:');
    applySchema(telemetryDb, LOGGER);
    const manager = new CLISessionManager();
    const fallback = deriveFallbackSessionTitle(USER_TEXT);

    for (const [title, expected] of cases) {
      expect(isPlaceholderSessionTitle(title), `shared ${JSON.stringify(title)}`).toBe(expected);
      expect(webIsPlaceholderSessionTitle(title), `web ${JSON.stringify(title)}`).toBe(expected);

      telemetryDb.prepare('DELETE FROM sessions').run();
      telemetryDb.prepare(`
        INSERT INTO sessions (id, title, model_provider, model_name, session_type, created_at, updated_at)
        VALUES ('telemetry-row', ?, 'deepseek', 'deepseek-chat', 'chat', 0, 0)
      `).run(title);
      const named = readNamedChatTitle(telemetryDb, 'telemetry-row');
      expect(named === null, `telemetry ${JSON.stringify(title)}`).toBe(expected);

      const session = await manager.createSession({
        title: title || 'seed',
        modelConfig,
        workingDirectory: tempDir,
      });
      if (title === '') await manager.updateSession(session.id, { title: '' });
      await manager.addMessageToSession(session.id, userMessage(`msg-${session.id}`, USER_TEXT));
      await settle();
      const stored = readTitle(session.id);
      expect(stored === fallback, `cli ${JSON.stringify(title)} stored ${stored}`).toBe(expected);

      const host = new SessionManager();
      const written: string[] = [];
      vi.spyOn(host, 'getSession').mockResolvedValue({
        id: 'host-session',
        title,
        messageCount: 1,
        messages: [],
        todos: [],
      } as never);
      vi.spyOn(host, 'updateSession').mockImplementation(async (_id, updates) => {
        if (typeof updates.title === 'string') written.push(updates.title);
      });
      await (host as unknown as {
        maybeUpdateTitleForSession: (sessionId: string, firstMessage: string) => Promise<void>;
      }).maybeUpdateTitleForSession('host-session', USER_TEXT);
      expect(written.includes(fallback), `sessionManager ${JSON.stringify(title)}`).toBe(expected);
    }
  });

  it('the four production call sites import the shared predicate', () => {
    const files = [
      'src/host/services/infra/sessionManager.ts',
      'src/web/helpers/webSessionStore.ts',
      'src/host/telemetry/telemetrySessionTitleBackfill.ts',
      'src/cli/session.ts',
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      expect(source, file).toContain('isPlaceholderSessionTitle');
      expect(source, file).not.toContain("startsWith('CLI Session");
      expect(source, file).not.toContain("startsWith('Session ");
      expect(source, file).not.toContain("title === 'New Chat'");
      expect(source, file).not.toContain("named === 'New Chat'");
    }
  });
});

afterAll(() => {
  try { getCLIDatabase().close(); } catch { /* 未打开 */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
});
