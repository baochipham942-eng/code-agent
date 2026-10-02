// Jev decisions 请求体与传输。systemOne 与验收探针共用这一份，
// 真机核对后只改这里的 body，不在调用点各写一份。

import type { JevQuestionSpec } from '../../../shared/constants/jevQuestions';

export interface JevRoute {
  kind: 'official' | 'openrouter';
  endpoint: string;
  model: string;
  apiKey: string;
}

interface JevDecisionRequestBody {
  state: Record<string, unknown>;
  model: string;
  questions: Record<string, JevQuestionSpec>;
}

export function buildJevDecisionRequestBody(
  route: JevRoute,
  state: Record<string, unknown>,
  questions: Record<string, JevQuestionSpec>,
): JevDecisionRequestBody {
  return { state, model: route.model, questions };
}

/** 只负责 POST。状态码与答案形状由调用方解释。 */
export function postJevDecision(
  route: JevRoute,
  body: JevDecisionRequestBody,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(route.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${route.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
}
