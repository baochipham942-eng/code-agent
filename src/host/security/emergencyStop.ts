import { lstatSync } from 'node:fs';
import path from 'node:path';
import { getUserConfigDir } from '../config/configPaths';

/** Check each new call. Any sentinel (including a broken symlink) stops work. */
export function isEmergencyStopActive(): boolean {
  try {
    lstatSync(path.join(getUserConfigDir(), 'ESTOP'));
    return true;
  } catch (error) {
    return !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
  }
}
