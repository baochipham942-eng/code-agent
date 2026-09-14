import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  markFtsTableAvailable,
  repairFtsTable,
} from '../../../src/host/services/core/database/ftsRepair';
import { setIntegrityCheckListener } from '../../../src/host/services/core/database/integrityGate';
import { SQLITE_FTS, SQLITE_INTEGRITY } from '../../../src/shared/constants';
import { DatabaseIntegrityError } from '../../../src/host/services/core/database/sqliteErrors';
import {
  applyDbIntegrityOutcome,
  getPersistenceHealth,
  markPersistenceDegraded,
  setDbAvailable,
  toCachedSessionMessages,
} from '../../../src/web/helpers/sessionCache';
import {
  seedSessionMessagesFromPersisted,
  sessionMessagesProjection as sessionMessages,
} from '../../../src/web/helpers/webSessionStore';

afterEach(() => {
  repairFtsTable.resetStateForTests();
  setIntegrityCheckListener(null);
  setDbAvailable(false, new Error('test reset'));
  sessionMessages.clear();
});

describe('web session persistence health', () => {
  it('reports durable database persistence when DB is available', () => {
    setDbAvailable(true);

    expect(getPersistenceHealth()).toMatchObject({
      status: 'available',
      mode: 'database',
      durable: true,
      message: '历史会持久化到本机数据库。',
    });
  });

  it('overlays FTS_DISABLED as degraded without flipping durable off', () => {
    setDbAvailable(true);
    repairFtsTable.markDisabledForTests('session_messages_fts');

    expect(getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      mode: 'database',
      durable: true,
      reason: SQLITE_FTS.DISABLED_REASON,
    });
  });

  it('overlays FTS_EMPTY_RECREATED as degraded while the index awaits backfill', () => {
    setDbAvailable(true);
    repairFtsTable.markEmptyForTests('session_messages_fts');

    expect(getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      mode: 'database',
      durable: true,
      reason: SQLITE_FTS.EMPTY_RECREATED_REASON,
    });
  });

  it('keeps FTS_DISABLED precedence when a table is disabled and another is empty', () => {
    setDbAvailable(true);
    repairFtsTable.markEmptyForTests('session_messages_fts');
    repairFtsTable.markDisabledForTests('transcript_fts');

    expect(getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      reason: SQLITE_FTS.DISABLED_REASON,
    });
  });

  it('recovers to available once the empty state clears after backfill', () => {
    setDbAvailable(true);
    repairFtsTable.markEmptyForTests('session_messages_fts');
    expect(getPersistenceHealth().status).toBe('degraded');

    markFtsTableAvailable('session_messages_fts');
    expect(getPersistenceHealth()).toMatchObject({
      status: 'available',
      mode: 'database',
      durable: true,
    });
    expect(getPersistenceHealth().reason).toBeUndefined();
  });

  it('reports memory-only fallback with the init failure reason', () => {
    setDbAvailable(false, new Error('native binding missing'));

    expect(getPersistenceHealth()).toMatchObject({
      status: 'unavailable',
      mode: 'memory',
      durable: false,
      message: '历史持久化不可用，当前只会话内有效。',
      reason: 'native binding missing',
    });
  });

  it('uses the stable DB_CORRUPT_NO_BACKUP code instead of a raw error message', () => {
    setDbAvailable(false, new DatabaseIntegrityError(SQLITE_INTEGRITY.CORRUPT_NO_BACKUP, 'do-not-leak'));

    expect(getPersistenceHealth()).toMatchObject({
      status: 'unavailable',
      mode: 'memory',
      durable: false,
      reason: SQLITE_INTEGRITY.CORRUPT_NO_BACKUP,
    });
    expect(getPersistenceHealth().reason).not.toContain('do-not-leak');
  });

  it('reports recovered from backup without flipping durable off', () => {
    setDbAvailable(true);
    applyDbIntegrityOutcome({ kind: 'recovered', backupTakenAt: 1_700_000_000_000, isolatedPath: '/tmp/x' });

    expect(getPersistenceHealth()).toMatchObject({
      status: 'recovered',
      mode: 'database',
      durable: true,
      reason: `${SQLITE_INTEGRITY.RECOVERED_FROM_BACKUP}:2023-11-14T22:13:20.000Z`,
    });
  });

  it('marks local damage as degraded', () => {
    setDbAvailable(true);
    markPersistenceDegraded(SQLITE_INTEGRITY.LOCAL_CORRUPT);
    expect(getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      reason: SQLITE_INTEGRITY.LOCAL_CORRUPT,
      durable: true,
    });
  });

  // recovered 是一次性事件通知；持续性降级（quick_check 失败）优先于它展示
  it('lets a later quick_check failure override the recovered notice', () => {
    setDbAvailable(true);
    applyDbIntegrityOutcome({ kind: 'recovered', backupTakenAt: 1, isolatedPath: '/tmp/x' });
    expect(getPersistenceHealth().status).toBe('recovered');

    markPersistenceDegraded(SQLITE_INTEGRITY.QUICK_CHECK_FAILED);
    expect(getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      reason: SQLITE_INTEGRITY.QUICK_CHECK_FAILED,
      durable: true,
    });
  });

  // recovered 不遮挡 FTS 持续降级：恢复出来的库 FTS 坏了/回填中，用户要看到搜索降级
  it('overlays FTS degradation on top of the recovered notice', () => {
    setDbAvailable(true);
    applyDbIntegrityOutcome({ kind: 'recovered', backupTakenAt: 1, isolatedPath: '/tmp/x' });
    repairFtsTable.markDisabledForTests('session_messages_fts');
    expect(getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      reason: SQLITE_FTS.DISABLED_REASON,
      durable: true,
    });
  });

  it('keeps the recovered notice when nothing else is degraded', () => {
    setDbAvailable(true);
    applyDbIntegrityOutcome({ kind: 'recovered', backupTakenAt: 1, isolatedPath: '/tmp/x' });
    repairFtsTable.markEmptyForTests('session_messages_fts');
    expect(getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      reason: SQLITE_FTS.EMPTY_RECREATED_REASON,
    });

    repairFtsTable.resetStateForTests();
    expect(getPersistenceHealth().status).toBe('recovered');
  });
});

