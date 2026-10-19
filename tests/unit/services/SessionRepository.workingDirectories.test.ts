// ============================================================================
// N-DELIVERABLE-WORKDIR-LAZY rework r2：懒开目录撞名判定的名字占用查询。
// listRecordedWorkingDirectories 返回未删除会话行已记下的工作目录（DISTINCT），
// 供规划器把「已记下但尚未落盘」的路径当占用；exceptSessionId 排除自己。
// 查询独立在 sessionRepositoryWorkingDirectories 助手里（SessionRepository god-file
// 已顶在 max-lines 1000 上，加不了薄委托），经 DatabaseService 门面暴露。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { listRecordedWorkingDirectories } from '../../../src/host/services/core/repositories/sessionRepositoryWorkingDirectories';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import type { Session } from '../../../src/shared/contract/session';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: 'Session',
    modelConfig: {
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
    } as Session['modelConfig'],
    workingDirectory: '/repo/code-agent',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('listRecordedWorkingDirectories (rework r2)', () => {
  let db: BetterSqlite3.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    applyTestSessionSchema(db);
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns the distinct working directories recorded by live sessions', () => {
    repo.createSession(makeSession({ id: 'a', workingDirectory: '/Neo/任务_1011_纪要' }));
    repo.createSession(makeSession({ id: 'b', workingDirectory: '/Neo/任务_1011_纪要' }));
    repo.createSession(makeSession({ id: 'c', workingDirectory: '/Neo/任务_1011_周报' }));
    // makeSession 默认带 workingDirectory：这里要一条「没有目录」的行（空串入库为 NULL）
    repo.createSession(makeSession({ id: 'e', workingDirectory: '' }));

    expect(listRecordedWorkingDirectories(db).sort()).toEqual([
      '/Neo/任务_1011_周报',
      '/Neo/任务_1011_纪要',
    ]);
  });

  it('ignores deleted sessions but keeps archived ones claimable', () => {
    repo.createSession(makeSession({ id: 'a', workingDirectory: '/Neo/任务_1011_纪要' }));
    repo.createSession(makeSession({ id: 'archived', workingDirectory: '/Neo/任务_1011_周报' }));
    repo.updateSession('archived', { status: 'archived' });
    repo.createSession(makeSession({ id: 'gone', workingDirectory: '/Neo/任务_1011_草稿' }));
    repo.updateSession('gone', {}, { isDeleted: true });

    expect(listRecordedWorkingDirectories(db).sort()).toEqual([
      '/Neo/任务_1011_周报',
      '/Neo/任务_1011_纪要',
    ]);
  });

  it('excludes the given session (exceptSessionId) from the claim set', () => {
    repo.createSession(makeSession({ id: 'a', workingDirectory: '/Neo/任务_1011_纪要' }));
    repo.createSession(makeSession({ id: 'b', workingDirectory: '/Neo/任务_1011_周报' }));

    expect(listRecordedWorkingDirectories(db, 'a')).toEqual(['/Neo/任务_1011_周报']);
    expect(listRecordedWorkingDirectories(db, 'missing-id').sort()).toEqual([
      '/Neo/任务_1011_周报',
      '/Neo/任务_1011_纪要',
    ]);
  });
});
