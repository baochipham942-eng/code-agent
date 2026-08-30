// ============================================================================
// Environment Secret Filter (A8 — pre-emptive leak prevention)
//
// Strips variables whose NAMES look like secrets from the environment handed
// to Bash-tool-spawned child processes. This is a NEW layer ON TOP OF
// createSanitizedEnv (which only strips control characters from values):
// sanitize values first, then filter names.
//
// Scope: child processes spawned by the Bash tool ONLY. The agent process
// itself keeps its full process.env — it needs provider API keys to call
// models. Do NOT apply this filter to the agent's own env or to API calls.
//
// Complements the tool_result secret redaction (which masks secrets in output
// AFTER the fact): this filter prevents secrets from entering the child's
// environment in the first place, so `env`, `/proc/<pid>/environ`, crash
// dumps, and child-spawned grandchildren never see them.
//
// Configuration: [env_filter] section of code-agent-policy.toml
// (see code-agent-policy.example.toml and src/host/security/policyLoader.ts
// getEnvFilterPolicy). Fail-closed: the default policy strips.
// ============================================================================

/**
 * Secret name patterns, expressed as case-insensitive suffix globs.
 *
 * Case handling: matching is CASE-INSENSITIVE. Env var names are
 * case-insensitive on Windows, and secrets are only conventionally (not
 * reliably) uppercase on POSIX — `api_key` must be stripped just like
 * `API_KEY`.
 *
 * The core set is the A8 spec (`*_KEY` / `*_TOKEN` / `*_SECRET`) plus the
 * equally common `*_PASSWORD` / `*_PASSWD` / `_PWD` / `*_CREDENTIALS`
 * suffixes — cheap to add, same leak class.
 *
 * Deliberately NOT included (scope tight, avoid false positives):
 * `AUTH`/`CREDENTIAL` patterns without a suffix delimiter (`XAUTHORITY`,
 * `GIT_SSH_COMMAND` style vars must survive), and exact names like `PASSWORD`
 * (no leading underscore) that are plausible non-secret config.
 */
const SECRET_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /_PASSWD$/i,
  /_PWD$/i,
  /_CREDENTIALS$/i,
];

/**
 * Built-in core whitelist: variables that always survive even though their
 * name matches a secret pattern. INTENTIONALLY EMPTY — no common non-secret
 * variable matches the suffixes above (PATH/HOME/TERM/locale/shell plumbing
 * are all unaffected). If a legitimate workflow needs a matching variable,
 * use the policy escape hatch ([env_filter] allowed_secret_vars) instead of
 * widening this list.
 */
const CORE_ENV_WHITELIST: readonly string[] = [];

export interface SecretEnvFilterOptions {
  /** Extra names allowed through (user escape hatch), case-insensitive. */
  allowedNames?: readonly string[];
}

export interface SecretEnvFilterResult {
  /** Filtered environment (new object; input is not mutated). */
  env: Record<string, string>;
  /** Names that were stripped (values are never returned/logged). */
  strippedNames: string[];
}

/** True when `name` looks like a secret and is not whitelisted. */
function isSecretEnvName(name: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(name.toUpperCase())) return false;
  return SECRET_ENV_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Filter secret-looking variables out of a child-process environment.
 * Pure: returns a new env record; the input is not mutated.
 */
export function filterSecretEnvVars(
  env: Record<string, string>,
  options?: SecretEnvFilterOptions,
): SecretEnvFilterResult {
  const allowed = new Set<string>(
    [...CORE_ENV_WHITELIST, ...(options?.allowedNames ?? [])].map((name) => name.toUpperCase()),
  );

  const filtered: Record<string, string> = {};
  const strippedNames: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (isSecretEnvName(key, allowed)) {
      strippedNames.push(key);
      continue;
    }
    filtered[key] = value;
  }

  return { env: filtered, strippedNames };
}
