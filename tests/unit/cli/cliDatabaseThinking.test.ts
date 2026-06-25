// CLI 数据库 thinking 持久化回归测试。
// 背景：webServer/CLI 模式经 CLISessionManager → CLIDatabaseService.addMessage 落库，
// 但旧实现的 INSERT 列与读取映射器都漏了 thinking 列 → MiMo 流式思考刷新即丢。
// 用户拍板「持久化思考（对齐 claude.ai）」，本测试锁住 thinking 的写入与回读。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Message, Session } from '../../../src/shared/contract';
import { CLIDatabaseService } from '../../../src/cli/database';

describe('CLIDatabaseService thinking 持久化', () => {
  let tmpDir: string;
  let prevDataDir: string | undefined;
  let db: CLIDatabaseService;

  beforeEach(async () => {
    prevDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-db-thinking-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
    db = new CLIDatabaseService();
    await db.initialize();
    const session: Session = {
      id: 'sess-1',
      title: 'thinking 测试',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as Session;
    db.createSession(session);
  });

  afterEach(() => {
    try { db.close?.(); } catch { /* noop */ }
    if (prevDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = prevDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('落库并回读 assistant 消息的 thinking（getMessages）', () => {
    const msg: Message = {
      id: 'm-think-1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      thinking: '现在时间是 2026 年 6 月，我应该先联网搜索再总结。',
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: { query: 'x' } }],
      contentParts: [{ type: 'tool_call', toolCallId: 'call_1' }],
    };
    db.addMessage('sess-1', msg);

    const read = db.getMessages('sess-1');
    const got = read.find((m) => m.id === 'm-think-1');
    expect(got).toBeDefined();
    expect(got!.thinking).toBe(msg.thinking);
  });

  it('getRecentMessages 同样回读 thinking', () => {
    db.addMessage('sess-1', {
      id: 'm-think-2',
      role: 'assistant',
      content: '答案在此',
      timestamp: Date.now(),
      thinking: '逐步推理：第一步…第二步…',
    } as Message);

    const recent = db.getRecentMessages('sess-1', 10);
    const got = recent.find((m) => m.id === 'm-think-2');
    expect(got?.thinking).toBe('逐步推理：第一步…第二步…');
  });

  it('reasoning 字段在 thinking 缺失时兜底落库（与主 SessionRepository 对齐）', () => {
    db.addMessage('sess-1', {
      id: 'm-think-3',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      reasoning: '仅有 reasoning，没有 thinking',
      toolCalls: [{ id: 'call_2', name: 'web_search', arguments: {} }],
    } as Message);

    const got = db.getMessages('sess-1').find((m) => m.id === 'm-think-3');
    expect(got?.thinking).toBe('仅有 reasoning，没有 thinking');
  });
});
