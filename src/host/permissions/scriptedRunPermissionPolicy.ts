import path from 'node:path';
import type { PermissionAskResult } from '../../shared/contract/permission';
import { devSlotFromDataDirName } from '../../shared/devSlot';
import { getUserConfigDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';
import type { PermissionRequestData } from '../tools/types';

const logger = createLogger('ScriptedRunPermissionPolicy');

/**
 * Eval-only injection point. This ticket deliberately fails closed: matching
 * and approvals are added by N-APPROVALINJECT-EVAL, never inferred from env.
 */
export function getScriptedRunPermissionHandler():
  | ((request: PermissionRequestData) => Promise<PermissionAskResult>)
  | undefined {
  const policyPath = process.env.NEO_SCRIPTED_APPROVAL_POLICY?.trim();
  if (!policyPath) return undefined;

  const dataDir = getUserConfigDir();
  if (devSlotFromDataDirName(path.basename(dataDir)) === null) {
    logger.warn('Ignoring NEO_SCRIPTED_APPROVAL_POLICY outside a dev data slot', {
      dataDir,
      policyPath,
    });
    return undefined;
  }

  logger.warn('scripted approval policy ACTIVE (eval mode)', { dataDir, policyPath });
  return async () => ({ approved: false, denialSource: 'scripted' });
}
