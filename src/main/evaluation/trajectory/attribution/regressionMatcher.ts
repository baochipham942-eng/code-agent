// ============================================================================
// Regression Matcher — Self-Evolving v2.5 Phase 2
//
// Matches a Trajectory against known regression cases under
// ~/.claude/regression-cases/*.md using three signals (in priority order):
//   1) symptoms: optional frontmatter list of ASCII substrings (error
//      messages, code identifiers). A single substring hit in any
//      trajectory error/result text is a strong match (short-circuits).
//   2) tool-tag match: any case tag equals a trajectory tool name.
//   3) keyword overlap: ASCII tokens from scenario ∩ trajectory.
// Malformed case files are skipped silently; a missing directory
// returns an empty match list.
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Trajectory } from '../../../testing/types';

const MATCH_THRESHOLD = 0.5;
const TOOL_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.4;
const MIN_KEYWORD_LENGTH = 3;

// English stopwords that dilute keyword overlap scoring.
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  'will', 'would', 'should', 'could', 'have', 'has', 'had', 'can', 'may',
  'been', 'being', 'does', 'did', 'not', 'all', 'any', 'some', 'one', 'two',
  'what', 'when', 'where', 'who', 'why', 'how', 'which', 'into', 'out', 'off',
  'over', 'under', 'again', 'more', 'most', 'than', 'then', 'also', 'just',
  'very', 'too', 'only', 'own', 'same', 'new', 'old', 'use', 'used', 'its',
  'but', 'yet', 'these', 'those',
]);

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

interface LiteCase {
  id: string;
  tags: string[];
  scenarioKeywords: Set<string>;
  symptoms: string[]; // lowercase ASCII substrings (optional)
}

export function defaultRegressionCasesDir(): string {
  return path.join(os.homedir(), '.claude', 'regression-cases');
}

/**
 * Match a trajectory against regression cases.
 * Returns an array of matched case ids (score > threshold).
 */
export async function matchRegressionCases(
  trajectory: Trajectory,
  casesDir: string = defaultRegressionCasesDir()
): Promise<string[]> {
  const cases = await loadLiteCases(casesDir);
  if (cases.length === 0) return [];

  const trajTools = collectTrajectoryTools(trajectory);
  const trajKeywords = collectTrajectoryKeywords(trajectory);
  const trajHaystack = collectTrajectoryHaystack(trajectory);

  const matched: Array<{ id: string; score: number }> = [];

  for (const c of cases) {
    // Signal 1: symptoms substring match. Any hit → strong score (1.0).
    const symptomHit =
      c.symptoms.length > 0 && c.symptoms.some((s) => trajHaystack.includes(s));
    if (symptomHit) {
      matched.push({ id: c.id, score: 1.0 });
      continue;
    }

    // Signal 2: tool-tag match.
    const caseTagsLower = c.tags.map((t) => t.toLowerCase());
    const toolMatch = caseTagsLower.some((t) => trajTools.has(t)) ? 1 : 0;
    // Signal 3: keyword overlap.
    const keywordOverlap = overlapRatio(trajKeywords, c.scenarioKeywords);
    const score = toolMatch * TOOL_WEIGHT + keywordOverlap * KEYWORD_WEIGHT;
    if (score >= MATCH_THRESHOLD) {
      matched.push({ id: c.id, score });
    }
  }

  matched.sort((a, b) => b.score - a.score);
  return matched.map((m) => m.id);
}

async function loadLiteCases(dir: string): Promise<LiteCase[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const files = entries.filter((f) => f.startsWith('reg-') && f.endsWith('.md'));
  const out: LiteCase[] = [];

  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const parsed = parseLiteCase(raw, file);
      if (parsed) out.push(parsed);
    } catch {
      // skip malformed
    }
  }

  return out;
}

function parseLiteCase(raw: string, filename: string): LiteCase | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const [, fmText, body] = match;

  const id = extractFm(fmText, 'id') ?? path.basename(filename, '.md');
  const tagsRaw = extractFm(fmText, 'tags') ?? '';
  const tags = parseList(tagsRaw);

  const symptomsRaw = extractFm(fmText, 'symptoms') ?? '';
  const symptoms = parseList(symptomsRaw)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0);

  const scenario = extractSection(body, '场景');
  const scenarioKeywords = tokenize(scenario);

  // Include tags in keyword set to widen matches.
  for (const tag of tags) scenarioKeywords.add(tag.toLowerCase());

  return { id, tags, scenarioKeywords, symptoms };
}

function extractFm(fmText: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
  const m = re.exec(fmText);
  return m ? m[1].trim() : null;
}

function parseList(raw: string): string[] {
  if (!raw) return [];
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
  }
  return [raw];
}

function extractSection(body: string, heading: string): string {
  const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?:\\n##\\s|$)`, 'm');
  const m = re.exec(body);
  return m ? m[1].trim() : '';
}

function tokenize(text: string): Set<string> {
  // Extract ASCII alphanumeric tokens and underscore-joined identifiers
  // (e.g. `tool_use_id`, `sanitizeToolCallOrder`, `api`, `400`). This
  // deliberately skips CJK runs so Chinese-heavy case scenarios don't
  // inflate the denominator with unmatched blob tokens.
  const out = new Set<string>();
  const re = /[a-z0-9_]+/gi;
  const matches = text.toLowerCase().match(re) ?? [];
  for (const m of matches) {
    if (m.length < MIN_KEYWORD_LENGTH) continue;
    if (STOPWORDS.has(m)) continue;
    out.add(m);
  }
  return out;
}

function collectTrajectoryTools(trajectory: Trajectory): Set<string> {
  const tools = new Set<string>();
  for (const step of trajectory.steps) {
    if (step.type === 'tool_call' && step.toolCall) {
      tools.add(step.toolCall.name.toLowerCase());
    }
  }
  return tools;
}

/**
 * Concatenate all trajectory text (tool names, error messages, results,
 * deviation descriptions) into a single lowercase haystack for substring
 * matching by case symptoms.
 */
function collectTrajectoryHaystack(trajectory: Trajectory): string {
  const parts: string[] = [];
  for (const step of trajectory.steps) {
    if (step.type === 'tool_call' && step.toolCall) {
      parts.push(step.toolCall.name);
      if (step.toolCall.result) parts.push(step.toolCall.result);
      try {
        parts.push(JSON.stringify(step.toolCall.args));
      } catch {
        // ignore non-serializable args
      }
    }
    if (step.type === 'error' && step.error) {
      parts.push(step.error.message);
    }
  }
  for (const d of trajectory.deviations) {
    parts.push(d.description);
  }
  return parts.join(' ').toLowerCase();
}

function collectTrajectoryKeywords(trajectory: Trajectory): Set<string> {
  const keywords = new Set<string>();

  for (const step of trajectory.steps) {
    if (step.type === 'error' && step.error) {
      for (const k of tokenize(step.error.message)) keywords.add(k);
    }
    if (step.type === 'tool_call' && step.toolCall) {
      keywords.add(step.toolCall.name.toLowerCase());
      if (step.toolCall.result) {
        for (const k of tokenize(step.toolCall.result)) keywords.add(k);
      }
    }
  }

  for (const d of trajectory.deviations) {
    for (const k of tokenize(d.description)) keywords.add(k);
  }

  return keywords;
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const item of b) {
    if (a.has(item)) hits++;
  }
  return hits / b.size;
}
