// User permission rule syntax shared by the settings editor and the policy engine.
// One table and one Tool(pattern) shape, so a line the editor accepts is a line the engine can load.

import picomatch from 'picomatch';

/** Tools whose Tool(pattern) specifier is a command or a path. Every other tool is name-only. */
export const TOOL_SPECIFIER_TYPES: Record<string, 'command' | 'path'> = {
  Bash: 'command',
  Edit: 'path',
  Write: 'path',
  Read: 'path',
  Glob: 'path',
  Grep: 'path',
  ListDirectory: 'path',
};

/** `Tool(pattern)` with a non-empty pattern. The engine parser does not trim or fold case. */
export const TOOL_SPECIFIER_PATTERN = /^(\w+)\((.+)\)$/;

/** Picomatch options the engine uses for command and path specifiers. */
export const PERMISSION_RULE_GLOB_OPTIONS = { bash: true, dot: true } as const;

// ponytail: the probe set is finite, so an exotic glob that misses one probe passes.
// `!(zzz)` does not match `./a/b --c=/d` under these options, same as a lone `*`.
const BASH_ALLOW_ALL_PROBES = [
  'ls',
  'x',
  'rm -rf /',
  'cat /etc/passwd',
  './a/b --c=/d',
  'git status && echo /',
  'x'.repeat(300),
];

type UserPermissionRuleList = 'allow' | 'ask' | 'deny';

type UserPermissionRuleVerdict =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'malformed' | 'specifier_not_supported' | 'allow_all_bash' };

function isStarOnly(specifier: string): boolean {
  return specifier.length === 0 || /^\*+$/.test(specifier);
}

function matchesEveryBashProbe(specifier: string): boolean {
  return BASH_ALLOW_ALL_PROBES.every((probe) => (
    picomatch.isMatch(probe, specifier, PERMISSION_RULE_GLOB_OPTIONS)
  ));
}

/**
 * A rule is ok when it is non-empty after trim and is either a bare tool name
 * or `Tool(pattern)` whose tool actually takes a command or path specifier.
 * On the allow list, a rule equivalent to "allow every Bash command" is rejected.
 */
export function validateUserPermissionRule(
  rule: string,
  list: UserPermissionRuleList,
): UserPermissionRuleVerdict {
  const trimmed = rule.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };

  // MCP names are mcp__${serverName}__${tool.name} and keep '-' and '.' (mcpToolRegistry).
  if (/^[\w.-]+$/.test(trimmed)) {
    if (list === 'allow' && trimmed.toLowerCase() === 'bash') {
      return { ok: false, reason: 'allow_all_bash' };
    }
    return { ok: true };
  }

  const match = TOOL_SPECIFIER_PATTERN.exec(trimmed);
  if (!match) return { ok: false, reason: 'malformed' };

  const toolName = match[1];
  const specifier = match[2].trim();
  const specifierType = TOOL_SPECIFIER_TYPES[toolName];
  if (specifierType !== 'command' && specifierType !== 'path') {
    return { ok: false, reason: 'specifier_not_supported' };
  }

  if (list === 'allow' && toolName.toLowerCase() === 'bash'
    && (isStarOnly(specifier) || matchesEveryBashProbe(specifier))) {
    return { ok: false, reason: 'allow_all_bash' };
  }

  return { ok: true };
}

/** True when both lists are arrays holding the same strings in the same order. */
function sameRuleList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((rule, i) => rule === b[i]);
}

/**
 * Throw on the first invalid deny/ask/allow entry a rule edit introduces.
 * Callers must do this before persisting. A list identical to `previous` is
 * echoed storage, not a rule edit, and is skipped: legacy rules older builds
 * accepted must not block unrelated settings writes (e.g. toggling dev mode);
 * those rules are skipped with a warning at PolicyEngine load time instead.
 */
export function assertValidUserPermissionRules(
  permissions: { deny?: readonly string[]; ask?: readonly string[]; allow?: readonly string[] } | null | undefined,
  previous?: { deny?: readonly string[]; ask?: readonly string[]; allow?: readonly string[] } | null,
): void {
  if (!permissions) return;
  for (const list of ['deny', 'ask', 'allow'] as const) {
    const rules = permissions[list];
    if (!rules) continue;
    if (previous && sameRuleList(rules, previous[list])) continue;
    for (const rule of rules) {
      if (typeof rule !== 'string' || !validateUserPermissionRule(rule, list).ok) {
        throw new Error(`Invalid permission rule in ${list}: ${JSON.stringify(rule)}`);
      }
    }
  }
}
