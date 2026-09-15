import type { IpcMain } from '../platform';
import { ActivitySchemas, type ActivityDomainRequest } from '../../shared/ipc/schemas/activity';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { getCurrentActivityContext } from '../services/activity/activityContextProvider';
import { listActivityProviders } from '../services/activity/activityProviderRegistry';

/**
 * activity 域单源路由表（RQ-183 续作·ACTIVITY 刀）：原 domain switch 2 个直返 `{ success: true, data: await X() }` 的 case
 * 平移为默认模式 handler（返回 await X()，装配器包 { success: true, data }）。未知 action 与抛错走装配器缺省（INVALID_ACTION
 * `Unknown action: <action>` / INTERNAL_ERROR + Error.message / String(error)，与原文逐字一致）。
 * 请求体为 null / 非对象时原实现在 try 内读 request.action 抛错落 INTERNAL_ERROR，现返回 INVALID_ACTION。
 */
const activityRoutes = defineDomainRoutes<ActivityDomainRequest, void>(ActivitySchemas.REQUEST, {
  listProviders: async () => await listActivityProviders(),
  getCurrentContext: async () => await getCurrentActivityContext(),
});

export function registerActivityHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, activityRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerLoopHandlers.routes 先例）
registerActivityHandlers.routes = activityRoutes;
