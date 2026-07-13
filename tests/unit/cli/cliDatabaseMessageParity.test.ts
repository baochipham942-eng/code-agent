import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { Message, Session } from '../../../src/shared/contract';
import { CLIDatabaseService } from '../../../src/cli/database';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';

const session: Session = {
  id: 'sess-parity',
  title: 'CLI/core message parity',
  modelConfig: { provider: 'zhipu', model: 'glm-5' },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
} as Session;

const inlineAttachmentBlock = [
  '<attachment name="legacy-inline.xlsx" category="excel">',
  'inline attachment payload',
  '</attachment>',
].join('\n');

const visibleContent = [
  'Visible answer',
  '',
  '```chart',
  '{"title":"Revenue","data":[1,2,3]}',
  '```',
].join('\n');

const richMessage: Message = {
  id: 'msg-rich',
  role: 'assistant',
  content: `${inlineAttachmentBlock}\n\n${visibleContent}`,
  timestamp: 1_700_000_000_100,
  thinking: 'Check every persisted field before answering.',
  contentParts: [
    { type: 'text', text: 'Visible answer' },
    { type: 'tool_call', toolCallId: 'call-chart' },
  ],
  attachments: [
    {
      id: 'image-1',
      type: 'image',
      category: 'image',
      name: 'preview.png',
      size: 24,
      mimeType: 'image/png',
      data: 'data:image/png;base64,c21hbGw=',
      thumbnail: 'data:image/png;base64,dGh1bWI=',
      metadata: { source: 'clipboard', transcriptionState: 'ready' },
    },
    {
      id: 'sheet-1',
      type: 'file',
      category: 'excel',
      name: 'report.xlsx',
      size: 128,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: 'Sheet1\nA,B\n1,2',
      path: '/tmp/report.xlsx',
      sheetCount: 1,
      rowCount: 2,
      sheetsJson: '{"Sheet1":[["A","B"],[1,2]]}',
      metadata: { source: 'upload', materializationState: 'ready' },
    },
  ],
  metadata: {
    turnQuality: {
      capabilities: {
        agentId: 'default',
        agentName: 'Default',
        requestedAgentId: 'default',
      },
    },
  },
};

function expectRichProjection(message: Message | undefined): void {
  expect(message).toBeDefined();
  expect(message).toMatchObject({
    id: richMessage.id,
    role: 'assistant',
    content: visibleContent,
    thinking: richMessage.thinking,
    contentParts: richMessage.contentParts,
    metadata: richMessage.metadata,
    attachments: richMessage.attachments,
  });
  expect(message?.content).not.toContain('<attachment');
  expect(message?.artifacts).toEqual([
    expect.objectContaining({
      type: 'chart',
      title: 'Revenue',
      content: '{"title":"Revenue","data":[1,2,3]}',
    }),
  ]);
}

describe('CLIDatabaseService/core DatabaseService message parity', () => {
  let tmpDir: string;
  let prevDataDir: string | undefined;
  let cliDb: CLIDatabaseService;
  let coreDb: DatabaseService | undefined;

  beforeEach(async () => {
    prevDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-db-message-parity-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
    cliDb = new CLIDatabaseService();
    await cliDb.initialize();
    cliDb.createSession(session);
  });

  afterEach(() => {
    try { coreDb?.close(); } catch { /* noop */ }
    try { cliDb.close(); } catch { /* noop */ }
    if (prevDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = prevDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('CLI 写入全字段消息后，CLI 与 core 从同一 sqlite 文件读回一致', async () => {
    cliDb.addMessage(session.id, richMessage);

    expectRichProjection(cliDb.getMessages(session.id).find((message) => message.id === richMessage.id));

    coreDb = new DatabaseService();
    const coreConnection = new Database(path.join(tmpDir, 'code-agent.db'));
    Object.assign(coreDb as unknown as Record<string, unknown>, {
      db: coreConnection,
      sessionRepo: new SessionRepository(coreConnection),
    });

    expectRichProjection(coreDb.getMessages(session.id).find((message) => message.id === richMessage.id));
  });

  it('getRecentMessages 与 getTranscriptAround 使用同一完整消息投影', () => {
    cliDb.addMessage(session.id, richMessage);

    expectRichProjection(cliDb.getRecentMessages(session.id, 10).find((message) => message.id === richMessage.id));
    expectRichProjection(cliDb.getTranscriptAround(richMessage.id)?.messages.find(({ matched }) => matched)?.message);
  });

  it('兼容历史仅含 7 个基础字段的 attachments JSON', () => {
    const legacyAttachment = {
      id: 'legacy-1',
      type: 'file',
      category: 'text',
      name: 'legacy.txt',
      size: 12,
      mimeType: 'text/plain',
      path: '/tmp/legacy.txt',
    };
    cliDb.addMessage(session.id, {
      id: 'msg-legacy',
      role: 'user',
      content: 'legacy attachment',
      timestamp: 1_700_000_000_200,
    });
    cliDb.getDb()!
      .prepare('UPDATE messages SET attachments = ? WHERE id = ?')
      .run(JSON.stringify([legacyAttachment]), 'msg-legacy');

    const message = cliDb.getMessages(session.id).find(({ id }) => id === 'msg-legacy');
    expect(message?.attachments).toEqual([legacyAttachment]);
    expect(message?.attachments?.[0]?.data).toBeUndefined();
    expect(message?.attachments?.[0]?.metadata).toBeUndefined();
  });
});
