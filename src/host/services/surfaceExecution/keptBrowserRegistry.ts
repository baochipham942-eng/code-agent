// keptBrowserRegistry — N-BROWSER-KEEP-RESULT-PAGE（借鉴 ego S-09 keep result page）。
//
// 模型显式调用 browser_action keep_result_page 后，本会话的「结果页窗口」在 run
// 结束时不随 binding 清理关掉：注册表记录 {conversationId, serviceKey, url, title,
// keptAt}，窗口保持存活（不 in use），用户从聊天里一键认领（adopt）继续操作同一页。
// 闲置 30 分钟（lease 到期）/ 池满驱逐 / 用户关闭后翻成 `closed`，URL 留存供一键重开
// （重开只恢复 URL，不恢复表单内容）。
//
// 一个会话最多一扇 kept 窗：新的 keep 关掉旧的。
// 窗口自身的 close/crashed 会话事件把条目翻成 closed（池条目一并释放，不占容量）。

import { createLogger } from '../infra/logger';
import { browserPool } from '../infra/browserPool';

const logger = createLogger('KeptBrowserRegistry');

/** close/crashed 视为 kept 窗口终结（URL 留存）。 */
const TERMINAL_SESSION_REASONS = new Set(['close', 'crashed']);

type KeptBrowserEntryState = 'kept' | 'closed';

export interface KeptBrowserEntry {
  conversationId: string;
  serviceKey: string;
  url: string;
  title: string;
  keptAt: number;
  state: KeptBrowserEntryState;
}

/** IPC/UI 用的三态快照：none=无 kept 条目；kept=窗还活着；closed=已关、URL 留存。 */
export type KeptResultPageSnapshot =
  | { state: 'none'; url: null; title: null }
  | { state: KeptBrowserEntryState; url: string; title: string };

/** 注册表对池的最小依赖面（测试可注入假池）。 */
export interface KeptBrowserPoolFacade {
  setKept(serviceKey: string, kept: boolean): void;
  releaseAgent(serviceKey: string): Promise<void>;
}

export interface RegisterKeptBrowserInput {
  conversationId: string;
  serviceKey: string;
  url: string;
  title: string;
  /** kept 窗的会话变化事件源（close/crashed → closed）。 */
  browserService: { onSessionChanged?: (listener: (reason: string) => void) => (() => void) | undefined };
  keptAt?: number;
}

export class KeptBrowserRegistry {
  private readonly entries = new Map<string, KeptBrowserEntry>();
  private readonly unsubs = new Map<string, () => void>();

  constructor(
    private readonly pool: KeptBrowserPoolFacade = browserPool,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 登记（或刷新）本会话的 kept 结果页。同会话旧 kept 窗（不同 serviceKey）被关掉；
   * 同一 serviceKey 重复 keep 只刷新 url/title/keptAt。
   */
  register(input: RegisterKeptBrowserInput): KeptBrowserEntry {
    const previous = this.entries.get(input.conversationId);
    if (previous && previous.serviceKey !== input.serviceKey && previous.state === 'kept') {
      this.retireKeptService(previous);
    }
    this.unsubs.get(input.conversationId)?.();
    this.unsubs.delete(input.conversationId);

    const entry: KeptBrowserEntry = {
      conversationId: input.conversationId,
      serviceKey: input.serviceKey,
      url: input.url,
      title: input.title,
      keptAt: input.keptAt ?? this.now(),
      state: 'kept',
    };
    this.entries.set(input.conversationId, entry);
    this.pool.setKept(entry.serviceKey, true);

    const capturedServiceKey = entry.serviceKey;
    const unsubscribe = input.browserService.onSessionChanged?.((reason) => {
      if (!TERMINAL_SESSION_REASONS.has(reason)) return;
      this.markClosedIfService(input.conversationId, capturedServiceKey);
    });
    if (unsubscribe) this.unsubs.set(input.conversationId, unsubscribe);
    return { ...entry };
  }

  /** 会话当前 kept 条目（含 closed；无条目返回 null）。 */
  get(conversationId: string): KeptBrowserEntry | null {
    const entry = this.entries.get(conversationId);
    return entry ? { ...entry } : null;
  }

  /** 存活中的 kept 条目（adopt / ensureBinding 认领判据）。 */
  getAlive(conversationId: string): KeptBrowserEntry | null {
    const entry = this.get(conversationId);
    return entry?.state === 'kept' ? entry : null;
  }

  /** 该池键是否仍是某会话存活中的 kept 窗（releaseBinding 跳过释放的判据）。 */
  isKeptServiceAlive(serviceKey: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.serviceKey === serviceKey && entry.state === 'kept') return true;
    }
    return false;
  }

  /** 条目翻 closed：URL 留存；池条目释放（死窗不占池容量、不挡新任务）。 */
  markClosed(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (entry?.state !== 'kept') return;
    entry.state = 'closed';
    this.unsubs.get(conversationId)?.();
    this.unsubs.delete(conversationId);
    this.retireKeptService(entry);
    logger.info(`Kept result page closed (conversation ${entry.conversationId}): ${entry.url}`);
  }

  /** run 收尾时用窗的最终地址刷新 kept 条目（keep 之后模型又导航过的场景）。 */
  refreshTarget(conversationId: string, url: string, title: string): void {
    const entry = this.entries.get(conversationId);
    if (entry?.state !== 'kept') return;
    entry.url = url;
    entry.title = title;
  }

  /** IPC 三态快照。 */
  snapshot(conversationId: string): KeptResultPageSnapshot {
    const entry = this.entries.get(conversationId);
    if (!entry) return { state: 'none', url: null, title: null };
    return { state: entry.state, url: entry.url, title: entry.title };
  }

  private markClosedIfService(conversationId: string, serviceKey: string): void {
    const entry = this.entries.get(conversationId);
    if (entry?.serviceKey !== serviceKey) return;
    this.markClosed(conversationId);
  }

  private retireKeptService(entry: KeptBrowserEntry): void {
    this.pool.setKept(entry.serviceKey, false);
    void this.pool.releaseAgent(entry.serviceKey).catch(() => undefined);
  }
}

let keptBrowserRegistry: KeptBrowserRegistry | null = null;

export function getKeptBrowserRegistry(): KeptBrowserRegistry {
  keptBrowserRegistry ??= new KeptBrowserRegistry();
  return keptBrowserRegistry;
}
