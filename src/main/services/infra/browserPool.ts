// BrowserPool — 多 agent 浏览器隔离池。
//
// 现状：BrowserService 单 singleton + 单 BrowserContext，多 agent 共用 = 互相串数据。
// 目标：每个 agentId 一个 BrowserService 实例（独立 profileDir / 登录态 / cookies）。
//
// - default agent (无 agentId): 主 agent / IPC 接入层，行为与改造前一致
// - 命名 agent: 子 agent (autoDelegator/dynamicAgentFactory) 或多 session 场景
// - 被动 LRU：超 max 时关最久未用 agent；profileDir 残留留待启动期清理
// - 主 agent 不计入 LRU 容量

import { BrowserService } from './browserService';

const DEFAULT_AGENT_KEY = '__default__';
const DEFAULT_MAX_NAMED_AGENTS = 4;

interface PoolEntry {
  service: BrowserService;
  lastUsedAt: number;
}

export class BrowserPool {
  private entries = new Map<string, PoolEntry>();
  private maxNamedAgents: number;

  constructor(maxNamedAgents: number = DEFAULT_MAX_NAMED_AGENTS) {
    this.maxNamedAgents = Math.max(1, maxNamedAgents);
  }

  acquire(agentId?: string | null): BrowserService {
    const key = agentId || DEFAULT_AGENT_KEY;
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.service;
    }

    if (key !== DEFAULT_AGENT_KEY) {
      this.evictIfFull();
    }

    const service = new BrowserService(key === DEFAULT_AGENT_KEY ? undefined : key);
    this.entries.set(key, { service, lastUsedAt: Date.now() });
    return service;
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
    const namedKeys = [...this.entries.entries()].filter(([key]) => key !== DEFAULT_AGENT_KEY);
    if (namedKeys.length < this.maxNamedAgents) return;

    namedKeys.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const [evictKey, evictEntry] = namedKeys[0];
    this.entries.delete(evictKey);
    void evictEntry.service.close().catch(() => undefined);
  }
}

export const browserPool = new BrowserPool();

export function getBrowserService(agentId?: string | null): BrowserService {
  return browserPool.acquire(agentId);
}
