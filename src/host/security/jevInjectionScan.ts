// Jev injection second layer. This is an advisory scan behind the deterministic
// regex sanitizer; it never turns content into an allow signal and never deletes text.

import { guardSensitiveText } from './sensitiveDataGuard';
import { getInputSanitizer } from './inputSanitizer';
import {
  JEV_INJECTION_QUESTIONS,
  JEV_INJECTION_THRESHOLDS,
  JEV_MODEL,
  type JevAnswers,
  type JevNoulAnswer,
  type JevSystemOneCall,
} from '../../shared/constants/jevQuestions';
import { resolveProviderApiKey } from '../model/providers/providerResolution';

export interface JevInjectionScanResult {
  skipped: boolean;
  flagged: boolean;
  injection: number;
  exfilRequest: number;
  reason?: 'disabled' | 'not_remote' | 'regex_hit' | 'unavailable' | 'bad_shape';
}

const REMOTE_TOOL_PREFIXES = [
  'web_fetch', 'web_search', 'read_pdf', 'read_document', 'read_docx', 'read_xlsx',
  'academic_search', 'external_search', 'twitter_fetch', 'github_pr', 'jira', 'http_request',
  'browser', 'Browser', 'mcp__', 'mcp_',
  'memory_write', 'remote_skill',
];

export function isJevInjectionScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_JEV_INJECTION_SCAN === '1';
}

export function isRemoteInjectionSource(source: string): boolean {
  return REMOTE_TOOL_PREFIXES.some((prefix) => source === prefix || source.startsWith(prefix));
}

function noul(answer: JevAnswers[string] | undefined): number | null {
  if (!answer || typeof answer !== 'object' || !('noul' in answer)) return null;
  const value = (answer as JevNoulAnswer).noul;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function unavailable(reason: JevInjectionScanResult['reason'] = 'unavailable'): JevInjectionScanResult {
  return { skipped: true, flagged: false, injection: 0, exfilRequest: 0, reason };
}

/**
 * Run the advisory second layer. The caller supplies a seam for replay tests;
 * production uses the pinned provider only when the explicit flag and key exist.
 */
export async function scanWithJevInjection(
  source: string,
  text: string,
  systemOne?: JevSystemOneCall,
): Promise<JevInjectionScanResult> {
  if (!isJevInjectionScanEnabled()) return unavailable('disabled');
  if (!isRemoteInjectionSource(source)) return unavailable('not_remote');
  if (!text) return { skipped: false, flagged: false, injection: 0, exfilRequest: 0 };

  // The regex layer remains authoritative for known signatures. Jev only gets
  // clean text, and every string crossing the provider boundary is guarded.
  const deterministic = getInputSanitizer().sanitize(text, source, { scope: 'lenient' });
  if (deterministic.warnings.length > 0) return unavailable('regex_hit');
  const state = {
    source: guardSensitiveText(source, { surface: 'telemetry', mode: 'model-context' }),
    remote_text: guardSensitiveText(text.slice(0, 12_000), { surface: 'telemetry', mode: 'model-context' }),
  };

  const call = systemOne ?? (async (stateArg, questions, options) => {
    const providerKey = resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL });
    if (!providerKey) throw new Error('TYPESAFE_KEY_MISSING');
    const { systemOne: productionSystemOne } = await import('../model/providers/typesafeProvider');
    return productionSystemOne(stateArg, questions, options);
  });

  let answers: JevAnswers;
  try {
    answers = await call(state, JEV_INJECTION_QUESTIONS);
  } catch {
    return unavailable('unavailable');
  }

  const injection = noul(answers.injection);
  const exfilRequest = noul(answers.exfil_request);
  if (injection === null || exfilRequest === null) return unavailable('bad_shape');
  return {
    skipped: false,
    flagged: injection >= JEV_INJECTION_THRESHOLDS.flag || exfilRequest >= JEV_INJECTION_THRESHOLDS.flag,
    injection,
    exfilRequest,
  };
}
