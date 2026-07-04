// ============================================================================
// IM 入站幂等去重集（WP3-2）。
//
// 平台会重复投递同一事件（飞书 webhook 3s 未回 200 重推、连接抖动重放等），
// channel 层在处理入口用平台原生幂等 ID（feishu event_id/message_id、telegram
// update_id）去重，挡在解析/媒体下载等昂贵处理之前。
//
// 语义：有界（防内存无界增长，超界逐出最旧）；入站幂等 fail-open——判定不了
// 一律当新消息处理（重复处理的代价是浪费一次算力，吞消息的代价是丢用户输入）。
// ============================================================================

export class BoundedDedupeSet {
  /** Map 迭代序 = 插入序：仅用 key，超界逐出最旧。 */
  private readonly seen = new Map<string, true>();

  constructor(private readonly maxEntries: number) {}

  /** 首次见到该 id 返回 true 并登记；重复返回 false。 */
  markSeen(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.set(id, true);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }
}
