// ============================================================================
// Typed IPC Invoke (renderer)
// ============================================================================
//
// 配套 main 侧 `defineHandler` 的 renderer 入口。
// 用 ChannelSchema 调 IPC，dev 模式下校验返回值，prod 跳过校验避免开销。
//
// 用法:
// ```ts
// import { EvaluationSchemas } from '@shared/ipc/schemas';
// import { typedInvoke } from '../services/typedInvoke';
//
// const result = await typedInvoke(EvaluationSchemas.SAVE_ANNOTATIONS, annotation);
// //    ^? { success: boolean; error?: string }
// ```
// ============================================================================

import type { ChannelSchema, PayloadOf, ResponseOf } from '@shared/ipc/schemas';

function commandApi() {
  return window.codeAgentAPI || window.electronAPI;
}

function domainApi() {
  return window.codeAgentDomainAPI || window.domainAPI;
}

// Bridge 的 invoke 只接受 keyof IpcInvokeHandlers；ChannelSchema 用普通 string，
// 需要在边界绕过严格的 keyof 检查。
type LooseInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/**
 * 是否启用 response 运行时校验。
 * Vite (`import.meta.env.DEV`) 在 dev build 是 true，prod build 是 false。
 * 单测/Node 环境兜底走 NODE_ENV。
 */
function shouldValidateResponse(): boolean {
  // Vite dev/prod flag — renderer 编译走 Vite
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (env && typeof env.DEV === 'boolean') return env.DEV;
  // Node 兜底
  return typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
}

/**
 * 类型化 IPC invoke。
 * 失败时（bridge 未挂载 / response 校验未过）抛错，由调用方处理。
 */
export async function typedInvoke<S extends ChannelSchema>(
  schema: S,
  payload: PayloadOf<S>,
): Promise<ResponseOf<S>> {
  const api = commandApi();
  if (!api) {
    throw new Error(`[typedInvoke] no IPC bridge available for ${schema.channel}`);
  }

  const invoke = api.invoke as unknown as LooseInvoke;
  const raw: unknown = await invoke(schema.channel, payload);

  if (schema.response && shouldValidateResponse()) {
    const parsed = schema.response.safeParse(raw);
    if (!parsed.success) {
      // dev 模式直接抛，让 bug 立刻暴露；prod 不进这条路径
      throw new Error(
        `[typedInvoke] response validation failed for ${schema.channel}: ${parsed.error.message}`,
      );
    }
    return parsed.data as ResponseOf<S>;
  }

  return raw as ResponseOf<S>;
}

/**
 * 类型化 domain invoke。
 *
 * Domain bridge 的外部 API 仍是 `(domain, action, payload)`，但调用点用
 * ChannelSchema 描述完整 request envelope，避免每个 store 自己写宽泛泛型。
 */
export async function typedInvokeDomain<S extends ChannelSchema>(
  schema: S,
  request: PayloadOf<S> & { action: string; payload?: unknown },
): Promise<ResponseOf<S>> {
  const api = domainApi();
  if (!api) {
    throw new Error(`[typedInvokeDomain] no domain IPC bridge available for ${schema.channel}`);
  }

  const raw: unknown = await api.invoke(schema.channel, request.action, request.payload);

  if (schema.response && shouldValidateResponse()) {
    const parsed = schema.response.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `[typedInvokeDomain] response validation failed for ${schema.channel}:${request.action}: ${parsed.error.message}`,
      );
    }
    return parsed.data as ResponseOf<S>;
  }

  return raw as ResponseOf<S>;
}
