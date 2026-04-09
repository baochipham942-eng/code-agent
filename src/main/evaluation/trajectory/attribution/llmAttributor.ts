// ============================================================================
// LLM Attributor — Self-Evolving v2.5 Phase 2
//
// Dependency-injected LLM fallback for trajectory root-cause attribution.
// The caller provides a `chatFn(prompt) => Promise<string>`; this module
// builds a compact summary prompt, parses the response, and validates the
// payload against the FailureRootCause schema. Any error returns null so
// the facade can gracefully fall back to the rule-based result.
//
// Design constraints:
// - No direct provider import (keeps testing deterministic and avoids
//   hard-coding model ids — respects the project's constants rule).
// - Truncates trajectories to a head + tail summary to stay within a
//   ~5K token budget (approximate, char-based).
// ============================================================================

import type {
  Trajectory,
  TrajectoryStep,
  FailureCategory,
  FailureRootCause,
} from '../../../testing/types';

const PROMPT_CHAR_BUDGET = 15000; // ~5K tokens; safe for all mainstream models
const HEAD_STEPS = 5;
const TAIL_STEPS = 5;

const VALID_CATEGORIES: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  'tool_error',
  'bad_decision',
  'missing_context',
  'loop',
  'hallucination',
  'env_failure',
  'unknown',
]);

export type ChatFn = (prompt: string) => Promise<string>;

/**
 * Attempt to attribute trajectory root cause via an injected LLM.
 * Returns null on any failure (parse, schema, or network).
 */
export async function attributeByLLM(
  trajectory: Trajectory,
  chatFn: ChatFn
): Promise<FailureRootCause | null> {
  const prompt = buildPrompt(trajectory);

  let raw: string;
  try {
    raw = await chatFn(prompt);
  } catch {
    return null;
  }

  const json = extractJson(raw);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json);
    return validateRootCause(parsed);
  } catch {
    return null;
  }
}

function buildPrompt(trajectory: Trajectory): string {
  const { steps, deviations, summary } = trajectory;
  const head = steps.slice(0, HEAD_STEPS).map(formatStep);
  const tail =
    steps.length > HEAD_STEPS + TAIL_STEPS
      ? steps.slice(-TAIL_STEPS).map(formatStep)
      : [];

  const lines = [
    'You are a software engineering observability analyst.',
    'Analyze the following agent trajectory and identify the ROOT CAUSE of failure.',
    '',
    `Intent: ${summary.intent}`,
    `Outcome: ${summary.outcome}`,
    `Total steps: ${steps.length}`,
    `Deviations detected (${deviations.length}):`,
    ...deviations.slice(0, 10).map(
      (d) => `  - [step ${d.stepIndex}] ${d.type} (${d.severity}): ${d.description}`
    ),
    '',
    'First steps:',
    ...head,
  ];

  if (tail.length > 0) {
    lines.push('', 'Last steps:', ...tail);
  }

  lines.push(
    '',
    'Respond with ONLY a JSON object matching this schema:',
    '{',
    '  "stepIndex": number,            // index of the step that caused the failure',
    '  "category": "tool_error" | "bad_decision" | "missing_context" | "loop" | "hallucination" | "env_failure" | "unknown",',
    '  "summary": string,              // one sentence explanation',
    '  "evidence": number[],           // related step indices',
    '  "confidence": number            // 0.0 to 1.0',
    '}',
    '',
    'Return the JSON object and nothing else.'
  );

  let prompt = lines.join('\n');
  if (prompt.length > PROMPT_CHAR_BUDGET) {
    prompt = prompt.slice(0, PROMPT_CHAR_BUDGET) + '\n[TRUNCATED]';
  }
  return prompt;
}

function formatStep(step: TrajectoryStep): string {
  if (step.type === 'tool_call' && step.toolCall) {
    const status = step.toolCall.success ? 'ok' : 'FAIL';
    return `  [${step.index}] tool_call ${step.toolCall.name} (${status})`;
  }
  if (step.type === 'error' && step.error) {
    return `  [${step.index}] error: ${step.error.message.slice(0, 200)}`;
  }
  if (step.type === 'decision' && step.decision) {
    return `  [${step.index}] decision: ${step.decision.reasoning.slice(0, 200)}`;
  }
  return `  [${step.index}] ${step.type}`;
}

/**
 * Extract a JSON object from raw LLM output.
 * Handles fenced code blocks and stray prose.
 */
function extractJson(raw: string): string | null {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return raw.slice(braceStart, braceEnd + 1);
  }
  return null;
}

function validateRootCause(parsed: unknown): FailureRootCause | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const stepIndex = obj.stepIndex;
  const category = obj.category;
  const summary = obj.summary;
  const evidence = obj.evidence;
  const confidence = obj.confidence;

  if (typeof stepIndex !== 'number' || !Number.isFinite(stepIndex)) return null;
  if (typeof category !== 'string' || !VALID_CATEGORIES.has(category as FailureCategory)) {
    return null;
  }
  if (typeof summary !== 'string' || summary.length === 0) return null;
  if (!Array.isArray(evidence) || evidence.some((e) => typeof e !== 'number')) return null;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) return null;

  return {
    stepIndex,
    category: category as FailureCategory,
    summary,
    evidence: evidence as number[],
    confidence,
  };
}
