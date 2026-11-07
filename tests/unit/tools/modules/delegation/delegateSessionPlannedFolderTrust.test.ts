import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.unmock('better-sqlite3');

// 真实 FolderTrustService 会走 createLogger；mock 掉以免测试写日志文件，并顺带断言豁免 info 留痕。
const loggerInfo = vi.hoisted(() => vi.fn());
vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../../../src/host/services/infra/logger')>();
  return {
    ...mod,
    createLogger: () => ({ info: loggerInfo, warn: () => {}, error: () => {}, debug: () => {} }),
  };
});

import { applySchema } from '../../../../../src/host/services/core/database/schema';
import { SessionDelegationRepository } from '../../../../../src/host/services/core/repositories/SessionDelegationRepository';
import { getDelegationCandidateSecret } from '../../../../../src/host/services/delegation/delegationToolRuntime';
import { projectSessionCandidates } from '../../../../../src/host/services/delegation/delegationCandidates';
import { executeDelegateSession } from '../../../../../src/host/tools/modules/delegation/delegateSession';
import { closeFolderTrustService, resetFolderTrustServiceForTest } from '../../../../../src/host/security/folderTrustService';
import { configureFolderTrustService } from '../../../../../src/host/security/folderTrustServiceConfig';
import { getDefaultWorkDirectory } from '../../../../../src/host/config/configPaths';

const schemaLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

const ctx = {
  sessionId: 'origin', turnId: 'turn-1', workingDir: '/workspace/origin',
  workspace: '/workspace/origin', modelConfig: { provider: 'local', model: 'test' },
  workspaceScope: { projectId: 'p', primaryRoot: '/workspace/origin', roots: [{ sourceId: 's', path: '/workspace/origin', access: 'read_write', role: 'primary' }], version: '1' },
  abortSignal: new AbortController().signal,
} as never;

const setRuntime = (value: unknown) => {
  (ctx as unknown as { delegationRuntime?: unknown }).delegationRuntime = value;
};

/**
 * delegate_session 公共入口 + 生产 runtime 默认的 evaluateFolderTrust wrapper：
 * 故意不覆盖 evaluateFolderTrust，让 getDelegationToolRuntime 的生产 wrapper
 * （evaluateFolderTrustForDelegation → 真实 FolderTrustService + 真实文件系统）顶上。
 * 其余事实源仍是测试内可控的替身（内存库 / 注入的会话行），与本目录既有测试同构。
 */
