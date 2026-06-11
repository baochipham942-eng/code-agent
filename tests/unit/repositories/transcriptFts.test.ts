// ============================================================================
// SessionRepository — Transcript FTS5 tests (roadmap 2.1)
// ============================================================================
// 会话转录按 kind 分解的全文索引：
//   - user_text / assistant_text / reasoning / tool_input / tool_output
//   - triggers 自动同步（INSERT / UPDATE / DELETE），malformed JSON 不破坏写入
//   - searchTranscriptFts 支持 kind / toolName / 时间窗 / session 过滤
//   - getTranscriptAround 取锚点 ±N 条消息上下文
//   - backfillTranscriptFts 幂等
// Schema 来自 src/shared/transcriptFts.sql（与生产共用，防测试 schema 漂移）
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import {
  applyTranscriptFtsSchema,
  TRANSCRIPT_FTS_BODY_CAP,
} from '../../../src/shared/transcriptFts.sql';
import { SessionRepository } from '../../../src/main/services/core/repositories/SessionRepository';
import type { Message, ToolCall, ToolResult } from '../../../src/shared/contract';

// ----------------------------------------------------------------------------
// Schema helper — 基础表复制自 databaseService；FTS 部分用生产模块
// ----------------------------------------------------------------------------

function createBaseSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      working_directory TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER,
      status TEXT DEFAULT 'idle',
      workspace TEXT,
      last_token_usage TEXT,
      git_branch TEXT
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      attachments TEXT,
      thinking TEXT,
      effort_level TEXT,
      synced_at INTEGER,
      content_parts TEXT,
      metadata TEXT,
      is_meta INTEGER NOT NULL DEFAULT 0,
      compaction TEXT,
      visibility TEXT NOT NULL DEFAULT 'active',
      hidden_by_rewind_id TEXT,
      hidden_at INTEGER
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_rewinds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      anchor_message_id TEXT NOT NULL,
      anchor_prompt TEXT NOT NULL,
      anchor_timestamp INTEGER NOT NULL,
      checkpoint_message_id TEXT,
      hidden_message_count INTEGER NOT NULL DEFAULT 0,
      hidden_message_ids TEXT,
      files_restored INTEGER NOT NULL DEFAULT 0,
      files_deleted INTEGER NOT NULL DEFAULT 0,
      errors_json TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

function insertSession(db: BetterSqlite3.Database, id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, title, model_provider, model_name, working_directory, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, `test-${id}`, 'moonshot', 'kimi-k2.5', '/tmp/test', now, now);
}

let seq = 0;
function makeMessage(
  id: string,
  content: string,
  overrides: Partial<Message> = {}
): Message {
  seq += 1;
  return {
    id,
    role: 'user',
    content,
    timestamp: 1_000_000 + seq * 1000,
    ...overrides,
  } as Message;
}

function makeToolCall(id: string, name: string, args: Record<string, unknown>, result?: Partial<ToolResult>): ToolCall {
  return {
    id,
    name,
    arguments: args,
    ...(result ? { result: { toolCallId: id, success: true, ...result } as ToolResult } : {}),
  } as ToolCall;
}

