// ============================================================================
// Loop IPC Handlers — 会话内循环（/loop）的 start / stop / list / get
// ============================================================================

import { ipcHost } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
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

export function registerLoopHandlers(): void {
  ipcHost.handle(IPC_DOMAINS.LOOP, async (_event, request: IPCRequest) => {
    const { action, payload } = request;
    const controller = getLoopController();

    try {
      switch (action) {
        case 'start': {
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
          return { success: true, data: await controller.start(config) } satisfies IPCResponse;
        }

        case 'stop': {
          const id = getString(payload, 'id');
          if (!id) throw new Error('缺少 loop id');
          return { success: true, data: controller.stop(id) } satisfies IPCResponse;
        }

        case 'list': {
          const sessionId = getString(payload, 'sessionId');
          return { success: true, data: controller.list(sessionId) } satisfies IPCResponse;
        }

        case 'get': {
          const id = getString(payload, 'id');
          if (!id) throw new Error('缺少 loop id');
          return { success: true, data: controller.get(id) } satisfies IPCResponse;
        }

        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown loop action: ${action}` },
          } satisfies IPCResponse;
      }
    } catch (error) {
      logger.error('Loop IPC error:', error);
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'LOOP_ERROR';
      return {
        success: false,
        error: { code, message: error instanceof Error ? error.message : 'Unknown error' },
      } satisfies IPCResponse;
    }
  });
}
