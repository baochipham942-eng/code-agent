// ============================================================================
// useTurnOutcomeStamps —— 会话印章（turn_outcome）只读订阅
// ----------------------------------------------------------------------------
// TurnCard/任务卡消费印章的取数口。数据走 P0B 整读路由，按会话做短 TTL 缓存
// （同一屏几十张 TurnCard 不能各发一次请求）。任何失败一律返回空列表——
// 无印章（存量旧会话 / 服务不可用）就不显示，不臆造。
// ============================================================================

import { useEffect, useState } from 'react';
import { fetchSessionTrace } from '../services/traceLedgerClient';
import {
  readTurnOutcome,
  type TurnOutcomeStamp,
} from '../components/TaskPanel/SessionInspector/model';

const STALE_MS = 4000;

interface StampCacheEntry {
  stamps: TurnOutcomeStamp[];
  fetchedAt: number;
  inFlight: Promise<void> | null;
}

const cache = new Map<string, StampCacheEntry>();

function getEntry(sessionId: string): StampCacheEntry {
  let entry = cache.get(sessionId);
  if (!entry) {
    entry = { stamps: [], fetchedAt: 0, inFlight: null };
    cache.set(sessionId, entry);
  }
  return entry;
}

export function useTurnOutcomeStamps(sessionId: string | undefined): TurnOutcomeStamp[] {
  const [stamps, setStamps] = useState<TurnOutcomeStamp[]>(() =>
    sessionId ? getEntry(sessionId).stamps : [],
  );

  useEffect(() => {
    if (!sessionId) {
      setStamps([]);
      return;
    }
    const entry = getEntry(sessionId);
    setStamps(entry.stamps);
    const stale = Date.now() - entry.fetchedAt > STALE_MS;
    if (!stale || entry.inFlight) return;
    entry.inFlight = fetchSessionTrace(sessionId)
      .then((read) => {
        entry.fetchedAt = Date.now();
        if (!read) return;
        entry.stamps = read.events
          .map(readTurnOutcome)
          .filter((stamp): stamp is TurnOutcomeStamp => stamp !== null);
        setStamps(entry.stamps);
      })
      .finally(() => {
        entry.inFlight = null;
      });
  }, [sessionId]);

  return stamps;
}

/**
 * 印章对轮到卡片：账本 turnIndex 是 run 内迭代号、跨 run 会重启，不能当轮号用；
 * 时间窗是唯一稳健的对法——run 收尾时落印章，ts 必落在该轮 [start, end] 附近。
 */
export function matchStampForTurn(
  stamps: readonly TurnOutcomeStamp[],
  turn: { startTime: number; endTime?: number },
  now = Date.now(),
): TurnOutcomeStamp | null {
  const start = turn.startTime - 2000;
  const end = (turn.endTime ?? now) + 10_000;
  let matched: TurnOutcomeStamp | null = null;
  for (const stamp of stamps) {
    if (stamp.ts !== null && stamp.ts >= start && stamp.ts <= end) matched = stamp;
  }
  return matched;
}
