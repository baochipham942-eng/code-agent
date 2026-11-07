// ============================================================================
// delegationFolderTrust — 委托面（G12 事实收集）用的 folder trust 评估
// ============================================================================
// 品牌新会话（尤其纯文本会话）的按会话产出目录是「规划而不落盘」的
// （N-DELIVERABLE-WORKDIR-LAZY）：只在首个写类工具派发前 materialize，纯问答会话
// 永不落盘。目录不存在时 FolderTrustService.evaluate 的 realpathNative 直接 ENOENT，
// 委托门 G12 把评估失败当 reject（未知即拒）——刚建的会话在首轮跑起来之前永远不可
// 委托（真机实录：delegate_session 返回 untrusted_workspace，且没有落任何委托行）。
//
// 豁免口径：评估抛错 + 盘上确无该目录 + 路径是本模块规划的形状
// （isPlannedSessionWorkDirectory）→ 视为 trusted。空的规划目录不可能藏危险配置
// （hooks/policy 都长在目录里，目录不存在就没有）。其余一切抛错照旧向上抛：
// 非规划的缺失路径、权限错误、已存在但评估失败的规划目录，都维持「未知即拒」。
// 只读判定，不建目录——委托检查不许有落盘副作用。
// ============================================================================

import * as fsp from 'node:fs/promises';
import { isPlannedSessionWorkDirectory } from '../../config/sessionWorkDirectory';
import { evaluateFolderTrust } from '../../security/folderTrustService';
import { createLogger } from '../infra/logger';

const logger = createLogger('DelegationFolderTrust');

/**
 * 生产 wrapper 的统一口径（delegationToolRuntime / delegationDrainHooks 共用）：
 * 调真实的 evaluateFolderTrust；豁免命中的规划目录按 trusted 放行，其余抛错原样上抛
 * （调用方兜成 {error:true} → G12 拒）。
 */
export async function evaluateFolderTrustForDelegation(
  workingDirectory: string,
): Promise<{ state: string; blockedItems: number }> {
  try {
    const evaluation = await evaluateFolderTrust(workingDirectory);
    return { state: evaluation.state, blockedItems: evaluation.blockedItems.length };
  } catch (error) {
    if (await isAbsentPlannedSessionWorkDirectory(workingDirectory)) {
      logger.info('Delegation folder trust: planned session work directory is not on disk yet; treating as trusted', {
        workingDirectory,
        reason: 'planned-session-work-directory-absent',
        error: error instanceof Error ? error.message : String(error),
      });
      return { state: 'trusted', blockedItems: 0 };
    }
    throw error;
  }
}

/** 盘上确无该目录（stat ENOENT），且路径是规划形状。已存在但评估失败的规划目录不豁免。 */
async function isAbsentPlannedSessionWorkDirectory(workingDirectory: string): Promise<boolean> {
  if (!isPlannedSessionWorkDirectory(workingDirectory)) return false;
  try {
    await fsp.stat(workingDirectory);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}
