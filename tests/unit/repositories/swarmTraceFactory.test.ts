// ============================================================================
// swarmTraceFactory Tests — 验证 CODE_AGENT_SWARM_STORAGE 环境变量切实例
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { createSwarmTraceRepo } from '../../../src/host/services/core/repositories/swarmTraceFactory';
import { SwarmTraceRepository } from '../../../src/host/services/core/repositories/SwarmTraceRepository';
import { FileSwarmTraceRepository } from '../../../src/host/services/core/repositories/FileSwarmTraceRepository';
import { SWARM_TRACE } from '../../../src/shared/constants/storage';

const ENV_KEY = SWARM_TRACE.STORAGE_MODE_ENV;

describe('createSwarmTraceRepo (Phase 3 dispatch)', () => {
  let db: BetterSqlite3.Database;
  let tmpDir: string;
  let savedEnv: string | undefined;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-factory-'));
    savedEnv = process.env[ENV_KEY];
    savedDataDir = process.env.CODE_AGENT_DATA_DIR;
    delete process.env[ENV_KEY];
    delete process.env.CODE_AGENT_DATA_DIR;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    if (savedDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = savedDataDir;
  });

  it('env 缺省 → SwarmTraceRepository (SQLite)', () => {
    const repo = createSwarmTraceRepo(db);
    expect(repo).toBeInstanceOf(SwarmTraceRepository);
  });

  it('env=file → FileSwarmTraceRepository (JSONL)', () => {
    process.env[ENV_KEY] = 'file';
    const repo = createSwarmTraceRepo(db, { storageDirOverride: tmpDir });
    expect(repo).toBeInstanceOf(FileSwarmTraceRepository);
  });

  it('env=sqlite (其他非 file 值) → 走 SQL 不走文件', () => {
    process.env[ENV_KEY] = 'sqlite';
    const repo = createSwarmTraceRepo(db, { storageDirOverride: tmpDir });
    expect(repo).toBeInstanceOf(SwarmTraceRepository);
  });

  it('env=file 路径下 storageDirOverride 生效,文件实际落入 override 目录', () => {
    process.env[ENV_KEY] = 'file';
    const repo = createSwarmTraceRepo(db, { storageDirOverride: tmpDir });
    repo.startRun({
      id: 'run-1',
      sessionId: 'session-1',
      coordinator: 'hybrid',
      startedAt: 1_700_000_000_000,
      totalAgents: 1,
      trigger: 'llm-spawn',
    });
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('run-1.jsonl'));
    expect(files).toHaveLength(1);
  });

  it('env=file 且无 override 时使用 CODE_AGENT_DATA_DIR/swarm-runs', () => {
    process.env[ENV_KEY] = 'file';
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
    const repo = createSwarmTraceRepo(db);
    repo.startRun({
      id: 'run-data-dir',
      sessionId: 'session-1',
      coordinator: 'hybrid',
      startedAt: 1_700_000_000_000,
      totalAgents: 1,
      trigger: 'llm-spawn',
    });
    const storageDir = path.join(tmpDir, SWARM_TRACE.STORAGE_DIR);
    const files = fs.readdirSync(storageDir).filter((f) => f.endsWith('run-data-dir.jsonl'));
    expect(files).toHaveLength(1);
  });
});
