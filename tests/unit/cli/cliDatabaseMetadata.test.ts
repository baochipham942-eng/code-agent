// CLI 数据库 message.metadata 持久化回归测试。
// 背景：web 生产路径（/api/agent/run）的 assistant 最终消息由 AgentLoop 经
// CLISessionManager → CLIDatabaseService.addMessage 落库，但 INSERT 列与读取
// 映射器都漏了 metadata 列 → turnQuality（安静徽标数据）reload 即丢。
// 与 thinking 列（cliDatabaseThinking.test.ts）同款历史 bug，本测试锁住写入与回读。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Message, Session } from '../../../src/shared/contract';
import { CLIDatabaseService } from '../../../src/cli/database';

const turnQualityMetadata: Message['metadata'] = {
  turnQuality: {
    capabilities: {
      agentId: 'explore',
      agentName: 'Explorer',
      requestedAgentId: 'explore',
    },
  },
} as Message['metadata'];

describe('CLIDatabaseService metadata 持久化', () => {
  let tmpDir: string;
  let prevDataDir: string | undefined;
  let db: CLIDatabaseService;

  beforeEach(async () => {
    prevDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-db-metadata-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
    db = new CLIDatabaseService();
    await db.initialize();
    const session: Session = {
      id: 'sess-1',
      title: 'metadata 测试',
      modelConfig: { provider: 'zhipu', model: 'glm-5' },
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

  it('落库并回读 assistant 消息的 metadata.turnQuality（getMessages）', () => {
    const msg: Message = {
      id: 'm-meta-1',
      role: 'assistant',
      content: '最终回复',
      timestamp: Date.now(),
      metadata: turnQualityMetadata,
    };
    db.addMessage('sess-1', msg);

    const got = db.getMessages('sess-1').find((m) => m.id === 'm-meta-1');
    expect(got).toBeDefined();
    expect(got!.metadata).toEqual(turnQualityMetadata);
  });

  it('getRecentMessages 同样回读 metadata', () => {
    db.addMessage('sess-1', {
      id: 'm-meta-2',
      role: 'assistant',
      content: '降级场景',
      timestamp: Date.now(),
      metadata: {
        turnQuality: {
          capabilities: {
            agentId: 'default',
            agentName: 'default',
            requestedAgentId: '__ghost_agent__',
          },
        },
      },
    } as Message);

    const got = db.getRecentMessages('sess-1', 10).find((m) => m.id === 'm-meta-2');
    expect(got?.metadata).toEqual({
      turnQuality: {
        capabilities: {
          agentId: 'default',
          agentName: 'default',
          requestedAgentId: '__ghost_agent__',
        },
      },
    });
  });

  it('无 metadata 的消息回读为 undefined（不落 "{}" 噪声）', () => {
    db.addMessage('sess-1', {
      id: 'm-meta-3',
      role: 'assistant',
      content: '无元数据',
      timestamp: Date.now(),
    } as Message);

    const got = db.getMessages('sess-1').find((m) => m.id === 'm-meta-3');
    expect(got).toBeDefined();
    expect(got!.metadata).toBeUndefined();
  });
});
