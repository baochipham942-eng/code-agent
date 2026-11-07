import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

// 真实 FolderTrustService 会走 createLogger；mock 掉以免测试写日志文件，并顺带断言豁免 info 留痕。
const loggerInfo = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../../src/host/services/infra/logger')>();
  return {
    ...mod,
    createLogger: () => ({ info: loggerInfo, warn: () => {}, error: () => {}, debug: () => {} }),
  };
});

import { applySchema } from '../../../../src/host/services/core/database/schema';
import { QueuedInputRepository } from '../../../../src/host/services/core/repositories/QueuedInputRepository';
import {
  commitDelegation,
  collectDeliveryFacts,
  evaluateDelegationDelivery,
  type DelegationDeliveryFactDependencies,
} from '../../../../src/host/services/delegation/delegationDelivery';
import { deriveActionFingerprint, deriveSubmissionKey } from '../../../../src/host/services/delegation/delegationKeys';
import { evaluateFolderTrustForDelegation } from '../../../../src/host/services/delegation/delegationFolderTrust';
import { closeFolderTrustService, resetFolderTrustServiceForTest } from '../../../../src/host/security/folderTrustService';
import { configureFolderTrustService } from '../../../../src/host/security/folderTrustServiceConfig';
import { getDefaultWorkDirectory } from '../../../../src/host/config/configPaths';

/**
 * 投递复核 × 真实 FolderTrustService：deps.evaluateFolderTrust 按生产装配
 * （delegationDrainHooks.createHostDelegationRuntime）接 evaluateFolderTrustForDelegation，
 * 内部调真实 evaluateFolderTrust + 真实文件系统，不做任何 stub。
 */
describe('delegationDelivery × 真实 FolderTrustService（规划目录未落盘豁免）', () => {
  const originSessionId = 'origin-1';
  const originTurnId = 'turn-1';
  const targetSessionId = 'target-1';
  const content = '把这份对比表补完';

  let tmpRoot: string;
  let dataDir: string;
  let workRoot: string;
  let plannedDir: string;
  let db: BetterSqlite3.Database;
  let queuedInputs: QueuedInputRepository;

  const submissionKey = deriveSubmissionKey({
    originSessionId,
    originTurnId,
    action: 'delegate_existing',
    targetIdentity: `session:${targetSessionId}`,
  });
  const actionFingerprint = deriveActionFingerprint({
    action: 'delegate_existing',
    targetIdentity: `session:${targetSessionId}`,
    content,
    attachmentRefs: [],
  });
  const queuedInputId = `delegation:${submissionKey}`;

  function commitDefaults(now = 1_000): void {
    commitDelegation(db, {
      delegationId: 'd-1',
      originSessionId,
      originTurnId,
      disposition: 'delegate_existing',
      targetSessionId,
      submissionKey,
      actionFingerprint,
      envelope: { content, sessionId: targetSessionId },
      now,
    });
  }

  function makeRealDeps(workingDirectory: string): DelegationDeliveryFactDependencies {
    return {
      getDb: () => db,
      getSessionRow: (sessionId) => (sessionId === targetSessionId
        ? {
          sessionType: 'chat',
          engineKind: 'native',
          workingDirectory,
          isArchived: false,
          isDeleted: false,
        }
        : null),
      getPermissionMode: () => 'default',
      // 生产装配同一根：evaluateFolderTrustForDelegation（内部调真实 evaluateFolderTrust）
      evaluateFolderTrust: (dir) => evaluateFolderTrustForDelegation(dir),
      getActiveRunId: () => null,
    };
  }

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'deleg-delivery-'));
    dataDir = path.join(tmpRoot, 'data');
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
    closeFolderTrustService();
    configureFolderTrustService({});
    workRoot = getDefaultWorkDirectory();
    plannedDir = path.join(workRoot, 'Task_1107_target');
    db = new Database(':memory:');
    applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
    queuedInputs = new QueuedInputRepository(db);
    loggerInfo.mockClear();
  });

  afterEach(async () => {
    resetFolderTrustServiceForTest();
    vi.unstubAllEnvs();
    db.close();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('（b）投递复核：规划目录未落盘 → 豁免为 trusted，不 pause', async () => {
    commitDefaults();
    const record = queuedInputs.getById(queuedInputId);
    expect(record).not.toBeNull();

    const facts = await collectDeliveryFacts(
      makeRealDeps(plannedDir),
      { sessionId: targetSessionId, queuedInputId, originSessionId },
    );
    expect(facts.snapshot.target.folderTrust).toEqual({ state: 'trusted', blockedItems: 0 });

    const decision = await evaluateDelegationDelivery(makeRealDeps(plannedDir), record!);
    expect(decision).toMatchObject({ kind: 'deliver', delegationId: 'd-1' });
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('planned session work directory is not on disk yet'),
      expect.objectContaining({ workingDirectory: plannedDir, reason: 'planned-session-work-directory-absent' }),
    );
  });

  it('（b-负例）投递复核：非规划的缺失路径仍 pause untrusted_workspace（G12 未放松）', async () => {
    commitDefaults();
    const record = queuedInputs.getById(queuedInputId)!;
    const missingDir = path.join(tmpRoot, 'elsewhere', 'not-planned');

    const decision = await evaluateDelegationDelivery(makeRealDeps(missingDir), record);
    expect(decision).toMatchObject({ kind: 'pause', code: 'untrusted_workspace' });
    expect(loggerInfo).not.toHaveBeenCalledWith(
      expect.stringContaining('planned session work directory is not on disk yet'),
      expect.anything(),
    );
  });

  it('（b-负例）投递复核：规划目录已落盘且带 hooks 危险配置仍 pause untrusted_workspace', async () => {
    await fsp.mkdir(path.join(plannedDir, '.code-agent', 'hooks'), { recursive: true });
    await fsp.writeFile(
      path.join(plannedDir, '.code-agent', 'hooks', 'hooks.json'),
      '{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"a.sh"}]}]}',
      'utf-8',
    );
    commitDefaults();
    const record = queuedInputs.getById(queuedInputId)!;

    const decision = await evaluateDelegationDelivery(makeRealDeps(plannedDir), record);
    expect(decision).toMatchObject({ kind: 'pause', code: 'untrusted_workspace' });
    expect(loggerInfo).not.toHaveBeenCalledWith(
      expect.stringContaining('planned session work directory is not on disk yet'),
      expect.anything(),
    );
  });
});
