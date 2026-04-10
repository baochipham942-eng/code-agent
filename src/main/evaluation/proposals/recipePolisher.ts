// ============================================================================
// Recipe Polisher — Self-Evolving v2.5 Phase 6
//
// Upgrades static proposal recipe templates by asking an injected LLM to
// produce rule bullets that are grounded in the actual evidence summaries
// from recent grader reports (instead of the hard-coded 7-category defaults).
//
// Design constraints (mirrors Phase 2 llmAttributor):
// - No direct provider import — caller injects `chatFn(prompt) => Promise<string>`.
// - Any failure (network / parse / schema) returns null so the generator
//   can fall back to the static recipe deterministically.
// - Output language: Simplified Chinese, matching the static templates and
//   the project's CLAUDE.md "所有回复、注释、文档使用中文" rule.
// ============================================================================

export type ChatFn = (prompt: string) => Promise<string>;

export interface StaticRecipe {
  hypothesis: string;         // 静态模板渲染后的 hypothesis（含 count 替换）
  targetMetric: string;
  ruleDraftHeader: string;
  ruleDraftBullets: string[];
}

export interface RecipePolishInput {
  category: string;
  count: number;              // cluster.count
  weightedScore: number;      // cluster.weightedScore (sum of confidence)
  sampleSummaries: string[];  // raw root_cause_summary strings (already truncated if needed)
  staticRecipe: StaticRecipe;
}

export interface PolishedRecipe {
  hypothesis: string;
  targetMetric: string;
  ruleDraftHeader: string;
  ruleDraftBullets: string[];
}

const PROMPT_CHAR_BUDGET = 8000;       // ~2.5K tokens, plenty for this task
const MIN_BULLETS = 2;
const MAX_BULLETS = 6;
const MAX_BULLET_LEN = 200;
const MAX_HYPOTHESIS_LEN = 200;
const MAX_METRIC_LEN = 200;
const MAX_HEADER_LEN = 80;

/**
 * Ask an LLM to polish a proposal recipe based on real evidence.
 * Returns null on any failure — caller should fall back to the static recipe.
 */
export async function polishRecipe(
  input: RecipePolishInput,
  chatFn: ChatFn
): Promise<PolishedRecipe | null> {
  const prompt = buildPrompt(input);

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
    return validatePolished(parsed);
  } catch {
    return null;
  }
}

export function buildPrompt(input: RecipePolishInput): string {
  const { category, count, weightedScore, sampleSummaries, staticRecipe } = input;

  const lines: string[] = [
    '你是一个 AI Agent 自进化循环里的规则评审员。',
    '根据最近失败 session 的根因证据，把一份"静态规则草稿"润色成更贴证据、更可执行的版本。',
    '',
    `失败根因类别: ${category}`,
    `最近命中次数: ${count}`,
    `严重度加权分: ${weightedScore.toFixed(2)}`,
    '',
    '近期证据样本 (grader report root_cause_summary):',
    ...sampleSummaries.slice(0, 8).map((s, i) => `  ${i + 1}. ${s.slice(0, 300)}`),
    '',
    '原静态规则草稿（仅作 baseline，可以保留、修改、或整体替换）:',
    `  Header: ${staticRecipe.ruleDraftHeader}`,
    `  Hypothesis: ${staticRecipe.hypothesis}`,
    `  Target metric: ${staticRecipe.targetMetric}`,
    '  Rule bullets:',
    ...staticRecipe.ruleDraftBullets.map((b) => `    - ${b}`),
    '',
    '输出要求:',
    '- 全部使用简体中文',
    `- ruleDraftBullets 数量在 ${MIN_BULLETS}-${MAX_BULLETS} 条之间，每条 ≤ ${MAX_BULLET_LEN} 字`,
    '- 每条 bullet 必须是 Agent 在下一次运行时可以立刻遵守的"动作规则"（"当 X 时必须 Y"），不要写空泛目标',
    '- bullet 的内容必须能被上面至少一条证据支撑，不要编造未出现的问题',
    '- hypothesis 描述"如果应用这些规则，Agent 的行为会如何改善"，一句话',
    '- targetMetric 描述一个可度量的改进目标（百分比下降 / 次数下降等）',
    '- 返回严格的 JSON 对象，字段如下，不要包含任何解释、markdown 代码块、或额外文本:',
    '{',
    '  "hypothesis": string,',
    '  "targetMetric": string,',
    '  "ruleDraftHeader": string,',
    '  "ruleDraftBullets": string[]',
    '}',
  ];

  let prompt = lines.join('\n');
  if (prompt.length > PROMPT_CHAR_BUDGET) {
    prompt = prompt.slice(0, PROMPT_CHAR_BUDGET) + '\n[TRUNCATED]';
  }
  return prompt;
}

/**
 * Extract a JSON object from raw LLM output.
 * Handles fenced code blocks and stray prose.
 */
function extractJson(raw: string): string | null {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenceMatch) return fenceMatch[1].trim();
  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return raw.slice(braceStart, braceEnd + 1);
  }
  return null;
}

function validatePolished(parsed: unknown): PolishedRecipe | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const hypothesis = obj.hypothesis;
  const targetMetric = obj.targetMetric;
  const ruleDraftHeader = obj.ruleDraftHeader;
  const ruleDraftBullets = obj.ruleDraftBullets;

  if (!isNonEmptyString(hypothesis, MAX_HYPOTHESIS_LEN)) return null;
  if (!isNonEmptyString(targetMetric, MAX_METRIC_LEN)) return null;
  if (!isNonEmptyString(ruleDraftHeader, MAX_HEADER_LEN)) return null;

  if (!Array.isArray(ruleDraftBullets)) return null;
  if (ruleDraftBullets.length < MIN_BULLETS || ruleDraftBullets.length > MAX_BULLETS) {
    return null;
  }
  const bullets: string[] = [];
  for (const b of ruleDraftBullets) {
    if (!isNonEmptyString(b, MAX_BULLET_LEN)) return null;
    bullets.push(b.trim());
  }

  return {
    hypothesis: hypothesis.trim(),
    targetMetric: targetMetric.trim(),
    ruleDraftHeader: ruleDraftHeader.trim(),
    ruleDraftBullets: bullets,
  };
}

function isNonEmptyString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}
