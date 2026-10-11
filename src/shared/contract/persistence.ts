// ============================================================================
// Persistence Health Contract
// ============================================================================

import type { RendererServeDecision } from './desktopShell';
import type { BuildInfo } from './buildInfo';

export type PersistenceStatus = 'available' | 'unavailable' | 'degraded' | 'recovered';
export type PersistenceMode = 'database' | 'memory';

export interface PersistenceHealth {
  status: PersistenceStatus;
  mode: PersistenceMode;
  durable: boolean;
  message: string;
  reason?: string;
  checkedAt: number;
}

export interface WebHealthPublic {
  status: 'ok';
  mode: string;
  timestamp: number;
  tauriBootToken: string | null;
  /** A build version is safe to expose publicly; the rest of build metadata is detail-only. */
  build: { version?: string } | null;
  /**
   * agent/run 现在会不会因为 durable rollout 未就绪而回 503。
   *
   * `status: 'ok'` 只代表**进程起来了**：durable 就绪排在 capabilityBootstrap
   * （插件 → 技能 → MCP）之后异步完成，实测冷启动后有 9~60 秒的窗口，
   * 期间 /api/run 一律 503 DURABLE_RUN_ROLLOUT_UNAVAILABLE。
   * 判「服务能不能用」要看这个字段，不要看 status / startup token。
  */
  durableRunReady: boolean;
  rendererServe: RendererServeDecision | null;
}

export interface WebHealthDetail extends WebHealthPublic {
  handlers: number;
  serverRoot: string;
  pid: number;
  build: BuildInfo | null;
  persistence: PersistenceHealth;
}
