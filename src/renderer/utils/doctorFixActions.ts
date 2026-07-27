// ============================================================================
// Doctor fix code → 前端动作 映射（单一真源，穷尽式）
// Record<DoctorFixCode, ...> 保证新增 code 时这里 typecheck 直接红；
// 对应按钮文案在 i18n settings.providerDoctor.fixLabels，同样穷尽。
// ============================================================================

import { DOCTOR_FIX_CODES, type DoctorFixCode } from '@shared/constants/doctor';
import { AGENT_NEO_HELP_URL } from '@shared/constants/network';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { openExternalLink } from './platform';
import type { SettingsTab } from './settingsTabs';

export type DoctorFixAction =
  | { kind: 'settingsTab'; tab: SettingsTab }
  | { kind: 'externalLink'; url: string }
  | { kind: 'openDataDirectory' };

/**
 * 8 个 fix code 的全部落点：
 * - 设置类 → openSettingsTab 深链（mcp 会按 ADR-049 重定向进能力中心）
 * - 帮助类 → 帮助文档链接
 * - 数据目录 → 打开应用数据目录
 */
export const DOCTOR_FIX_ACTIONS: Record<DoctorFixCode, DoctorFixAction> = {
  [DOCTOR_FIX_CODES.OPEN_RUNTIME_HELP]: { kind: 'externalLink', url: AGENT_NEO_HELP_URL },
  [DOCTOR_FIX_CODES.OPEN_DATA_DIRECTORY]: { kind: 'openDataDirectory' },
  [DOCTOR_FIX_CODES.OPEN_PROVIDER_SETTINGS]: { kind: 'settingsTab', tab: 'model' },
  [DOCTOR_FIX_CODES.OPEN_PROXY_HELP]: { kind: 'externalLink', url: AGENT_NEO_HELP_URL },
  [DOCTOR_FIX_CODES.OPEN_MCP_SETTINGS]: { kind: 'settingsTab', tab: 'mcp' },
  [DOCTOR_FIX_CODES.OPEN_BROWSER_RELAY_SETTINGS]: { kind: 'settingsTab', tab: 'privacy' },
  [DOCTOR_FIX_CODES.OPEN_HOOKS_SETTINGS]: { kind: 'settingsTab', tab: 'hooks' },
  [DOCTOR_FIX_CODES.OPEN_UPDATE_SETTINGS]: { kind: 'settingsTab', tab: 'update' },
};

/**
 * 现有 IPC 没有「打开数据目录」专用动作：借 soul:getProfile 拿到
 * <用户配置目录>/SOUL.md 的路径，再用 workspace:openPath 打开其父目录。
 */
async function openAppDataDirectory(): Promise<void> {
  const { ipcService } = await import('../services/ipcService');
  const { filePath } = await ipcService.invokeDomain<{ filePath: string }>(
    IPC_DOMAINS.SOUL,
    'getProfile',
    { scope: 'user' },
  );
  const dir = filePath.replace(/[\\/][^\\/]+$/, '');
  if (!dir || dir === filePath) {
    throw new Error(`Cannot resolve data directory from: ${filePath}`);
  }
  await ipcService.invokeDomain(IPC_DOMAINS.WORKSPACE, 'openPath', { filePath: dir });
}

export interface DoctorFixResult {
  /** 动作把用户带去了别的界面（设置深链会把设置页切到对应 tab） */
  navigatedAway: boolean;
}

/** 执行 fix 动作。设置深链直接切设置页 tab（诊断页同为设置页内页面，无需关弹层）。 */
export async function runDoctorFix(code: DoctorFixCode): Promise<DoctorFixResult> {
  const action = DOCTOR_FIX_ACTIONS[code];
  switch (action.kind) {
    case 'settingsTab': {
      useAppStore.getState().openSettingsTab(action.tab);
      return { navigatedAway: true };
    }
    case 'externalLink': {
      // web 模式下 openExternalLink 返回 false（让浏览器原生接管），回退 window.open
      if (!openExternalLink(action.url)) {
        window.open(action.url, '_blank');
      }
      return { navigatedAway: false };
    }
    case 'openDataDirectory': {
      await openAppDataDirectory();
      return { navigatedAway: false };
    }
  }
}
