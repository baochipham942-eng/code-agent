// 命中二分：effective = 停滞指纹变了；idle = 指纹没变。
// 命中来源可以是工具缓存、进程内推理缓存或 provider cacheRead，不能只看 cacheRead>0。

type CacheHitKind = 'effective' | 'idle';

export interface RecordedCacheHit {
  kind: CacheHitKind;
  /** 该 session 累计，从 1 起。 */
  effective: number;
  idle: number;
}

interface SessionHitState {
  /** 最近一次工具停滞指纹。 */
  fingerprint?: string;
  /** 上一次命中时看到的指纹。 */
  fingerprintAtHit?: string;
  seenHit: boolean;
  effective: number;
  idle: number;
}

const sessions = new Map<string, SessionHitState>();
const MAX_SESSION_STATES = 256;

function stateFor(sessionId: string): SessionHitState {
  const existing = sessions.get(sessionId);
  if (existing) {
    sessions.delete(sessionId);
    sessions.set(sessionId, existing);
    return existing;
  }
  if (sessions.size >= MAX_SESSION_STATES) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  const created: SessionHitState = { seenHit: false, effective: 0, idle: 0 };
  sessions.set(sessionId, created);
  return created;
}

export function clearSessionCacheHits(sessionId: string): void {
  sessions.delete(sessionId);
}

/** 工具批次推进后记下当前停滞指纹，供下一次命中比较。 */
export function noteStagnationFingerprint(sessionId: string, fingerprint: string): void {
  stateFor(sessionId).fingerprint = fingerprint;
}

/**
 * 指纹相对上一次命中是否变化。
 * 第一次命中且已经有指纹 → effective；两边都没有指纹 → idle（没有进展）。
 */
function classifyCacheHitByFingerprint(
  previousFingerprint: string | undefined,
  currentFingerprint: string | undefined,
  seenPreviousHit: boolean,
): CacheHitKind {
  if (!seenPreviousHit) {
    return currentFingerprint === undefined ? 'idle' : 'effective';
  }
  return previousFingerprint !== currentFingerprint ? 'effective' : 'idle';
}

/** 工具缓存或推理缓存本身就是命中；cacheRead>0 只是其中一条信号。 */
export function isObservedCacheHit(input: {
  cacheReadTokens?: number;
  inferenceCacheHit?: boolean;
  toolCacheHit?: boolean;
}): boolean {
  if (input.toolCacheHit === true || input.inferenceCacheHit === true) return true;
  return (input.cacheReadTokens ?? 0) > 0;
}

export function recordSessionCacheHit(sessionId: string, fingerprint?: string): RecordedCacheHit {
  const state = stateFor(sessionId);
  const current = fingerprint ?? state.fingerprint;
  const kind = classifyCacheHitByFingerprint(state.fingerprintAtHit, current, state.seenHit);
  if (kind === 'effective') state.effective += 1;
  else state.idle += 1;
  state.seenHit = true;
  state.fingerprintAtHit = current;
  if (fingerprint !== undefined) state.fingerprint = fingerprint;
  return {
    kind,
    effective: state.effective,
    idle: state.idle,
  };
}