describe('delegate_session × 真实 FolderTrustService（规划目录未落盘豁免）', () => {
  let tmpRoot: string;
  let dataDir: string;
  let workRoot: string;
  let plannedDir: string;
  let db: InstanceType<typeof Database>;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'delegate-planned-'));
    dataDir = path.join(tmpRoot, 'data');
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
    closeFolderTrustService();
    configureFolderTrustService({});
    workRoot = getDefaultWorkDirectory();
    plannedDir = path.join(workRoot, 'Task_1107_target');
    db = new Database(':memory:');
    applySchema(db, schemaLogger);
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    loggerInfo.mockClear();
  });

  afterEach(async () => {
    resetFolderTrustServiceForTest();
    vi.unstubAllEnvs();
    delete process.env.CODE_AGENT_CROSS_SESSION_DELEGATION;
    setRuntime(undefined);
    db.close();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  /** 目标会话行落在 targetWorkspace 上，workspaceRoots 授权其父目录（G5 放行）。 */
  function setRuntimeFor(targetWorkspace: string, workspaceRoots: string[]) {
    const sessions = [{ id: 'target', title: 'Target', workingDirectory: targetWorkspace, updatedAt: 100, sessionType: 'chat' as const, engineKind: 'native' }];
    const projection = projectSessionCandidates(sessions, { originSessionId: 'origin', now: 100, secret: getDelegationCandidateSecret() });
    setRuntime({
      getDb: () => db,
      listSessions: () => sessions,
      getSessionRow: (id: string) => id === 'target'
        ? { id, title: 'Target', workingDirectory: targetWorkspace, sessionType: 'chat', engineKind: 'native', modelConfig: { provider: 'local', model: 'test' } }
        : null,
      getWorkspaceRoots: () => workspaceRoots,
      getRuns: () => [],
      getRun: () => undefined,
      getPermissionMode: () => 'default',
      notifyEnqueued: () => {},
      now: () => 100,
      // 不覆盖 evaluateFolderTrust —— 生产 wrapper（真实 evaluateFolderTrust）顶上
    });
    return projection;
  }

  async function callDelegate(projection: ReturnType<typeof projectSessionCandidates>) {
    return executeDelegateSession(
      { action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: projection.candidates[0].candidateRef, text: 'do it' },
      ctx,
      async () => ({ allow: true }),
    );
  }

  it('（a）规划目录未落盘：delegate_existing 照常准入并落委托行 + 排队行', async () => {
    // 前提自证：目标工作目录确实不存在，且路径是规划形状（否则豁免前提不成立）
    await expect(fsp.stat(plannedDir)).rejects.toMatchObject({ code: 'ENOENT' });
    const projection = setRuntimeFor(plannedDir, [workRoot]);

    const result = await callDelegate(projection);

    expect(result.ok).toBe(true);
    expect(new SessionDelegationRepository(db).listByTargetSession('target')).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS count FROM queued_inputs').get()).toMatchObject({ count: 1 });
    // 豁免必须留痕：info 日志写明原因
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('planned session work directory is not on disk yet'),
      expect.objectContaining({ workingDirectory: plannedDir, reason: 'planned-session-work-directory-absent' }),
    );
  });

  it('（a-负例）豁免不建目录：委托检查零落盘副作用', async () => {
    const projection = setRuntimeFor(plannedDir, [workRoot]);
    const result = await callDelegate(projection);
    expect(result.ok).toBe(true);
    await expect(fsp.stat(plannedDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('（c）非规划的缺失路径仍拒：ENOENT 不豁免 → untrusted_workspace，零落行', async () => {
    const missingDir = path.join(tmpRoot, 'elsewhere', 'not-planned');
    const projection = setRuntimeFor(missingDir, [path.join(tmpRoot, 'elsewhere')]);

    const result = await callDelegate(projection);

    expect(result).toMatchObject({ ok: false, code: 'DELEGATION_REJECTED' });
    expect((result as { error: string }).error).toContain('untrusted_workspace');
    expect(new SessionDelegationRepository(db).listByTargetSession('target')).toHaveLength(0);
    expect(db.prepare('SELECT count(*) AS count FROM queued_inputs').get()).toMatchObject({ count: 0 });
    expect(loggerInfo).not.toHaveBeenCalledWith(
      expect.stringContaining('planned session work directory is not on disk yet'),
      expect.anything(),
    );
  });

  it('（d）规划目录已落盘且带 hooks 危险配置仍拒：不豁免 → untrusted_workspace，零落行', async () => {
    await fsp.mkdir(path.join(plannedDir, '.code-agent', 'hooks'), { recursive: true });
    await fsp.writeFile(
      path.join(plannedDir, '.code-agent', 'hooks', 'hooks.json'),
      '{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"a.sh"}]}]}',
      'utf-8',
    );
    const projection = setRuntimeFor(plannedDir, [workRoot]);

    const result = await callDelegate(projection);

    expect(result).toMatchObject({ ok: false, code: 'DELEGATION_REJECTED' });
    expect((result as { error: string }).error).toContain('untrusted_workspace');
    expect(new SessionDelegationRepository(db).listByTargetSession('target')).toHaveLength(0);
    expect(db.prepare('SELECT count(*) AS count FROM queued_inputs').get()).toMatchObject({ count: 0 });
    expect(loggerInfo).not.toHaveBeenCalledWith(
      expect.stringContaining('planned session work directory is not on disk yet'),
      expect.anything(),
    );
  });
});
