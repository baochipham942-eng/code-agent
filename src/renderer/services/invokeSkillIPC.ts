import type { IpcInvokeHandlers } from '@shared/ipc';
import type { SkillChannel } from '@shared/ipc/channels';
import { takeTransportFailure } from '../api/httpTransport';
import { createLogger } from '../utils/logger';
import ipcService from './ipcService';

const logger = createLogger('invokeSkillIPC');

/**
 * 只读路径用：失败即 undefined，调用方按空数据兜底。
 * 取走 transport 失败记录，避免旧失败泄漏给后续的 OrThrow 调用。
 */
export async function invokeSkillIPC<K extends SkillChannel>(
  channel: K,
  ...args: Parameters<IpcInvokeHandlers[K]>
): Promise<Awaited<ReturnType<IpcInvokeHandlers[K]>> | undefined> {
  try {
    const result = await ipcService.invoke(channel, ...args);
    takeTransportFailure(channel);
    return result;
  } catch (error) {
    takeTransportFailure(channel);
    logger.warn(`IPC invoke failed for ${channel}`, { error });
    return undefined;
  }
}

/**
 * 动作路径用（安装 / 更新 / 删除 / 添加 / 确认）：失败必须带出真因。
 *
 * httpTransport 的通用 invoke 对非 2xx、`{success:false}`、fetch 异常一律静默
 * `return undefined`，invokeSkillIPC 再吞一层 → UI 只剩「添加失败」这类哑文案：
 * 后台未就绪、token 失效、通道未注册长得一模一样（2026-07-27 产品负责人实测反馈）。
 * 这里把 transport 记下的真因取出来抛给调用方，由调用方显示。
 */
export async function invokeSkillIPCOrThrow<K extends SkillChannel>(
  channel: K,
  ...args: Parameters<IpcInvokeHandlers[K]>
): Promise<Awaited<ReturnType<IpcInvokeHandlers[K]>> | undefined> {
  let result: Awaited<ReturnType<IpcInvokeHandlers[K]>> | undefined;
  try {
    result = await ipcService.invoke(channel, ...args);
  } catch (error) {
    takeTransportFailure(channel);
    throw error instanceof Error ? error : new Error(String(error));
  }
  const failure = takeTransportFailure(channel);
  if (failure) {
    throw new Error(
      failure.message || `${channel}${failure.status === null ? '' : ` (${failure.status})`}`,
    );
  }
  return result;
}

/** 错误 → 用户可见文案：有真因就带上，没有才退回通用兜底 */
export function describeSkillIpcError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message ? `${fallback}：${message}` : fallback;
}
