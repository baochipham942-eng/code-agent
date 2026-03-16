// ============================================================================
// SSE broadcast infrastructure
// ============================================================================

import http from 'http';
import type { Response } from 'express';

/** Registry of active SSE clients */
export const sseClients = new Set<Response>();

/**
 * 向所有 SSE 客户端推送事件
 */
export function broadcastSSE(channel: string, args: unknown): void {
  const data = JSON.stringify({ channel, args });
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

/**
 * 向单个 SSE 响应写入一条事件
 */
export function sendSSE(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
