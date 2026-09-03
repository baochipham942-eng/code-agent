// ============================================================================
// Eval-only tool-name aliases (match-time widen, never rewrite traces)
// ============================================================================
// Why a new module, not assertionEngine.ts:58:
//   forbiddenCallEval and userSimulator also need the same matcher. Putting
//   the table next to toolMatches inside assertionEngine would create
//   assertionEngine ↔ forbiddenCallEval / userSimulator cycles.
// Why not src/host/tools/toolNames.ts:
//   that helper is deliberately narrow (7 production call sites). Cross-CLI
//   eval aliases must not leak into permission / executor policy.
// Matching is "original regex hits OR canonical names are equal". The recorded
// toolExecutions[].tool string is never rewritten.

/**
 * Keys are lowercase names with `_` / `-` / whitespace stripped.
 * Values are the eval-side canonical token (also stripped).
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  readfile: 'read',
  writefile: 'write',
  editfile: 'edit',
  todo: 'todowrite',
  // External CLI shells collapse onto bash so `bash|list_directory|glob` and
  // `^Bash$` both see Codex / Grok traces. Grok's output-poller is NOT a shell.
  execcommand: 'bash',
  runterminalcommand: 'bash',
  shell: 'bash',
  searchreplace: 'edit',
};

const SHELL_TOOL_PATTERN = /^(?:(?:power)?shell|bash|terminal)(?:$|[_ -])/i;

function normalizeEvalToolName(name: string): string {
  const key = name.toLowerCase().replace(/[_\-\s]/g, '');
  return TOOL_NAME_ALIASES[key] ?? key;
}

function patternAltKey(alt: string): string {
  return normalizeEvalToolName(alt.replace(/^\^/, '').replace(/\$$/, ''));
}

/**
 * Match-time widen: original case-insensitive regex against the raw tool
 * name, then the same regex against the canonical name, then `|`-split
 * canonical equality (anchors stripped). Never replaces the raw name.
 */
export function toolMatches(actualTool: string, expectPattern: string): boolean {
  const actualKey = normalizeEvalToolName(actualTool);
  try {
    const re = new RegExp(expectPattern, 'i');
    if (re.test(actualTool)) return true;
    if (re.test(actualKey)) return true;
  } catch {
    // expectPattern 不是合法正则时忽略，落到下面的别名比较
  }
  return expectPattern.split('|').some((alt) => patternAltKey(alt) === actualKey);
}

export function isShellEvalTool(tool: string): boolean {
  if (SHELL_TOOL_PATTERN.test(tool)) return true;
  const canonical = normalizeEvalToolName(tool);
  return canonical === 'bash' || SHELL_TOOL_PATTERN.test(canonical);
}
