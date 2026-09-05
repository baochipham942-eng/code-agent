// ============================================================================
// 上线后评分的开关门（ADR-063 §3 · N-EVAL-POSTLAUNCH-K2）
// ----------------------------------------------------------------------------
// 单独一个模块，因为要门的有两条路：Electron 主进程（IPC「评近 N 天」）和 CLI
// （scripts/postlaunch-score.ts）。两边必须读同一份配置、用同一套默认值——
// 上一版 CLI 自己拼 settings.json、宿主读 config.json，结果用户在界面开了 CLI 仍拒
// （ai-review PR #1650 Important②）。
// ============================================================================
import path from 'node:path';
import {
  resolvePostLaunchScoringEnabled,
  type PostLaunchScoringSwitch,
} from '../../../shared/contract/postLaunchScore';
import { devSlotFromDataDirName } from '../../../shared/devSlot';
import { getUserDataPath } from '../../platform';
import { getConfigService } from '../../services/core/configService';

/**
 * 内部 dogfood 槽判据：数据目录名带 Rust `dev_slot()` 注入的槽身份。
 * 复用产品自己已有的那把尺（`devSlot.ts:99`），也是 `devModeAutoApprove`
 * 「只在内部槽放行」用的同一个判据（`configService.ts:66`）——同一类决定不该有第二套口径。
 * 它只看数据目录名，所以 CLI 与 Electron 主进程算出来一样。
 */
function isInternalSlot(): boolean {
  try {
    return devSlotFromDataDirName(path.basename(getUserDataPath())) !== null;
  } catch {
    return false;
  }
}

/** 开关三态：显式 on/off 说了算；'auto'（或老配置里没这个键）按槽算。 */
export function isPostLaunchScoringEnabled(): boolean {
  let setting: PostLaunchScoringSwitch | undefined;
  try {
    setting = getConfigService().getSettings().privacy?.postLaunchScoring;
  } catch {
    setting = undefined;
  }
  return resolvePostLaunchScoringEnabled(setting, isInternalSlot());
}
