// Wraps the production systemOne. jev-skill-rerank-eval.ts redirects the
// factory's dynamic import here so call, error, and shape counts stay on the
// real judge path.
import { estimateJevCallUsd, type JevQuestionSpec } from '../../src/shared/constants/jevQuestions.ts';
import { systemOne as realSystemOne } from '../../src/host/model/providers/typesafeProvider.ts';

const SECRET_ENV = [
  'TYPESAFE_API_KEY',
  'DEEPSEEK_API_KEY',
  'STEPFUN_API_KEY',
  'MOONSHOT_API_KEY',
  'LONGCAT_API_KEY',
  'OPENAI_API_KEY',
];

export interface SpyTrace {
  badShape: boolean;
  error?: string;
  answers?: Record<string, unknown>;
  rosterNames: string[];
  usd: number;
}

export const systemOneSpy = {
  calls: 0,
  errors: 0,
  badShapes: 0,
  usd: 0,
  traces: [] as SpyTrace[],
};

function redact(text: string): string {
  let out = text;
  for (const name of SECRET_ENV) {
    const value = process.env[name];
    if (value && value.trim().length >= 6) out = out.split(value).join('[redacted]');
  }
  return out.slice(0, 240);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function choiceOk(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('choice' in value)) return false;
  const record = value as { choice?: unknown; confidence?: unknown };
  return typeof record.choice === 'string' && isUnitInterval(record.confidence);
}

function noulOk(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('noul' in value)) return false;
  return isUnitInterval((value as { noul?: unknown }).noul);
}

function jevAnswerShapeOk(answers: unknown): boolean {
  if (!answers || typeof answers !== 'object') return false;
  const record = answers as Record<string, unknown>;
  return choiceOk(record.choice)
    && noulOk(record.need_skill)
    && noulOk(record.need_now)
    && noulOk(record.none_of_roster);
}

function rosterNamesOf(state: Record<string, unknown>): string[] {
  if (!Array.isArray(state.roster)) return [];
  const names: string[] = [];
  for (const item of state.roster) {
    if (!item || typeof item !== 'object' || !('name' in item)) continue;
    const name = (item as { name?: unknown }).name;
    if (typeof name === 'string') names.push(name);
  }
  return names;
}

export async function systemOne(
  state: Record<string, unknown>,
  questions: Record<string, JevQuestionSpec>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  systemOneSpy.calls += 1;
  const usd = estimateJevCallUsd(JSON.stringify(state).length, JSON.stringify(questions).length);
  systemOneSpy.usd += usd;
  const trace: SpyTrace = {
    badShape: false,
    rosterNames: rosterNamesOf(state),
    usd,
  };
  systemOneSpy.traces.push(trace);
  try {
    const answers = await realSystemOne(state, questions, options);
    const record = answers as unknown as Record<string, unknown>;
    trace.answers = record;
    if (!jevAnswerShapeOk(record)) {
      trace.badShape = true;
      systemOneSpy.badShapes += 1;
    }
    return record;
  } catch (error) {
    systemOneSpy.errors += 1;
    trace.error = redact(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