function allFtsRows(db: BetterSqlite3.Database): Array<{ message_id: string; kind: string; tool_name: string | null; body: string }> {
  return db
    .prepare('SELECT message_id, kind, tool_name, body FROM transcript_fts ORDER BY message_id, kind')
    .all() as Array<{ message_id: string; kind: string; tool_name: string | null; body: string }>;
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('SessionRepository — Transcript FTS5 (kind-decomposed)', () => {
  let db: BetterSqlite3.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createBaseSchema(db);
    applyTranscriptFtsSchema(db);
    repo = new SessionRepository(db);
    insertSession(db, 'sess-A');
    insertSession(db, 'sess-B');
  });

  afterEach(() => {
    db.close();
  });

  // ---- 索引分解 -------------------------------------------------------------

  it('indexes user and assistant text with the right kind', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'user asks about quokka deployment'));
    repo.addMessage('sess-A', makeMessage('m2', 'assistant answers about quokka deployment', { role: 'assistant' }));

    const rows = allFtsRows(db);
    expect(rows).toEqual([
      expect.objectContaining({ message_id: 'm1', kind: 'user_text' }),
      expect.objectContaining({ message_id: 'm2', kind: 'assistant_text' }),
    ]);
  });

  it('does not index empty content or system-role text', () => {
    repo.addMessage('sess-A', makeMessage('m1', ''));
    repo.addMessage('sess-A', makeMessage('m2', 'system housekeeping notice', { role: 'system' }));
    expect(allFtsRows(db)).toEqual([]);
  });

  it('indexes thinking as reasoning kind', () => {
    repo.addMessage(
      'sess-A',
      makeMessage('m1', 'short answer', { role: 'assistant', thinking: 'pondering about zebra caching strategy' })
    );
    const rows = allFtsRows(db);
    expect(rows.map((r) => r.kind).sort()).toEqual(['assistant_text', 'reasoning']);
    const hits = repo.searchTranscriptFts('zebra caching');
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe('reasoning');
  });

  it('indexes each tool call as tool_input with tool_name and searchable arguments', () => {
    repo.addMessage(
      'sess-A',
      makeMessage('m1', 'running tools', {
        role: 'assistant',
        toolCalls: [
          makeToolCall('tc1', 'Bash', { command: 'grep -rn flamingo src/' }),
          makeToolCall('tc2', 'Read', { file_path: '/tmp/pelican.ts' }),
        ],
      })
    );

    const inputs = allFtsRows(db).filter((r) => r.kind === 'tool_input');
    expect(inputs.length).toBe(2);
    expect(inputs.map((r) => r.tool_name).sort()).toEqual(['Bash', 'Read']);

    const hits = repo.searchTranscriptFts('flamingo', { kinds: ['tool_input'] });
    expect(hits.length).toBe(1);
    expect(hits[0].toolName).toBe('Bash');
  });

  it('indexes tool results attached inside tool_calls as tool_output (incl. error text)', () => {
    repo.addMessage(
      'sess-A',
      makeMessage('m1', 'ran tools', {
        role: 'assistant',
        toolCalls: [
          makeToolCall('tc1', 'Bash', { command: 'ls' }, { output: 'found ocelot.txt in dir' }),
          makeToolCall('tc2', 'Read', { file_path: '/x' }, { success: false, error: 'ENOENT walrus missing' }),
        ],
      })
    );

    const outputs = allFtsRows(db).filter((r) => r.kind === 'tool_output');
    expect(outputs.length).toBe(2);

    const okHit = repo.searchTranscriptFts('ocelot', { kinds: ['tool_output'] });
    expect(okHit.length).toBe(1);
    expect(okHit[0].toolName).toBe('Bash');

    const errHit = repo.searchTranscriptFts('walrus missing', { kinds: ['tool_output'] });
    expect(errHit.length).toBe(1);
    expect(errHit[0].toolName).toBe('Read');
  });

  it('indexes legacy tool_results column with tool_name resolved from tool_calls, deduped against inline results', () => {
    // tc1 has inline result; tr for tc1 must be deduped. tc2 only has a column-level result.
    const msg = makeMessage('m1', 'ran tools', {
      role: 'assistant',
      toolCalls: [
        makeToolCall('tc1', 'Bash', { command: 'ls' }, { output: 'inline antelope output' }),
        makeToolCall('tc2', 'Grep', { pattern: 'x' }),
      ],
      toolResults: [
        { toolCallId: 'tc1', success: true, output: 'inline antelope output' },
        { toolCallId: 'tc2', success: true, output: 'column-level gazelle output' },
      ] as ToolResult[],
    });
    repo.addMessage('sess-A', msg);

    const outputs = allFtsRows(db).filter((r) => r.kind === 'tool_output');
    expect(outputs.length).toBe(2); // 不是 3：tc1 去重

    const hit = repo.searchTranscriptFts('gazelle', { kinds: ['tool_output'] });
    expect(hit.length).toBe(1);
    expect(hit[0].toolName).toBe('Grep');
  });

  it('survives malformed tool_calls JSON without aborting the insert', () => {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls, tool_results)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('m1', 'sess-A', 'assistant', 'text with corrupted manatee payload', 123456789, '{not valid json', 'also not json');

    const rows = allFtsRows(db);
    expect(rows.map((r) => r.kind)).toEqual(['assistant_text']);
    expect(repo.searchTranscriptFts('manatee').length).toBe(1);
  });

  it('excludes meta and loop-internal messages across all kinds', () => {
    repo.addMessage(
      'sess-A',
      makeMessage('meta', 'hidden capybara text', {
        role: 'assistant',
        isMeta: true,
        thinking: 'hidden capybara thinking',
        toolCalls: [makeToolCall('tc1', 'Bash', { command: 'echo capybara' }, { output: 'capybara out' })],
      })
    );
    repo.addMessage('sess-A', makeMessage('loop', '【循环模式 · 第 1 轮】 hidden capybara loop prompt'));

    expect(allFtsRows(db)).toEqual([]);
    expect(repo.searchTranscriptFts('capybara')).toEqual([]);
  });

  it('re-indexes on update without leaving duplicate rows (tool result attached later)', () => {
    repo.addMessage(
      'sess-A',
      makeMessage('m1', 'turn text', {
        role: 'assistant',
        toolCalls: [makeToolCall('tc1', 'Bash', { command: 'sleep 1' })],
      })
    );
    expect(allFtsRows(db).filter((r) => r.kind === 'tool_output')).toEqual([]);

    // 模拟 tool_call_end：result 回填进 toolCalls
    repo.updateMessage('m1', {
      toolCalls: [makeToolCall('tc1', 'Bash', { command: 'sleep 1' }, { output: 'slept like a dormouse' })],
    });

    const rows = allFtsRows(db);
    expect(rows.filter((r) => r.kind === 'tool_input').length).toBe(1);
    expect(rows.filter((r) => r.kind === 'tool_output').length).toBe(1);
    expect(repo.searchTranscriptFts('dormouse', { kinds: ['tool_output'] }).length).toBe(1);
  });

  it('removes all kind rows when the message is deleted', () => {
    repo.addMessage(
      'sess-A',
      makeMessage('m1', 'doomed message about ibex', {
        role: 'assistant',
        thinking: 'ibex reasoning',
        toolCalls: [makeToolCall('tc1', 'Bash', { command: 'echo ibex' }, { output: 'ibex out' })],
      })
    );
    expect(allFtsRows(db).length).toBeGreaterThanOrEqual(3);

    db.prepare('DELETE FROM messages WHERE id = ?').run('m1');
    expect(allFtsRows(db)).toEqual([]);
  });

  it('caps indexed body length at TRANSCRIPT_FTS_BODY_CAP', () => {
    const longOutput = 'lemur '.repeat(5000); // 30K chars
    repo.addMessage(
      'sess-A',
      makeMessage('m1', 'big output turn', {
        role: 'assistant',
        toolCalls: [makeToolCall('tc1', 'Bash', { command: 'cat big' }, { output: longOutput })],
      })
    );
    const row = allFtsRows(db).find((r) => r.kind === 'tool_output');
    expect(row).toBeDefined();
    expect(row!.body.length).toBeLessThanOrEqual(TRANSCRIPT_FTS_BODY_CAP);
  });

  // ---- 搜索过滤 -------------------------------------------------------------

  it('filters by kind array', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'narwhal in user text'));
    repo.addMessage(
      'sess-A',
      makeMessage('m2', 'tools', {
        role: 'assistant',
        toolCalls: [makeToolCall('tc1', 'Bash', { command: 'echo narwhal' })],
      })
    );

    const all = repo.searchTranscriptFts('narwhal');
    expect(all.length).toBe(2);

    const onlyUser = repo.searchTranscriptFts('narwhal', { kinds: ['user_text'] });
    expect(onlyUser.length).toBe(1);
    expect(onlyUser[0].kind).toBe('user_text');
  });

  it('filters by toolName', () => {
    repo.addMessage(
      'sess-A',
      makeMessage('m1', 'tools', {
        role: 'assistant',
        toolCalls: [
          makeToolCall('tc1', 'Bash', { command: 'echo platypus' }),
          makeToolCall('tc2', 'Grep', { pattern: 'platypus' }),
        ],
      })
    );
    const hits = repo.searchTranscriptFts('platypus', { toolName: 'Grep' });
    expect(hits.length).toBe(1);
    expect(hits[0].toolName).toBe('Grep');
  });

  it('filters by time window (inclusive)', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'tapir sighting one', { timestamp: 1000 }));
    repo.addMessage('sess-A', makeMessage('m2', 'tapir sighting two', { timestamp: 2000 }));
    repo.addMessage('sess-A', makeMessage('m3', 'tapir sighting three', { timestamp: 3000 }));

    const hits = repo.searchTranscriptFts('tapir sighting', { timeAfter: 2000, timeBefore: 2000 });
    expect(hits.length).toBe(1);
    expect(hits[0].messageId).toBe('m2');
  });

  it('scopes by sessionId and clamps limit to 50', () => {
    repo.addMessage('sess-A', makeMessage('a1', 'wombat report alpha'));
    repo.addMessage('sess-B', makeMessage('b1', 'wombat report beta'));

    const scoped = repo.searchTranscriptFts('wombat report', { sessionId: 'sess-B' });
    expect(scoped.length).toBe(1);
    expect(scoped[0].sessionId).toBe('sess-B');

    for (let i = 0; i < 60; i++) {
      repo.addMessage('sess-A', makeMessage(`bulk${i}`, `wombat report bulk ${i}`));
    }
    const capped = repo.searchTranscriptFts('wombat report', { limit: 999 });
    expect(capped.length).toBeLessThanOrEqual(50);
  });

  it('returns empty for blank or sub-trigram queries', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'some content here'));
    expect(repo.searchTranscriptFts('')).toEqual([]);
    expect(repo.searchTranscriptFts('ab')).toEqual([]);
  });

  it('excludes rewound messages by default, includes with includeRewound', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'active axolotl note', { timestamp: 10 }));
    repo.addMessage('sess-A', makeMessage('m2', 'secret axolotl rewound note', { timestamp: 20 }));
    repo.addMessage('sess-A', makeMessage('m3', 'after rewind', { role: 'assistant', timestamp: 30 }));

    repo.applyPromptRewind('sess-A', 'm2', { createdAt: 100 });

    const visible = repo.searchTranscriptFts('secret axolotl');
    expect(visible).toEqual([]);
    const all = repo.searchTranscriptFts('secret axolotl', { includeRewound: true });
    expect(all.map((h) => h.messageId)).toEqual(['m2']);
  });

  // ---- backfill --------------------------------------------------------------

  it('backfills all kinds from pre-existing messages and is idempotent', () => {
    db.exec('DROP TRIGGER IF EXISTS transcript_ai_fts;');
    const stmt = db.prepare(
      `INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls, thinking)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run('legacy1', 'sess-A', 'user', 'legacy quoll question', 1000, null, null);
    stmt.run(
      'legacy2',
      'sess-A',
      'assistant',
      'legacy quoll answer',
      2000,
      JSON.stringify([makeToolCall('tc1', 'Bash', { command: 'echo quoll' }, { output: 'quoll done' })]),
      'legacy quoll reasoning'
    );

    expect(allFtsRows(db)).toEqual([]);

    const inserted = repo.backfillTranscriptFts();
    expect(inserted).toBe(5); // user_text + assistant_text + reasoning + tool_input + tool_output

    expect(repo.searchTranscriptFts('quoll reasoning', { kinds: ['reasoning'] }).length).toBe(1);

    // 幂等：FTS 非空时不重复回填
    expect(repo.backfillTranscriptFts()).toBe(0);
  });

  // ---- around ----------------------------------------------------------------

  it('returns ±N messages around an anchor with matched flag', () => {
    for (let i = 1; i <= 9; i++) {
      repo.addMessage('sess-A', makeMessage(`m${i}`, `message number ${i}`, { timestamp: i * 1000 }));
    }
    const ctxResult = repo.getTranscriptAround('m5', { before: 2, after: 2 });
    expect(ctxResult).not.toBeNull();
    expect(ctxResult!.sessionId).toBe('sess-A');
    expect(ctxResult!.messages.map((m) => m.message.id)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
    expect(ctxResult!.messages.map((m) => m.matched)).toEqual([false, false, true, false, false]);
  });

  it('clips around window at session boundaries', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'first', { timestamp: 1000 }));
    repo.addMessage('sess-A', makeMessage('m2', 'second', { timestamp: 2000 }));
    const ctxResult = repo.getTranscriptAround('m1', { before: 5, after: 5 });
    expect(ctxResult!.messages.map((m) => m.message.id)).toEqual(['m1', 'm2']);
  });

  it('keeps insertion order for identical timestamps', () => {
    repo.addMessage('sess-A', makeMessage('t1', 'same ts one', { timestamp: 5000 }));
    repo.addMessage('sess-A', makeMessage('t2', 'same ts two', { timestamp: 5000 }));
    repo.addMessage('sess-A', makeMessage('t3', 'same ts three', { timestamp: 5000 }));
    const ctxResult = repo.getTranscriptAround('t2', { before: 5, after: 5 });
    expect(ctxResult!.messages.map((m) => m.message.id)).toEqual(['t1', 't2', 't3']);
  });

  it('skips meta/loop-internal and rewound neighbors', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'visible one', { timestamp: 1000 }));
    repo.addMessage('sess-A', makeMessage('meta', 'meta noise', { timestamp: 2000, isMeta: true }));
    repo.addMessage('sess-A', makeMessage('m2', 'visible two', { timestamp: 3000 }));
    const ctxResult = repo.getTranscriptAround('m1', { before: 0, after: 1 });
    expect(ctxResult!.messages.map((m) => m.message.id)).toEqual(['m1', 'm2']);
  });

  it('returns null for an unknown anchor', () => {
    expect(repo.getTranscriptAround('nope', {})).toBeNull();
  });

  it('does not cross session boundaries', () => {
    repo.addMessage('sess-A', makeMessage('a1', 'in A', { timestamp: 1000 }));
    repo.addMessage('sess-B', makeMessage('b1', 'in B', { timestamp: 1500 }));
    repo.addMessage('sess-A', makeMessage('a2', 'in A too', { timestamp: 2000 }));
    const ctxResult = repo.getTranscriptAround('a1', { before: 5, after: 5 });
    expect(ctxResult!.messages.map((m) => m.message.id)).toEqual(['a1', 'a2']);
  });
});

// ----------------------------------------------------------------------------
// 裸 schema 兼容 — CLI 自建库 / 旧库可能缺 thinking / visibility / is_meta 列。
// applyTranscriptFtsSchema 必须自带列守卫，否则 trigger 引用缺失列会让
// 之后所有 messages INSERT 在运行期报错（trigger 创建本身不校验列存在）。
// ----------------------------------------------------------------------------

describe('applyTranscriptFtsSchema — bare schema compatibility', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // 复制 CLI database.ts 的最小 messages 表（无 thinking/visibility/metadata 等列）
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tool_calls TEXT,
        tool_results TEXT,
        attachments TEXT,
        is_meta INTEGER NOT NULL DEFAULT 0
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('message inserts still work after applying the schema on a bare messages table', () => {
    applyTranscriptFtsSchema(db);

    // trigger 引用 thinking 列 — 若 schema 守卫缺失，这条 INSERT 运行期抛错
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('m1', 's1', 'assistant', 'bare schema echidna message', 1000, JSON.stringify([
      { id: 'tc1', name: 'Bash', arguments: { command: 'echo echidna' }, result: { toolCallId: 'tc1', success: true, output: 'echidna out' } },
    ]));

    const kinds = (db.prepare('SELECT kind FROM transcript_fts ORDER BY kind').all() as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toEqual(['assistant_text', 'tool_input', 'tool_output']);
  });

  it('repository search works against a bare-schema db (visibility column absent before apply)', () => {
    applyTranscriptFtsSchema(db);
    const repo = new SessionRepository(db);
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, timestamp)
       VALUES (?, ?, ?, ?, ?)`
    ).run('m1', 's1', 'user', 'bare schema numbat question', 1000);

    const hits = repo.searchTranscriptFts('numbat question');
    expect(hits.length).toBe(1);
    expect(hits[0].messageId).toBe('m1');
  });
});
