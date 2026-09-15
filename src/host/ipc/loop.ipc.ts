// ============================================================================
// Loop IPC Handlers — 会话内循环（/loop）的 start / stop / list / get
// ============================================================================

import { ipcHost } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { LoopSchemas, type LoopDomainRequest } from '../../shared/ipc/schemas/loop';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { getLoopController } from '../loop';
import { createLogger } from '../services/infra/logger';
import type { LoopRunConfig } from '../../shared/contract/loop';

const logger = createLogger('LoopIPC');

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getString(source: unknown, field: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[field];
  return typeof value === 'string' ? value : undefined;
}

function getNumber(source: unknown, field: string): number | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getBoolean(source: unknown, field: string): boolean | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[field];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * loop 域单源路由表（RQ-183 续作·LOOP 刀）：原 domain switch 逐 case 平移为 handler（rawResponse：
 * handler 仍返回完整 IPCResponse）；每个 handler 按请求取 getLoopController()（原 switch 在 try 外取、抛错即 reject，现落 LOOP_ERROR；null 请求由抛错变 UNKNOWN_ACTION）；
 * 未知 action → UNKNOWN_ACTION `Unknown loop action: <action>`；抛错 → 错误自带 string code 透传、
 * 否则 LOOP_ERROR，非 Error → 'Unknown error'，同款日志。
 */
const loopHandlers: RawDomainRouteHandlers<LoopDomainRequest, void> = {
  start: async (_ctx, payload) => {
    const sessionId = getString(payload, 'sessionId');
    const prompt = getString(payload, 'prompt');
    if (!sessionId) throw new Error('缺少 sessionId');
    if (!prompt?.trim()) throw new Error('缺少 prompt');
    const durable = getBoolean(payload, 'durable');
    const config: LoopRunConfig = {
      sessionId,
      prompt: prompt.trim(),
      intervalMs: getNumber(payload, 'intervalMs'),
      maxTurns: getNumber(payload, 'maxTurns'),
      until: getString(payload, 'until'),
      ...(durable !== undefined ? { durable } : {}),
    };
    return { success: true, data: await getLoopController().start(config) } satisfies IPCResponse;
  },
  stop: async (_ctx, payload) => {
    const id = getString(payload, 'id');
    if (!id) throw new Error('缺少 loop id');
    return { success: true, data: getLoopController().stop(id) } satisfies IPCResponse;
  },
  list: async (_ctx, payload) => {
    const sessionId = getString(payload, 'sessionId');
    return { success: true, data: getLoopController().list(sessionId) } satisfies IPCResponse;
  },
  get: async (_ctx, payload) => {
    const id = getString(payload, 'id');
    if (!id) throw new Error('缺少 loop id');
    return { success: true, data: getLoopController().get(id) } satisfies IPCResponse;
  },
};

const loopRoutes = defineDomainRoutes<LoopDomainRequest, void>(LoopSchemas.REQUEST, loopHandlers, {
  rawResponse: true,
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `Unknown loop action: ${String(action)}`,
  mapError: (error) => {
    logger.error('Loop IPC error:', error);
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'LOOP_ERROR';
    return { code, message: error instanceof Error ? error.message : 'Unknown error' };
  },
});

export function registerLoopHandlers(): void {
  installDomainRoutes(ipcHost, loopRoutes, undefined);
}

registerLoopHandlers.routes = loopRoutes;