describe('toCachedSessionMessages metadata 保留', () => {
  it('assistant 消息的 metadata（turnQuality）经缓存水合不丢失', () => {
    const metadata = {
      turnQuality: {
        capabilities: { agentId: 'explore', agentName: 'Explorer', requestedAgentId: 'explore' },
      },
    } as Message['metadata'];
    const cached = toCachedSessionMessages([
      {
        id: 'm-1',
        role: 'assistant',
        content: '回复',
        timestamp: 100,
        metadata,
      } as Message,
    ]);
    expect(cached[0]?.metadata).toEqual(metadata);
  });

  it('preserves inference-boundary markers needed to exclude meta and rewound history', () => {
    const cached = toCachedSessionMessages([
      {
        id: 'meta-message',
        role: 'user',
        content: '后台子任务提示',
        timestamp: 100,
        isMeta: true,
      } as Message,
      {
        id: 'rewound-message',
        role: 'user',
        content: '已撤回',
        timestamp: 101,
        visibility: 'rewound',
      } as Message,
    ]);

    expect(cached).toEqual([
      expect.objectContaining({ id: 'meta-message', isMeta: true }),
      expect.objectContaining({ id: 'rewound-message', visibility: 'rewound' }),
    ]);
  });

  // 工单行为不变清单 #5：持久化消息转缓存时所有富字段原样保留。
  it('preserves thinking, contentParts, artifacts, attachments and metadata together', () => {
    const richMessage = {
      id: 'm-rich',
      role: 'assistant',
      content: '富字段回复',
      timestamp: 200,
      thinking: '思考过程',
      contentParts: [
        { type: 'text', text: '富字段' },
        { type: 'tool_call', toolCallId: 'tool-rich' },
      ],
      artifacts: [{
        id: 'artifact-rich',
        type: 'chart',
        content: '{"title":"Rich"}',
        title: 'Rich',
        version: 1,
      }],
      attachments: [{
        id: 'attachment-rich',
        type: 'file',
        category: 'text',
        name: 'rich.txt',
        size: 4,
        mimeType: 'text/plain',
        data: 'rich',
      }],
      metadata: {
        turnQuality: {
          capabilities: { agentId: 'explore', agentName: 'Explorer' },
        },
      },
    } as Message;

    expect(toCachedSessionMessages([richMessage])).toEqual([{
      id: 'm-rich',
      role: 'assistant',
      content: '富字段回复',
      timestamp: 200,
      toolCalls: undefined,
      thinking: '思考过程',
      contentParts: richMessage.contentParts,
      artifacts: richMessage.artifacts,
      attachments: richMessage.attachments,
      metadata: richMessage.metadata,
    }]);
  });
});

describe('sessionMessages LRU characterization', () => {
  // 工单行为不变清单 #7：缓存最多 50 个会话，按插入顺序逐出最旧 key。
  it('evicts the oldest session after persisted hydration exceeds 50 entries', () => {
    for (let index = 0; index < 51; index += 1) {
      seedSessionMessagesFromPersisted(`session-${index}`, [{
        id: `message-${index}`,
        role: 'user',
        content: `message-${index}`,
        timestamp: index,
      } as Message]);
    }

    expect(sessionMessages.size).toBe(50);
    expect(sessionMessages.has('session-0')).toBe(false);
    expect(sessionMessages.get('session-1')?.[0]?.id).toBe('message-1');
    expect(sessionMessages.get('session-50')?.[0]?.id).toBe('message-50');
  });
});
