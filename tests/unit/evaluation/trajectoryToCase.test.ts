// ---------------------------------------------------------------------------
// 批 1 回流桥核心逻辑：三入口抽取 + prompt 回溯 + YAML 草稿构建 + 幂等命名
// ---------------------------------------------------------------------------
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');

import Database from 'better-sqlite3';
import { load as parseYaml } from 'js-yaml';
import {
  buildDraftYaml,
  draftFileName,
  queryNegativeFeedback,
  resolveFeedbackPrompt,
  selectRiskTurnMessages,
  journalPatternToDraftSeed,
} from '../../../src/host/evaluation/trajectoryToCase';
import type { Message } from '../../../src/shared/contract';

function makeDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE telemetry_feedback (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      message_id TEXT,
      rating INTEGER NOT NULL,
      comment TEXT,
      full_content TEXT,
      created_at INTEGER NOT NULL,
      synced_at INTEGER
    );
  `);
  return db;
}

function msg(partial: Partial<Message> & { id: string; role: Message['role'] }): Message {
  return {
    content: '',
    timestamp: 0,
    ...partial,
  } as Message;
}

describe('queryNegativeFeedback', () => {
  it('只取 rating=-1，按时间倒序，带 limit', () => {
    const db = makeDb();
    const insert = db.prepare(
      'INSERT INTO telemetry_feedback (id, session_id, turn_id, message_id, rating, comment, created_at) VALUES (?,?,?,?,?,?,?)',
    );
    insert.run('f1', 's1', 't1', 'm1', -1, 'bad answer', 100);
    insert.run('f2', 's1', null, 'm2', 1, 'nice', 200);
    insert.run('f3', 's2', 't3', 'm3', -1, null, 300);

    const rows = queryNegativeFeedback(db, { limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(['f3', 'f1']);
    expect(rows[0]).toMatchObject({ sessionId: 's2', turnId: 't3', messageId: 'm3', comment: null });
  });
});

describe('resolveFeedbackPrompt（两级 fallback）', () => {
  const messages: Message[] = [
    msg({ id: 'u1', role: 'user', content: '帮我做个游戏', timestamp: 1 }),
    msg({ id: 'a1', role: 'assistant', content: '好的', timestamp: 2 }),
    msg({ id: 'u2', role: 'user', content: '加个存档功能', timestamp: 3 }),
    msg({ id: 'a2', role: 'assistant', content: '加了', timestamp: 4 }),
  ];

  it('feedback.messageId 命中 assistant 时回溯最近的 user 原话', () => {
    expect(resolveFeedbackPrompt(messages, { messageId: 'a2', turnId: 'a2' })).toBe('加个存档功能');
  });

  it('messageId 不存在时回退到会话最后一条 user 原话', () => {
    expect(resolveFeedbackPrompt(messages, { messageId: 'ghost', turnId: null })).toBe('加个存档功能');
  });

  it('无 user 消息返回 null', () => {
    expect(resolveFeedbackPrompt([msg({ id: 'a', role: 'assistant', content: 'x' })], { messageId: 'a', turnId: null })).toBeNull();
  });
});

describe('selectRiskTurnMessages', () => {
  it('只取 metadata.turnQuality.status=risk 的 assistant 消息', () => {
    const messages: Message[] = [
      msg({ id: 'a1', role: 'assistant', content: 'ok', metadata: { turnQuality: { score: { grade: 'good' } } } as never }),
      msg({ id: 'a2', role: 'assistant', content: 'bad', metadata: { turnQuality: { score: { grade: 'risk' } } } as never }),
      msg({ id: 'u1', role: 'user', content: 'q' }),
    ];
    expect(selectRiskTurnMessages(messages).map((m) => m.id)).toEqual(['a2']);
  });
});

describe('journalPatternToDraftSeed', () => {
  it('把 failure journal pattern 变成草稿种子（prompt 用样本错误+模式描述）', () => {
    const seed = journalPatternToDraftSeed({
      key: 'Write|validation|missing meta',
      toolName: 'Write',
      errorCategory: 'validation',
      pattern: '已写入, 验收失败 missing __GAME_META__',
      count: 3,
      sessions: ['s9'],
      firstSeen: 1,
      lastSeen: 2,
      sampleError: 'Write failed: missing __GAME_META__',
    });
    expect(seed.sourceSessionId).toBe('s9');
    expect(seed.note).toContain('Write');
    expect(seed.note).toContain('3');
  });
});

describe('buildDraftYaml', () => {
  it('产出可被 js-yaml 解析的草稿：expect 空、reviewStatus pending、含断言硬化 checklist 注释', () => {
    const yamlText = buildDraftYaml({
      id: 'draft-feedback-s1-1',
      source: 'feedback',
      prompt: '帮我做个游戏',
      sourceSessionId: 's1',
      note: '用户点踩：bad answer',
    });

    expect(yamlText).toContain('# 断言硬化 checklist');
    expect(yamlText).toContain('deterministic');

    const parsed = parseYaml(yamlText) as { name: string; cases: Array<Record<string, unknown>> };
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.cases[0]).toMatchObject({
      id: 'draft-feedback-s1-1',
      prompt: '帮我做个游戏',
      sourceSessionId: 's1',
      reviewStatus: 'pending',
    });
    expect(parsed.cases[0].expect).toEqual({});
  });

  it('prompt 含特殊字符时 YAML 仍安全', () => {
    const yamlText = buildDraftYaml({
      id: 'draft-x',
      source: 'quality',
      prompt: 'a: b\n- "quoted" #hash',
      sourceSessionId: 's1',
    });
    const parsed = parseYaml(yamlText) as { cases: Array<{ prompt: string }> };
    expect(parsed.cases[0].prompt).toBe('a: b\n- "quoted" #hash');
  });
});

describe('draftFileName（幂等）', () => {
  it('同 source+session+序号 → 同文件名；不同 source 不冲突', () => {
    expect(draftFileName('feedback', 's1', 0)).toBe(draftFileName('feedback', 's1', 0));
    expect(draftFileName('feedback', 's1', 0)).not.toBe(draftFileName('quality', 's1', 0));
    expect(draftFileName('feedback', 'web-session-123', 1)).toMatch(/^draft-feedback-web-session-123-1\.yaml$/);
  });
});

describe('resolveTurnPrompt（telemetry_turns 优先级）', () => {
  function makeTurnsDb() {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE telemetry_turns (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_number INTEGER,
      start_time INTEGER NOT NULL, user_prompt TEXT
    );`);
    const ins = db.prepare('INSERT INTO telemetry_turns (id, session_id, turn_number, start_time, user_prompt) VALUES (?,?,?,?,?)');
    ins.run('t1', 's1', 1, 100, '做一个平台跳跃小游戏');
    ins.run('t2', 's1', 2, 200, null);
    ins.run('t3', 's1', 3, 300, '加个存档');
    return db;
  }

  it('turnId 精确命中且 user_prompt 非空 → 直接用', async () => {
    const { resolveTurnPrompt } = await import('../../../src/host/evaluation/trajectoryToCase');
    expect(resolveTurnPrompt(makeTurnsDb(), 's1', { turnId: 't3', anchorTimestamp: null })).toBe('加个存档');
  });

  it('turnId 命中但 user_prompt 空 → 回退时间锚定之前最近的非空 prompt', async () => {
    const { resolveTurnPrompt } = await import('../../../src/host/evaluation/trajectoryToCase');
    expect(resolveTurnPrompt(makeTurnsDb(), 's1', { turnId: 't2', anchorTimestamp: 250 })).toBe('做一个平台跳跃小游戏');
  });

  it('无 turnId 无锚点 → 取会话最后一条非空 user_prompt', async () => {
    const { resolveTurnPrompt } = await import('../../../src/host/evaluation/trajectoryToCase');
    expect(resolveTurnPrompt(makeTurnsDb(), 's1', { turnId: null, anchorTimestamp: null })).toBe('加个存档');
  });

  it('turns 表无该会话数据 → null（让调用方退 messages 回溯）', async () => {
    const { resolveTurnPrompt } = await import('../../../src/host/evaluation/trajectoryToCase');
    expect(resolveTurnPrompt(makeTurnsDb(), 's-none', { turnId: null, anchorTimestamp: null })).toBeNull();
  });
});
