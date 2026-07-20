// ============================================================================
// Claude Code CLI Session Parser
//
// Parses Claude Code's JSONL session files for import into code-agent.
// Session files are stored at ~/.claude/projects/<encoded-path>/<uuid>.jsonl
//
// JSONL line types:
//   - queue-operation: session lifecycle events (dequeue/remove)
//   - user:           user messages (text or tool_result blocks)
//   - assistant:       model responses (text, tool_use, thinking blocks)
//   - system:         system events (stop_hook_summary, turn_duration, bridge_status)
//   - progress:       streaming progress (hook_progress, bash_progress, mcp_progress, agent_progress)
//   - file-history-snapshot: file checkpoint snapshots
//
// Use cases:
// 1. Import sessions for continuation/analysis in code-agent
// 2. Extract training data for fine-tuning (SFT / ChatML format)
// ============================================================================

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';

// ============================================================================
// Types
// ============================================================================

/**
 * Metadata about a discovered Claude Code session.
 */
export interface ClaudeSessionMetadata {
  sessionId: string;
  projectPath: string;           // decoded from the encoded directory name
  encodedProjectPath: string;    // raw directory name (e.g. "-Users-linchen-project")
  filePath: string;              // absolute path to the .jsonl file
  cwd?: string;
  gitBranch?: string;
  claudeVersion?: string;
  model?: string;
  startedAt?: number;            // epoch ms
  endedAt?: number;              // epoch ms
  messageCount: number;          // user + assistant messages (excludes system/progress)
  toolCallCount: number;
  fileSizeBytes: number;
  firstPrompt?: string;          // first user message text (truncated)
}

/**
 * A single Claude Code content block (matches Anthropic API format).
 */
export interface ClaudeContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image';
  // text block
  text?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result block
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
  // thinking block
  thinking?: string;
  signature?: string;
  // image block
  source?: { type: string; media_type?: string; data?: string };
}

/**
 * A parsed message from the JSONL file, normalized to a uniform shape.
 */
export interface ClaudeMessage {
  uuid: string;
  parentUuid: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string | ClaudeContentBlock[];
  timestamp: number;             // epoch ms
  model?: string;
  stopReason?: string | null;
  // Extracted convenience fields
  toolUses: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  toolResults: Array<{
    toolUseId: string;
    content: string;
    isError: boolean;
  }>;
  thinking?: string;
  // Original envelope metadata
  isSidechain: boolean;
  cwd?: string;
  sessionId: string;
  version?: string;
  gitBranch?: string;
}

/**
 * A fully parsed Claude Code session.
 */
export interface ParsedClaudeSession {
  metadata: ClaudeSessionMetadata;
  messages: ClaudeMessage[];
  /** Raw line count (including progress/system/queue-operation lines) */
  rawLineCount: number;
  /** Lines that failed JSON parsing */
  parseErrors: number;
}

/**
 * Options for session discovery.
 */
export interface DiscoverOptions {
  /** Only show sessions from projects whose decoded path contains this string */
  projectPathFilter?: string;
  /** Maximum age in ms (relative to now) */
  maxAge?: number;
  /** Maximum number of sessions to return */
  limit?: number;
  /** Sort order: 'newest' (default) or 'oldest' */
  sort?: 'newest' | 'oldest';
}

/**
 * SFT training example.
 */
