import { createHash } from 'node:crypto';

/**
 * Snapshot helpers for folder trust. A stored entry is kind, path, and when
 * the item has a content digest, the sha256 hex, separated by NUL.
 * Hook commands and MCP env values are hash inputs only. They are not fields
 * on the item or in the snapshot.
 */

interface DigestItem {
  kind: string;
  path: string;
  gated: boolean;
  contentDigest?: string;
}

interface HookDigestEntry {
  event: string;
  matcher: string;
  type: string;
  command: string;
  timeout: number | null;
}

interface McpDigestEntry {
  name: string;
  command: string;
  args: unknown;
  env: unknown;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = stableValue(value[key]);
  return sorted;
}

/**
 * Canonical hook entry. `command` is the command string only; prompt, url,
 * and agent text are not part of this tuple. Adding or removing an entry
 * still changes the hashed list.
 */
function normalizeHook(event: string, matcher: string, hook: unknown): HookDigestEntry {
  if (!isRecord(hook)) {
    return { event, matcher, type: '', command: '', timeout: null };
  }
  const timeout = hook.timeout;
  return {
    event,
    matcher,
    type: typeof hook.type === 'string' ? hook.type : '',
    command: typeof hook.command === 'string' ? hook.command : '',
    timeout: typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : null,
  };
}

function hookSortKey(entry: HookDigestEntry): string {
  return JSON.stringify([entry.event, entry.matcher, entry.type, entry.command, entry.timeout]);
}

function hookContentDigest(text: string, legacy: boolean): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return sha256Hex(text);
  }
  const config = legacy ? (isRecord(parsed) ? parsed.hooks : undefined) : parsed;
  // Not an object we can normalize. Hash the raw text so any edit re-asks.
  if (!isRecord(config)) return sha256Hex(text);
  const entries: HookDigestEntry[] = [];
  for (const [event, matchers] of Object.entries(config)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (!isRecord(matcher) || !Array.isArray(matcher.hooks)) continue;
      const matcherName = typeof matcher.matcher === 'string' ? matcher.matcher : '';
      for (const hook of matcher.hooks) entries.push(normalizeHook(event, matcherName, hook));
    }
  }
  entries.sort((left, right) => compareStrings(hookSortKey(left), hookSortKey(right)));
  return sha256Hex(JSON.stringify(entries));
}

function normalizeStdioServer(entry: unknown, name: string): McpDigestEntry | undefined {
  if (!isRecord(entry)) return undefined;
  // Same predicate as countStdioMcpServers: a command means this process runs locally.
  if (typeof entry.command !== 'string' || entry.command.length === 0) return undefined;
  return {
    name,
    command: entry.command,
    args: entry.args === undefined ? [] : stableValue(entry.args),
    env: entry.env === undefined ? {} : stableValue(entry.env),
  };
}

function mcpStdioContentDigest(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return sha256Hex(text);
  }
  if (!isRecord(parsed)) return sha256Hex(text);
  const entries: McpDigestEntry[] = [];
  if (Array.isArray(parsed.servers)) {
    for (const entry of parsed.servers) {
      const name = isRecord(entry) && typeof entry.name === 'string' ? entry.name : '';
      const normalized = normalizeStdioServer(entry, name);
      if (normalized) entries.push(normalized);
    }
  }
  if (isRecord(parsed.mcpServers)) {
    for (const [name, entry] of Object.entries(parsed.mcpServers)) {
      const normalized = normalizeStdioServer(entry, name);
      if (normalized) entries.push(normalized);
    }
  }
  // HTTP/SSE-only files are not gated and get no digest.
  if (entries.length === 0) return undefined;
  entries.sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)));
  return sha256Hex(JSON.stringify(entries));
}

/** Shared by the sync and async discovery paths. Hooks always hash; MCP only when stdio or unparseable. */
export function discoveredItemContentDigest(
  kind: 'project-hooks' | 'project-mcp' | 'project-mcp-local',
  text: string,
  legacyHooks = false,
): string | undefined {
  if (kind === 'project-hooks') return hookContentDigest(text, legacyHooks);
  return mcpStdioContentDigest(text);
}

function snapshotKey(item: DigestItem): string {
  const legacyKey = `${item.kind}\0${item.path}`;
  return item.contentDigest ? `${legacyKey}\0${item.contentDigest}` : legacyKey;
}

export function gatedDigestOf(items: readonly DigestItem[]): string {
  return JSON.stringify(items.filter((item) => item.gated).map(snapshotKey).sort());
}

function hasThreePartEntry(knownKeys: ReadonlySet<string>, legacyKey: string): boolean {
  const prefix = `${legacyKey}\0`;
  for (const key of knownKeys) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

export function hasNewGatedItems(
  storedDigest: string | null | undefined,
  items: readonly DigestItem[],
): boolean {
  if (!storedDigest) return false; // 本次改动之前落的决定没有快照：不追溯，避免升级后集体重问
  let known: unknown;
  try {
    known = JSON.parse(storedDigest);
  } catch {
    return false;
  }
  if (!Array.isArray(known)) return false;
  const knownKeys = new Set(known.filter((entry): entry is string => typeof entry === 'string'));
  return items.some((item) => {
    if (!item.gated) return false;
    const legacyKey = `${item.kind}\0${item.path}`;
    const fullKey = item.contentDigest ? `${legacyKey}\0${item.contentDigest}` : legacyKey;
    // Digest comparison: fullKey includes contentDigest, so a command or env edit is a new key.
    if (knownKeys.has(fullKey)) return false;
    // A pre-digest snapshot stored only kind+path. That 2-part hit stays known
    // until an explicit trust decision writes the 3-part form. Once any 3-part
    // entry exists for the same kind+path, only the full key matches.
    if (item.contentDigest && knownKeys.has(legacyKey) && !hasThreePartEntry(knownKeys, legacyKey)) {
      return false;
    }
    return true;
  });
}
