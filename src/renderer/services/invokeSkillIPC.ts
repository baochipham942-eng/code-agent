import type { IpcInvokeHandlers } from '@shared/ipc';
import type { SkillChannel } from '@shared/ipc/channels';
import { takeTransportFailure } from '../api/transportFailures';
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

/**
 * 信任门错误的稳定文案标记：host 信任门（skill.ipc.ts ensureSkillPreferenceDirTrusted）
 * 抛 `该目录未被信任，无法为其配置技能：…`。transport 失败记录只透 message 字符串
 * （TransportFailure 无 code 字段，加字段要动 ~200 个 invoke 调用点共享的通用层），
 * message 前缀匹配是本仓既有约定（参照 FOLDER_TRUST_CONFIRM_REQUIRED_PREFIX）。
 */
export const SKILL_FOLDER_TRUST_ERROR_MARKER = '该目录未被信任';

/**
 * 机器区分「目录未信任/信任失效」与其他失败：只有信任类错误才配「确认信任」原地修复入口，
 * 其他错误（后台未就绪、token 失效、磁盘错误…）不出按钮。
 */
export function isSkillFolderTrustError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(SKILL_FOLDER_TRUST_ERROR_MARKER);
}
