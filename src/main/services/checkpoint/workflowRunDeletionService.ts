// ============================================================================
// workflowRunDeletionService —— 删除 workflow run 记录前的 patch 安全网
// ============================================================================
//
// WorkflowJournalRepository.deleteRun 是物理 DELETE，无备份。Repository 层不应直接
// 依赖 git 操作（保持持久化解耦），所以把「删前抢救 patch」放在这个 service 层：
// 读 run 记录里持久化的 workingDir，若目录仍存在则 captureWorkspacePatch，再删 DB 行。
//
// 优雅降级：DB 未就绪 → repo=null → 返回 false（无可删）。capture 是 best-effort，
// 失败不阻塞删除。
// ============================================================================

import * as fs from 'fs';
import { getWorkflowJournalRepository } from '../core/repositories/WorkflowJournalRepository';
import { captureWorkspacePatch } from './taskPatchService';
import { createLogger } from '../infra/logger';

const logger = createLogger('WorkflowRunDeletionService');

/**
 * 删除一条 workflow run 记录（及其级联的 calls），删除前若 run 持久化了工作目录且
 * 目录仍存在，先把目录的文件改动抢救成 patch（best-effort）。
 *
 * @returns 是否真的删除了一行（与 repo.deleteRun 语义一致）；DB 未就绪 → false。
 */
export async function deleteWorkflowRunWithPatch(runId: string): Promise<boolean> {
  const repo = getWorkflowJournalRepository();
  if (!repo) return false;

  // 删除前抓 patch：读 run 记录拿 workingDir，目录仍在才 capture。
  try {
    const run = repo.getRun(runId);
    if (run?.workingDir && fs.existsSync(run.workingDir)) {
      await captureWorkspacePatch(run.workingDir, runId, 'delete');
    }
  } catch (err) {
    logger.warn('captureWorkspacePatch before workflow run delete failed', { runId, err });
  }

  return repo.deleteRun(runId);
}