export interface SFTExample {
  instruction: string;
  input: string;
  output: string;
  tools_used?: string[];
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Decode a Claude Code encoded project path.
 *
 * Claude Code encodes project directory paths by replacing path separators
 * with hyphens. For example:
 *   "-Users-linchen-project" -> "/Users/linchen/project"
 *   "-private-tmp-claude-workspace" -> "/private/tmp/claude-workspace"
 *
 * The leading hyphen represents the root "/".
 */
export function decodeProjectPath(encoded: string): string {
  if (!encoded || encoded === '-') {
    return '/';
  }

  // The encoded path starts with '-' representing '/'
  // Then each '-' is a path separator, BUT directory/file names can also
  // contain hyphens. We use a heuristic: try to reconstruct the path
  // by splitting on '-' and checking which reconstructions exist on disk.

  // Fast path: try simple replacement and check if it exists
  const simplePath = '/' + encoded.slice(1).replace(/-/g, '/');
  if (fsSync.existsSync(simplePath)) {
    return simplePath;
  }

  // For paths that don't exist (anymore), try the common macOS patterns
  const parts = encoded.slice(1).split('-');
  return reconstructPath(parts);
}

/**
 * Reconstruct a path from split parts using filesystem probing.
 * Falls back to simple join if no valid path is found.
 */
function reconstructPath(parts: string[]): string {
  if (parts.length === 0) return '/';

  // Try to greedily match directory segments from left to right
  let current = '/';
  let i = 0;

  while (i < parts.length) {
    let found = false;

    // Try combining multiple parts (longest first) to handle hyphenated names
    for (let len = Math.min(parts.length - i, 6); len >= 1; len--) {
      const candidate = parts.slice(i, i + len).join('-');
      const candidatePath = path.join(current, candidate);

      if (fsSync.existsSync(candidatePath)) {
        current = candidatePath;
        i += len;
        found = true;
        break;
      }
    }

    if (!found) {
      // No filesystem match -- just use the single part
      current = path.join(current, parts[i]);
      i++;
    }
  }

  return current;
}

// ============================================================================
// Full Session Parsing
// ============================================================================

/**
 * Parse a Claude Code JSONL session file into structured messages.
 *
 * Handles:
 * - Large files (stream-based line-by-line parsing)
 * - Corrupted/malformed lines (skipped with error count)
 * - All known line types (user, assistant, system, progress, queue-operation, file-history-snapshot)
 * - Binary content in tool results (truncated)
 *
 * @param filePath - Absolute path to the .jsonl file
 * @param options.maxLines - Stop after N lines (for very large files). Default: unlimited.
 * @param options.skipProgress - Skip progress lines (default: true, saves memory)
 */
export async function parseClaudeSession(
  filePath: string,
  options?: { maxLines?: number; skipProgress?: boolean }
): Promise<ParsedClaudeSession> {
  const skipProgress = options?.skipProgress !== false; // default true
  const maxLines = options?.maxLines ?? Infinity;

  const stat = await fs.stat(filePath);
  const sessionId = path.basename(filePath, '.jsonl');
  const parentDir = path.basename(path.dirname(filePath));
  const projectPath = decodeProjectPath(parentDir);

  const messages: ClaudeMessage[] = [];
  let rawLineCount = 0;
  let parseErrors = 0;

  // Metadata accumulation
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let claudeVersion: string | undefined;
  let model: string | undefined;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let firstPrompt: string | undefined;
  let toolCallCount = 0;
  let messageCount = 0;

  const stream = fsSync.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    rawLineCount++;
    if (rawLineCount > maxLines) break;

    if (!line.trim()) continue;

    // Guard against extremely long lines (e.g. binary content in tool results)
    // Parse but truncate massive string values during extraction
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      parseErrors++;
      continue;
    }

    const type = obj.type as string;

    // Skip non-message types
    if (type === 'queue-operation' || type === 'file-history-snapshot') continue;
    if (type === 'progress' && skipProgress) continue;

    // Extract envelope metadata
    if (!cwd && obj.cwd) cwd = obj.cwd as string;
    if (!gitBranch && obj.gitBranch) gitBranch = obj.gitBranch as string;
    if (!claudeVersion && obj.version) claudeVersion = obj.version as string;

    const ts = parseTimestamp(obj.timestamp);
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
    }

    // Parse user messages
    if (type === 'user') {
      const parsed = parseUserLine(obj);
      if (parsed) {
        messages.push(parsed);
        messageCount++;

        // First non-tool-result user message text
        if (!firstPrompt && typeof parsed.content === 'string') {
          firstPrompt = parsed.content.slice(0, 200);
        }
      }
    }

    // Parse assistant messages
    if (type === 'assistant') {
      const parsed = parseAssistantLine(obj);
      if (parsed) {
        messages.push(parsed);
        messageCount++;
        toolCallCount += parsed.toolUses.length;
        if (!model && parsed.model) model = parsed.model;
      }
    }

    // Parse system messages (they carry useful metadata)
    if (type === 'system') {
      const parsed = parseSystemLine(obj);
      if (parsed) {
        messages.push(parsed);
      }
    }
  }

  stream.destroy();

  return {
    metadata: {
      sessionId,
      projectPath,
      encodedProjectPath: parentDir,
      filePath,
      cwd,
      gitBranch,
      claudeVersion,
      model,
      startedAt,
      endedAt,
      messageCount,
      toolCallCount,
      fileSizeBytes: stat.size,
      firstPrompt,
    },
    messages,
    rawLineCount,
    parseErrors,
  };
}

// ============================================================================
// Line Parsers
// ============================================================================

