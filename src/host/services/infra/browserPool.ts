// BrowserPool — 多 agent 浏览器隔离池。
//
// 现状：BrowserService 单 singleton + 单 BrowserContext，多 agent 共用 = 互相串数据。
// 目标：每个 agentId 一个 BrowserService 实例（独立 profileDir / 登录态 / cookies）。
//
// - default agent (无 agentId): 主 agent / IPC 接入层，行为与改造前一致
// - 命名 agent: 子 agent (autoDelegator/dynamicAgentFactory) 或多 session 场景
// - 占用中的命名条目不回收。池满且没有空闲够久的条目时，新请求失败，不关任何浏览器
// - 主 agent（__default__）不计入容量

import { BROWSER_TIMEOUTS } from '../../../shared/constants/timeouts';
import { BrowserService, browserService as defaultBrowserService } from './browserService';

/** Pool key for the default / personal managed browser singleton. */
const DEFAULT_AGENT_KEY = '__default__';
const DEFAULT_MAX_NAMED_AGENTS = 4;

interface PoolEntry {
  service: BrowserService;
  lastUsedAt: number;
  inUse: boolean;
  /** kept 结果页窗口（N-BROWSER-KEEP-RESULT-PAGE）：不占 in-use 名额，但池满时可先于闲置阈值被回收。 */
  kept: boolean;
}

/**
 * Pool is full of browsers that are still in use or not yet idle long enough.
 * The message is for the model to relay: wait, do not retry in a loop.
 */
export class BrowserPoolBusyError extends Error {
  constructor(readonly othersUsing: number) {
    super(
      `${othersUsing} other conversations are using the browser. Wait for one to finish or end one conversation. Do not retry this tool in a loop.`,
    );
    this.name = 'BrowserPoolBusyError';
  }
}

export class BrowserPool {
  private entries = new Map<string, PoolEntry>();
  private maxNamedAgents: number;
  private readonly createNamedService: (key: string) => BrowserService;

  constructor(
    maxNamedAgents: number = DEFAULT_MAX_NAMED_AGENTS,
    defaultService: BrowserService = defaultBrowserService,
    createNamedService: (key: string) => BrowserService = (key) => new BrowserService(key),
  ) {
    this.maxNamedAgents = Math.max(1, maxNamedAgents);
    this.createNamedService = createNamedService;
    this.entries.set(DEFAULT_AGENT_KEY, { service: defaultService, lastUsedAt: Date.now(), inUse: false, kept: false });
  }

  acquire(agentId?: string | null): BrowserService {
    const key = agentId || DEFAULT_AGENT_KEY;
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.service;
    }

    this.evictIfFull();

    const service = this.createNamedService(key);
    this.entries.set(key, { service, lastUsedAt: Date.now(), inUse: false, kept: false });
    return service;
  }

  /**
   * Mark a named pool entry in use. In-use entries are never evicted.
   * The personal `__default__` key is not a named slot and is ignored.
   */
  setInUse(key: string, inUse: boolean): void {
    if (!key || key === DEFAULT_AGENT_KEY) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.inUse = inUse;
  }

  /**
   * Mark/unmark a named entry as a kept result page window
   * (N-BROWSER-KEEP-RESULT-PAGE). Kept entries are not in use but stay in the
   * pool; `evictIfFull` may reclaim them before the idle threshold (oldest
   * first) so a kept window never blocks a new browser task.
   */
  setKept(key: string, kept: boolean): void {
    if (!key || key === DEFAULT_AGENT_KEY) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.kept = kept;
  }

  async releaseAgent(agentId: string): Promise<void> {
    if (!agentId || agentId === DEFAULT_AGENT_KEY) return;
    const entry = this.entries.get(agentId);
    if (!entry) return;
    this.entries.delete(agentId);
    await entry.service.close().catch(() => undefined);
  }

  listAgents(): string[] {
    return [...this.entries.keys()].filter((key) => key !== DEFAULT_AGENT_KEY);
  }

  hasAgent(agentId: string): boolean {
    return this.entries.has(agentId);
  }

  private evictIfFull(): void {
    const named = [...this.entries.entries()].filter(([key]) => key !== DEFAULT_AGENT_KEY);
    if (named.length < this.maxNamedAgents) return;

    const now = Date.now();
    // 回收候选 = 闲置够久的普通条目 ∪ kept 结果页条目（未到闲置阈值也可回收，
    // oldest first；kept 窗永不阻塞新任务）。占用中的条目一律不动。
    const reclaimable = named
      .filter(([, entry]) => (
        !entry.inUse && (
          entry.kept || now - entry.lastUsedAt >= BROWSER_TIMEOUTS.POOL_IDLE_RECLAIM
        )
      ))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

    if (reclaimable.length === 0) {
      throw new BrowserPoolBusyError(named.length);
    }

    const [evictKey, evictEntry] = reclaimable[0];
    this.entries.delete(evictKey);
    void evictEntry.service.close().catch(() => undefined);
  }
}

export const browserPool = new BrowserPool();

export function getBrowserService(agentId?: string | null): BrowserService {
  return browserPool.acquire(agentId);
}

const boundBrowserPoolReleaseGuards = new WeakSet<object>();

/**
 * Once per guard: when a spawned agent finishes, release the legacy pool entry
 * keyed by that agent's id. Never touches the personal `__default__` browser.
 */
export function bindBrowserPoolReleaseHook(guard: {
  onComplete(callback: (agent: { id: string }) => void): void;
}): void {
  if (boundBrowserPoolReleaseGuards.has(guard)) return;
  boundBrowserPoolReleaseGuards.add(guard);
  guard.onComplete((agent) => {
    if (!agent.id || agent.id === DEFAULT_AGENT_KEY) return;
    void browserPool.releaseAgent(agent.id);
  });
}
