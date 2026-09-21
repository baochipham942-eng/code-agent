/**
 * SQLITE_BUSY 自动重试（issue #1992）。
 *
 * 为什么 busy_timeout 不够：WAL 多进程共享同库时，deferred 事务先读后写
 * 升级出的 SQLITE_BUSY_SNAPSHOT 不进 busy handler，sqlite 立即抛
 * "database is locked"；busy_timeout 到期的普通写锁等待也是同类错误。
 * 两种都可安全整体重跑（事务已回滚 / 语句未生效）。重试同步执行：
 * busy_timeout 本身已阻塞等待过，快照冲突立刻重拿快照即可。
 */

import { SQLITE_BUSY } from '../../../../shared/constants';
import { isSqliteBusyError } from './sqliteErrors';

export function runWithSqliteBusyRetry<T>(fn: () => T): T {
  const attempts = 1 + SQLITE_BUSY.WRITE_RETRY_LIMIT;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt + 1 >= attempts) throw err;
    }
  }
  throw new Error('unreachable');
}
