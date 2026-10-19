import {
  isForbiddenStructuralKey,
  normalizeKey,
  redactSecretText,
} from './conversationHistory';

// Neo's own runtime/session-management state — queues, leases, diffs, snapshots — that
// has no export meaning even when it isn't credential-shaped. This is a distinct concern
// from FORBIDDEN_STRUCTURAL_KEYS/MARKERS in conversationHistory.ts (which target
// credential- and filesystem-path-shaped keys in arbitrary user/tool data): a key here
// is forbidden because of *what it is* (process state), not *what it looks like*
// (a secret). isForbiddenPortableKey below checks both sets through one shared
// normalize+match so a key forbidden on one export channel is forbidden on the other.
export const FORBIDDEN_RUNTIME_KEYS = new Set([
  'absoluteWorktreePath', 'accountName', 'apiKey', 'approvalQueue', 'approvalRequests',
  'baseUrl', 'chatName', 'cwd', 'durableWaitingInput', 'executablePermission',
  'externalSessionId', 'filePath', 'lease', 'leaseId', 'logPath',
  'pendingApproval', 'pendingApprovals', 'permissionGrant', 'queuedInput',
  'queuedInputs', 'retryAttachments', 'runId', 'sourceRunId', 'streamSnapshot',
  'taskLease', 'todo', 'todos', 'turnDiff', 'workingDirectory',
]);

function isForbiddenPortableKey(key: string): boolean {
  if (isForbiddenStructuralKey(key)) return true;
  const normalized = normalizeKey(key);
  return [...FORBIDDEN_RUNTIME_KEYS].some((candidate) => normalized === normalizeKey(candidate));
}

export function sanitizePortableValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretText(value);
  if (Array.isArray(value)) return value.map(sanitizePortableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => item !== undefined && !isForbiddenPortableKey(key))
      .map(([key, item]) => [key, sanitizePortableValue(item)]),
  );
}

/** Schema spellings only. File_Path / File.Path normalize like the runtime key filePath. */
const EXACT_TOOL_PATH_KEYS = new Set(['path', 'file_path', 'notebook_path']);
const PATH_ARGUMENT_TOOLS = new Set([
  'read', 'readfile', 'edit', 'write', 'grep', 'glob', 'notebookedit',
]);

function keepsPathArguments(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return PATH_ARGUMENT_TOOLS.has(toolName.replace(/[^A-Za-z0-9]/g, '').toLowerCase());
}

function isNormalizedRuntimeIdentityKey(key: string): boolean {
  const normalized = normalizeKey(key);
  for (const candidate of FORBIDDEN_RUNTIME_KEYS) {
    if (normalized === normalizeKey(candidate)) return true;
  }
  return false;
}

/** toolCalls[].arguments keep every non-secret key. Credential-shaped keys are
 *  value-masked. file_path / path / notebook_path stay only for file tools.
 *  Other channels stay on sanitizePortableValue, which drops the key entirely. */
export function sanitizeToolArguments(value: unknown, toolName?: string): unknown {
  if (typeof value === 'string') return redactSecretText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeToolArguments(item, toolName));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    // Exact runtime-identity keys (apiKey, filePath, cwd, …) still cannot appear:
    // assertNoRuntimeIdentity rejects the key even when the value is redacted.
    if (FORBIDDEN_RUNTIME_KEYS.has(key)) continue;
    // File_Path / File.Path normalize to the same key as filePath, so they are
    // runtime identity too. Only the schema spellings stay, and only on file tools.
    if (isNormalizedRuntimeIdentityKey(key) && !EXACT_TOOL_PATH_KEYS.has(key)) continue;
    // Credential-shaped keys are masked before recursion, including objects and numbers.
    // api_key_path is not one of the schema path spellings, so it stays masked.
    if (isForbiddenPortableKey(key) && !(keepsPathArguments(toolName) && EXACT_TOOL_PATH_KEYS.has(key))) {
      result[key] = '[REDACTED]';
      continue;
    }
    if (item && typeof item === 'object') {
      result[key] = sanitizeToolArguments(item, toolName);
      continue;
    }
    result[key] = typeof item === 'string' ? redactSecretText(item) : item;
  }
  return result;
}
