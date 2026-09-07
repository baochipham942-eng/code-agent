// ============================================================================
// 上线后坏案例回流四道闸（ADR-063 §5 · N-EVAL-POSTLAUNCH-REFLOW）
// ----------------------------------------------------------------------------
// 候选、同意档、敏感内容和 HARDENGATE 分别由各自真源负责；本模块只做
// 回流入口的组合判定，避免 UI/CLI 各写一套「看起来通过」的条件。
// ============================================================================
import type BetterSqlite3 from 'better-sqlite3';
import {
  POST_LAUNCH_CONSENT_SCOPES,
  type PostLaunchConsentScope,
  type PostLaunchReflowCandidate,
} from '../../../shared/contract/postLaunchScore';
import { getPostLaunchConsentScope, hasReflowCandidate } from './postLaunchScoreStore';

const CONSENT_RANK: Record<PostLaunchConsentScope, number> = {
  metadata: 0,
  turn_excerpt: 1,
  full_session: 2,
};

export interface ReflowGateDecision {
  allowed: boolean;
  reason?: 'not_candidate' | 'consent_required' | 'consent_stale';
  consentScope: PostLaunchConsentScope;
}

export function isPostLaunchConsentScope(value: unknown): value is PostLaunchConsentScope {
  return typeof value === 'string' && POST_LAUNCH_CONSENT_SCOPES.includes(value as PostLaunchConsentScope);
}

/** 回流草稿要求至少「这一轮摘录」；metadata 只能留分数行，不能进草稿。 */
export function checkPostLaunchReflowGates(
  db: BetterSqlite3.Database,
  candidate: Pick<PostLaunchReflowCandidate, 'sessionId' | 'turnId'> & {
    previewConsentScope?: PostLaunchConsentScope;
  },
): ReflowGateDecision {
  const consentScope = getPostLaunchConsentScope(db, candidate.sessionId);
  if (!hasReflowCandidate(db, candidate)) {
    return { allowed: false, reason: 'not_candidate', consentScope };
  }
  if (CONSENT_RANK[consentScope] < CONSENT_RANK.turn_excerpt) {
    return { allowed: false, reason: 'consent_required', consentScope };
  }
  if (
    candidate.previewConsentScope
    && CONSENT_RANK[consentScope] < CONSENT_RANK[candidate.previewConsentScope]
  ) {
    return { allowed: false, reason: 'consent_stale', consentScope };
  }
  return { allowed: true, consentScope };
}
