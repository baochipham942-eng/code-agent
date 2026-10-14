// ============================================================================
// delegationCandidates — read-only candidate projection for cross-session
// delegation (ADR-072 D3 candidate construction / D4 list_session_candidates,
// slice K1B)
// ============================================================================
// Pure, synchronous: rows in, projection out. No stable sessionId in the
// model-visible output; the projection object carries the ids host-internally
// so resolveCandidateRef can map an opaque ref back without a lookup table.
// ============================================================================

import { createHash, createHmac } from 'node:crypto';

const CANDIDATE_CAP = 32;
const CANDIDATE_SET_ID_HEX_LENGTH = 16;
const CANDIDATE_REF_LENGTH = 16;
const SHORT_NAME_MAX_LENGTH = 40;

const FRESHNESS_HOUR_MS = 60 * 60 * 1000;
const FRESHNESS_DAY_MS = 24 * FRESHNESS_HOUR_MS;
const FRESHNESS_WEEK_MS = 7 * FRESHNESS_DAY_MS;

export interface SessionCandidateRow {
  id: string;
  title?: string;
  workingDirectory?: string;
  updatedAt: number;
  /** 缺省 = chat。 */
  sessionType?: string;
  isArchived?: boolean;
  isDeleted?: boolean;
  /** 缺省 = native。 */
  engineKind?: string;
  /** 用户手动分叉也是 chat 候选：不按 parent 过滤（R1 教训），字段仅透传。 */
  parentSessionId?: string;
}

type SessionCandidateFreshness = '1h' | '1d' | '7d' | 'older';

interface SessionCandidate {
  candidateRef: string;
  shortName: string;
  workspaceName: string;
  status: 'running' | 'idle';
  freshness: SessionCandidateFreshness;
}

export interface SessionCandidateProjection {
  candidateSetId: string;
  /** 模型可见条目（无 stable sessionId）。 */
  candidates: SessionCandidate[];
  /** host 内部：与 candidates 平行排列的 session id，绝不进模型输出。 */
  sessionIds: string[];
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function candidateRefFor(secret: string, candidateSetId: string, sessionId: string): string {
  return createHmac('sha256', secret)
    .update(`${candidateSetId}\0${sessionId}`, 'utf8')
    .digest('base64url')
    .slice(0, CANDIDATE_REF_LENGTH);
}

function freshnessBucket(now: number, updatedAt: number): SessionCandidateFreshness {
  const age = now - updatedAt;
  if (age <= FRESHNESS_HOUR_MS) return '1h';
  if (age <= FRESHNESS_DAY_MS) return '1d';
  if (age <= FRESHNESS_WEEK_MS) return '7d';
  return 'older';
}

function shortNameOf(title: string | undefined): string {
  const trimmed = (title ?? '').trim();
  return trimmed.length <= SHORT_NAME_MAX_LENGTH
    ? trimmed
    : trimmed.slice(0, SHORT_NAME_MAX_LENGTH);
}

function workspaceNameOf(workingDirectory: string | undefined): string {
  const trimmed = (workingDirectory ?? '').trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? '';
}

/**
 * 候选投影：只收 session_type=chat（缺省 chat）、未归档未删除、非发起会话、
 * native 引擎；按 updatedAt 降序再按 id 升序，截断 32。用户手动分叉的会话
 * （type chat 带 parent）是合法候选，不用 parent_session_id 过滤。
 */
export function projectSessionCandidates(
  rows: ReadonlyArray<SessionCandidateRow>,
  input: { originSessionId: string; now: number; secret: string; isRunning?: (sessionId: string) => boolean },
): SessionCandidateProjection {
  const eligible = rows
    .filter((row) => (row.sessionType ?? 'chat') === 'chat')
    .filter((row) => !row.isArchived && !row.isDeleted)
    .filter((row) => row.id !== input.originSessionId)
    .filter((row) => (row.engineKind ?? 'native') === 'native')
    .sort((left, right) => (right.updatedAt - left.updatedAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .slice(0, CANDIDATE_CAP);

  const sessionIds = eligible.map((row) => row.id);
  const candidateSetId = sha256Hex(sessionIds.join('\0')).slice(0, CANDIDATE_SET_ID_HEX_LENGTH);

  return {
    candidateSetId,
    candidates: eligible.map((row) => ({
      candidateRef: candidateRefFor(input.secret, candidateSetId, row.id),
      shortName: shortNameOf(row.title),
      workspaceName: workspaceNameOf(row.workingDirectory),
      status: input.isRunning?.(row.id) ? 'running' : 'idle',
      freshness: freshnessBucket(input.now, row.updatedAt),
    })),
    sessionIds,
  };
}

export type ResolvedCandidateRef =
  | { ok: true; sessionId: string }
  | { ok: false; code: 'candidate_set_stale' | 'ambiguous' };

/**
 * 反查不透明 ref：调用方带回它见过的 candidateSetId 与 candidateRef，宿主用
 * 当前投影 + secret 重算比对。集合指纹对不上 → candidate_set_stale；当前集合里
 * 对不上任何一条 → ambiguous。稳定 sessionId 只在 host 内部往返。
 */
export function resolveCandidateRef(
  reference: { candidateSetId?: string; candidateRef?: string },
  currentProjection: SessionCandidateProjection,
  secret: string,
): ResolvedCandidateRef {
  if (reference.candidateSetId && reference.candidateSetId !== currentProjection.candidateSetId) {
    return { ok: false, code: 'candidate_set_stale' };
  }
  if (!reference.candidateRef) {
    return { ok: false, code: 'ambiguous' };
  }
  for (let index = 0; index < currentProjection.sessionIds.length; index += 1) {
    const sessionId = currentProjection.sessionIds[index];
    if (candidateRefFor(secret, currentProjection.candidateSetId, sessionId) === reference.candidateRef) {
      return { ok: true, sessionId };
    }
  }
  return { ok: false, code: 'ambiguous' };
}
