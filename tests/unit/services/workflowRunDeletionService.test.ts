// ============================================================================
// workflowRunDeletionService —— 删除 workflow run 前的 patch 安全网
// 真实 git fixture + 真实 in-memory WorkflowJournalRepository（经 mock 注入）。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { WorkflowJournalRepository } from '../../../src/main/services/core/repositories/WorkflowJournalRepository';

// 注入一个 in-memory repo（替代依赖全局 getDatabase 的访问器）
const repoState = vi.hoisted(() => ({ repo: null as WorkflowJournalRepository | null }));
vi.mock('../../../src/main/services/core/repositories/WorkflowJournalRepository', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/main/services/core/repositories/WorkflowJournalRepository')
  >('../../../src/main/services/core/repositories/WorkflowJournalRepository');
  return {
    ...actual,
    getWorkflowJournalRepository: () => repoState.repo,
  };
});

// patch 落到临时目录
const cfgState = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../src/main/config/configPaths', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/config/configPaths')>(
    '../../../src/main/config/configPaths'
  );
  return { ...actual, getUserConfigDir: () => cfgState.dir };
});

import { deleteWorkflowRunWithPatch } from '../../../src/main/services/checkpoint/workflowRunDeletionService';
import { getTrashedPatchDir } from '../../../src/main/services/checkpoint/taskPatchService';

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE workflow_runs (
      run_id TEXT PRIMARY KEY,
      script_hash TEXT NOT NULL,
      goal TEXT,
      session_id TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      error TEXT,
      working_directory TEXT
    )
  `);
  db.exec(`
    CREATE TABLE workflow_run_calls (
      run_id TEXT NOT NULL,
      call_index INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done',
      label TEXT,
      result_json TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL,
      PRIMARY KEY (run_id, call_index),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id) ON DELETE CASCADE
    )
  `);
}

function git(repo: string, args: string): void {
  execSync(`git ${args}`, {
    cwd: repo,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-del-repo-'));
  git(repo, 'init -q');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n');
  git(repo, 'add file.txt');
  git(repo, 'commit -q -m init');
  return repo;
}

function listPatches(): string[] {
  const dir = getTrashedPatchDir();
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

describe('deleteWorkflowRunWithPatch', () => {
  let db: BetterSqlite3.Database;
  const tmpToClean: string[] = [];

  beforeEach(() => {
    cfgState.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-del-cfg-'));
    tmpToClean.push(cfgState.dir);
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    repoState.repo = new WorkflowJournalRepository(db);
  });

  afterEach(() => {
    db.close();
    repoState.repo = null;
    while (tmpToClean.length) {
      const p = tmpToClean.pop()!;
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('run 有 workingDir 且目录有改动 → 删前导出 patch 并删除 DB 行', async () => {
    const repoDir = makeRepo();
    tmpToClean.push(repoDir);
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'base\nuncommitted\n');

    repoState.repo!.startRun({ runId: 'wf-1', scriptHash: 'h', startedAt: 1, workingDir: repoDir });

    const deleted = await deleteWorkflowRunWithPatch('wf-1');

    expect(deleted).toBe(true);
    expect(repoState.repo!.getRun('wf-1')).toBeNull();
    const patches = listPatches();
    expect(patches.length).toBe(1);
    const content = fs.readFileSync(path.join(getTrashedPatchDir(), patches[0]), 'utf-8');
    expect(content).toContain('uncommitted');
    expect(content).toContain('# reason: delete');
  });

  it('run 无 workingDir → 不导出 patch，仍删除 DB 行', async () => {
    repoState.repo!.startRun({ runId: 'wf-2', scriptHash: 'h', startedAt: 1 });

    const deleted = await deleteWorkflowRunWithPatch('wf-2');

    expect(deleted).toBe(true);
    expect(listPatches().length).toBe(0);
  });

  it('workingDir 目录已不存在 → 跳过 capture，仍删除 DB 行', async () => {
    repoState.repo!.startRun({
      runId: 'wf-3',
      scriptHash: 'h',
      startedAt: 1,
      workingDir: path.join(os.tmpdir(), 'gone-xyz-123'),
    });

    const deleted = await deleteWorkflowRunWithPatch('wf-3');

    expect(deleted).toBe(true);
    expect(listPatches().length).toBe(0);
  });

  it('run 不存在 → 返回 false', async () => {
    const deleted = await deleteWorkflowRunWithPatch('nope');
    expect(deleted).toBe(false);
  });
});
