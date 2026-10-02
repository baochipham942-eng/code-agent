#!/usr/bin/env npx tsx
// One Jev decisions call for the orchestrator's real-endpoint check.
// Sends one existing noul, one choice, and one score question. No key prints
// "SKIP no key" and exits 0. Does not print the key.
//
//   npx tsx scripts/acceptance/jev-route-probe.ts
//   npx tsx scripts/acceptance/jev-route-probe.ts --route official
//   npx tsx scripts/acceptance/jev-route-probe.ts --route openrouter

import { pathToFileURL } from 'node:url';
import { JEV_OPENROUTER_MODEL, MODEL_API_ENDPOINTS } from '../../src/shared/constants/providers.ts';
import {
  EVAL_JUDGE_QUALITY_QUESTION,
  JEV_TIMEOUT_MS,
  PERMCLASS_QUESTIONS,
} from '../../src/shared/constants/jevQuestions.ts';
import { getConfigService } from '../../src/host/services/core/configService.ts';
import {
  buildJevDecisionRequestBody,
  postJevDecision,
  type JevRoute,
} from '../../src/host/model/providers/jevDecisionRequest.ts';
import { resolveJevRoute } from '../../src/host/model/providers/typesafeProvider.ts';

const USAGE = `Usage:
  npx tsx scripts/acceptance/jev-route-probe.ts [--route official|openrouter]

Sends one noul (needs_human), one choice (risk), and one score (quality) question.
No key for the selected route prints "SKIP no key" and exits 0.`;

const QUESTIONS = {
  needs_human: PERMCLASS_QUESTIONS.needs_human,
  risk: PERMCLASS_QUESTIONS.risk,
  quality: EVAL_JUDGE_QUALITY_QUESTION,
};

const STATE = {
  tool: 'Read',
  summary: 'read README.md',
  input: { prompt: 'read README.md' },
  output: { toolExecutions: [] },
};

function presentKey(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

/**
 * --route openrouter forces the OpenRouter branch even when the official key
 * wins resolveJevRoute(). Endpoint and model stay the shared constants.
 */
function openrouterRoute(): JevRoute | null {
  const apiKey = presentKey(getConfigService().getApiKey('openrouter'));
  if (!apiKey) return null;
  return {
    kind: 'openrouter',
    endpoint: MODEL_API_ENDPOINTS.openrouterDecisions,
    model: JEV_OPENROUTER_MODEL,
    apiKey,
  };
}

function selectRoute(flag: 'official' | 'openrouter' | undefined): JevRoute | null {
  if (flag === 'openrouter') return openrouterRoute();
  const route = resolveJevRoute();
  if (flag === 'official') return route?.kind === 'official' ? route : null;
  return route;
}

function parseArgs(argv: string[]): { help: boolean; route?: 'official' | 'openrouter' } | { error: string } {
  let route: 'official' | 'openrouter' | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    const value = arg === '--route' ? argv[index + 1] : arg.startsWith('--route=') ? arg.slice('--route='.length) : undefined;
    if (value === undefined) return { error: `unknown argument: ${arg}` };
    if (arg === '--route') index += 1;
    if (value !== 'official' && value !== 'openrouter') return { error: `--route must be official or openrouter` };
    route = value;
  }
  return { help: false, route };
}

function answerShape(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  return Object.entries(value as Record<string, unknown>).map(([name, answer]) => {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return `${name}=invalid`;
    if ('noul' in answer) return `${name}=noul`;
    if ('choice' in answer) return `${name}=choice`;
    if ('score' in answer) return `${name}=score`;
    return `${name}=unknown`;
  }).join(' ');
}

export async function runJevRouteProbe(
  argv: string[],
  log: (line: string) => void = console.log,
  errorLog: (line: string) => void = console.error,
): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    errorLog(parsed.error);
    errorLog(USAGE);
    return 2;
  }
  if (parsed.help) {
    log(USAGE);
    return 0;
  }

  const route = selectRoute(parsed.route);
  if (!route) {
    log('SKIP no key');
    return 0;
  }

  log(`route kind=${route.kind} model=${route.model} endpoint=${route.endpoint}`);
  const body = buildJevDecisionRequestBody(route, STATE, QUESTIONS);
  let response: Response;
  try {
    response = await postJevDecision(route, body, AbortSignal.timeout(JEV_TIMEOUT_MS));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorLog(`http=error ${redactSecret(message, route.apiKey)}`);
    return 1;
  }

  const raw = await response.text().catch(() => '');
  const safe = redactSecret(raw, route.apiKey);
  log(`http=${response.status}`);
  if (!response.ok) {
    errorLog(safe.slice(0, 200));
    return 1;
  }

  try {
    const parsedBody = JSON.parse(raw) as { answers?: unknown };
    const shape = answerShape(parsedBody.answers);
    log(`answerShape ${shape}`);
    if (shape === 'invalid' || shape.includes('=invalid') || shape.includes('=unknown')) return 1;
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorLog(`answerShape invalid ${redactSecret(message, route.apiKey)}`);
    errorLog(safe.slice(0, 200));
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runJevRouteProbe(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    },
  );
}
