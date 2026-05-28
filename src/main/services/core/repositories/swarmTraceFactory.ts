// ============================================================================
// Swarm Trace Repository Factory — 按环境变量在 SQLite / JSONL 之间路由
// ============================================================================
//
// 设计目的:
//   - 把 dispatch 逻辑从 DatabaseService 抽出来,让它可被 unit test
//   - 允许 storageDir override,测试不污染用户真实 ~/.code-agent/
// ============================================================================

import path from 'path';
import type BetterSqlite3 from 'better-sqlite3';
import { SwarmTraceRepository } from './SwarmTraceRepository';
import { FileSwarmTraceRepository } from './FileSwarmTraceRepository';
import { SWARM_TRACE } from '../../../../shared/constants/storage';
import { getUserConfigDir } from '../../../config/configPaths';
import type { SwarmTraceRepo } from '../../../../shared/contract/swarmTrace';

export interface CreateSwarmTraceRepoOptions {
  /** 测试用:覆盖 file 模式下的 storageDir,避免污染用户目录 */
  storageDirOverride?: string;
}

/**
 * 根据 CODE_AGENT_SWARM_STORAGE 环境变量返回对应的 SwarmTraceRepo 实现。
 *
 *   'file' → FileSwarmTraceRepository(jsonl 落 <storageDir> 或 ~/.code-agent/swarm-runs/)
 *   其他/缺省 → SwarmTraceRepository(SQLite)
 */
export function createSwarmTraceRepo(
  db: BetterSqlite3.Database,
  options: CreateSwarmTraceRepoOptions = {},
): SwarmTraceRepo {
  const mode = process.env[SWARM_TRACE.STORAGE_MODE_ENV];
  if (mode === 'file') {
    const storageDir =
      options.storageDirOverride ?? path.join(getUserConfigDir(), SWARM_TRACE.STORAGE_DIR);
    return new FileSwarmTraceRepository(storageDir);
  }
  return new SwarmTraceRepository(db);
}
