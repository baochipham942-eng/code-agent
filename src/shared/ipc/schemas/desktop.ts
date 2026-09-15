// ============================================================================
// Desktop Domain Schemas - desktop 域 action 集合真源（RQ-183 续作·DESKTOP 刀）
// ============================================================================
//
// 最小表形态（同 session/memory 域）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 desktop 域、handler 表（src/host/ipc/desktop.ipc.ts）
// 三面由 tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const DesktopDomainRequestSchema = z.object({
  action: z.enum([
    'attachBrowserRelayTab',
    'clearManagedBrowserCookies',
    'closeManagedBrowserSession',
    'detachBrowserRelayTab',
    'ensureManagedBrowserSession',
    'getAudioCaptureStatus',
    'getAudioSegments',
    'getBrowserRelayState',
    'getComputerSurfaceState',
    'getCurrentContext',
    'getManagedBrowserRecoverySnapshot',
    'getManagedBrowserSession',
    'getStats',
    'getStatus',
    'importBrowserProfileCookies',
    'listBrowserProfiles',
    'listBrowserRelayTabs',
    'listComputerSurfaceElements',
    'listRecent',
    'observeComputerSurface',
    'openBrowserRelayExtensionDirectory',
    'openBrowserRelayTab',
    'openManagedBrowserUrl',
    'refreshManagedBrowserAccountState',
    'search',
    'startAudioCapture',
    'startBrowserRelay',
    'stopAudioCapture',
    'stopBrowserRelay',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type DesktopDomainRequest = z.infer<typeof DesktopDomainRequestSchema>;

export const DesktopSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.DESKTOP, payload: DesktopDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: DesktopDomainRequestSchema.shape.action.options,
} as const;