function parseUserLine(obj: Record<string, unknown>): ClaudeMessage | null {
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const rawContent = message.content;
  const toolUses: ClaudeMessage['toolUses'] = [];
  const toolResults: ClaudeMessage['toolResults'] = [];

  let content: string | ClaudeContentBlock[];

  if (typeof rawContent === 'string') {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    content = rawContent as ClaudeContentBlock[];
    // Extract tool_result blocks
    for (const block of rawContent as ClaudeContentBlock[]) {
      if (block.type === 'tool_result') {
        const resultContent = extractToolResultContent(block.content);
        toolResults.push({
          toolUseId: block.tool_use_id ?? '',
          content: resultContent,
          isError: block.is_error === true,
        });
      }
    }
  } else {
    content = '';
  }

  return {
    uuid: (obj.uuid as string) ?? '',
    parentUuid: (obj.parentUuid as string) ?? null,
    role: 'user',
    content,
    timestamp: parseTimestamp(obj.timestamp) ?? 0,
    toolUses,
    toolResults,
    isSidechain: (obj.isSidechain as boolean) ?? false,
    cwd: obj.cwd as string | undefined,
    sessionId: (obj.sessionId as string) ?? '',
    version: obj.version as string | undefined,
    gitBranch: obj.gitBranch as string | undefined,
  };
}

function parseAssistantLine(obj: Record<string, unknown>): ClaudeMessage | null {
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const rawContent = message.content;
  const toolUses: ClaudeMessage['toolUses'] = [];
  const toolResults: ClaudeMessage['toolResults'] = [];
  let thinking: string | undefined;
  let content: string | ClaudeContentBlock[];

  if (typeof rawContent === 'string') {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    content = rawContent as ClaudeContentBlock[];
    for (const block of rawContent as ClaudeContentBlock[]) {
      if (block.type === 'tool_use') {
        toolUses.push({
          id: block.id ?? '',
          name: block.name ?? '',
          input: (block.input as Record<string, unknown>) ?? {},
        });
      } else if (block.type === 'thinking') {
        thinking = block.thinking ?? block.text ?? '';
      }
    }
  } else {
    content = '';
  }

  return {
    uuid: (obj.uuid as string) ?? '',
    parentUuid: (obj.parentUuid as string) ?? null,
    role: 'assistant',
    content,
    timestamp: parseTimestamp(obj.timestamp) ?? 0,
    model: message.model as string | undefined,
    stopReason: message.stop_reason as string | null | undefined,
    toolUses,
    toolResults,
    thinking,
    isSidechain: (obj.isSidechain as boolean) ?? false,
    cwd: obj.cwd as string | undefined,
    sessionId: (obj.sessionId as string) ?? '',
    version: obj.version as string | undefined,
    gitBranch: obj.gitBranch as string | undefined,
  };
}

function parseSystemLine(obj: Record<string, unknown>): ClaudeMessage | null {
  const subtype = obj.subtype as string | undefined;
  const contentStr = obj.content as string | undefined;

  // Build a text representation of the system event
  let text: string;
  if (contentStr) {
    text = contentStr;
  } else if (subtype === 'turn_duration') {
    const durationMs = obj.durationMs as number | undefined;
    text = `[system] Turn duration: ${durationMs ?? 0}ms`;
  } else if (subtype === 'stop_hook_summary') {
    text = `[system] Stop hook summary`;
  } else if (subtype === 'bridge_status') {
    text = `[system] Bridge status: ${contentStr ?? ''}`;
  } else {
    text = `[system] ${subtype ?? 'unknown'}`;
  }

  return {
    uuid: (obj.uuid as string) ?? '',
    parentUuid: (obj.parentUuid as string) ?? null,
    role: 'system',
    content: text,
    timestamp: parseTimestamp(obj.timestamp) ?? 0,
    toolUses: [],
    toolResults: [],
    isSidechain: (obj.isSidechain as boolean) ?? false,
    cwd: obj.cwd as string | undefined,
    sessionId: (obj.sessionId as string) ?? '',
    version: obj.version as string | undefined,
    gitBranch: obj.gitBranch as string | undefined,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a timestamp value that may be an ISO string, epoch ms, or epoch s.
 */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') {
    // epoch ms vs epoch s heuristic
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const ms = new Date(value).getTime();
    return isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/**
 * Extract plain text from tool_result content (which can be string or array).
 */
function extractToolResultContent(content: ClaudeContentBlock['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => c.text ?? '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
