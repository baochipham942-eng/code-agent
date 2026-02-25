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
import os from 'os';
import readline from 'readline';
import type { Message } from '../../shared/types/message';

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
 * Get the Claude Code projects root directory.
 * Defaults to ~/.claude/projects/
 */
function getClaudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

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

/**
 * Encode a project path to Claude Code's directory name format.
 * Inverse of decodeProjectPath.
 */
export function encodeProjectPath(projectPath: string): string {
  // Replace all path separators with hyphens
  return projectPath.replace(/\//g, '-');
}

// ============================================================================
// Session Discovery
// ============================================================================

/**
 * Scan ~/.claude/projects/ for available Claude Code sessions.
 *
 * Returns metadata for each discovered session, sorted by modification time.
 * Does NOT parse message content -- only reads file stats and the first few
 * lines to extract metadata.
 */
export async function discoverClaudeSessions(
  options?: DiscoverOptions
): Promise<ClaudeSessionMetadata[]> {
  const root = getClaudeProjectsRoot();
  const results: ClaudeSessionMetadata[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(root);
  } catch {
    return []; // ~/.claude/projects/ doesn't exist
  }

  for (const encodedDir of projectDirs) {
    const dirPath = path.join(root, encodedDir);
    const dirStat = await fs.stat(dirPath).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    // Decode project path
    const projectPath = decodeProjectPath(encodedDir);

    // Apply project filter
    if (options?.projectPathFilter) {
      if (!projectPath.includes(options.projectPathFilter)) continue;
    }

    // List .jsonl files in this project directory
    const files = await fs.readdir(dirPath).catch(() => [] as string[]);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

    for (const jsonlFile of jsonlFiles) {
      const filePath = path.join(dirPath, jsonlFile);
      const sessionId = jsonlFile.replace('.jsonl', '');

      try {
        const stat = await fs.stat(filePath);

        // Apply age filter
        if (options?.maxAge) {
          const age = Date.now() - stat.mtimeMs;
          if (age > options.maxAge) continue;
        }

        // Quick-scan first lines for metadata
        const meta = await quickScanMetadata(filePath, sessionId, projectPath, encodedDir, stat.size);
        results.push(meta);
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Sort
  const sortNewest = !options?.sort || options.sort === 'newest';
  results.sort((a, b) => {
    const ta = a.startedAt ?? 0;
    const tb = b.startedAt ?? 0;
    return sortNewest ? tb - ta : ta - tb;
  });

  // Apply limit
  if (options?.limit && options.limit > 0) {
    return results.slice(0, options.limit);
  }

  return results;
}

/**
 * Quick-scan a JSONL file to extract metadata without parsing all messages.
 * Reads only the first ~20 lines and the file size.
 */
async function quickScanMetadata(
  filePath: string,
  sessionId: string,
  projectPath: string,
  encodedProjectPath: string,
  fileSizeBytes: number,
): Promise<ClaudeSessionMetadata> {
  const meta: ClaudeSessionMetadata = {
    sessionId,
    projectPath,
    encodedProjectPath,
    filePath,
    messageCount: 0,
    toolCallCount: 0,
    fileSizeBytes,
  };

  const stream = fsSync.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineCount = 0;
  let firstUserSeen = false;

  for await (const line of rl) {
    if (lineCount > 50) break; // Only scan first 50 lines for metadata
    lineCount++;

    if (!line.trim()) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = obj.type as string;

    // Extract metadata from any message envelope
    if (!meta.cwd && obj.cwd) meta.cwd = obj.cwd as string;
    if (!meta.gitBranch && obj.gitBranch) meta.gitBranch = obj.gitBranch as string;
    if (!meta.claudeVersion && obj.version) meta.claudeVersion = obj.version as string;

    // Extract timestamp
    const ts = parseTimestamp(obj.timestamp);
    if (ts && (!meta.startedAt || ts < meta.startedAt)) {
      meta.startedAt = ts;
    }

    if (type === 'user' && !firstUserSeen) {
      const message = obj.message as Record<string, unknown> | undefined;
      if (message) {
        const content = message.content;
        if (typeof content === 'string' && !obj.toolUseResult) {
          meta.firstPrompt = content.slice(0, 200);
          firstUserSeen = true;
        }
      }
      meta.messageCount++;
    } else if (type === 'assistant') {
      const message = obj.message as Record<string, unknown> | undefined;
      if (message) {
        if (!meta.model && message.model) {
          meta.model = message.model as string;
        }
        // Count tool_use blocks
        const content = message.content as ClaudeContentBlock[] | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') meta.toolCallCount++;
          }
        }
      }
      meta.messageCount++;
    }
  }

  stream.destroy();
  return meta;
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
// Conversion: Claude Session -> code-agent Message[]
// ============================================================================

/**
 * Convert a parsed Claude session to code-agent's Message[] format.
 *
 * This merges consecutive assistant lines (which Claude Code writes as
 * separate JSONL entries for each content block) into single messages,
 * and maps tool_use/tool_result to ToolCall/ToolResult.
 */
export function toCodeAgentMessages(session: ParsedClaudeSession): Message[] {
  const result: Message[] = [];
  const msgs = session.messages.filter(m => m.role !== 'system');

  // Claude Code writes each content block as a separate JSONL line for
  // streaming. We need to merge consecutive assistant lines that belong
  // to the same API response (same parentUuid chain or same requestId).
  const merged = mergeConsecutiveAssistant(msgs);

  for (const msg of merged) {
    if (msg.role === 'user') {
      // User message: either plain text or tool results
      if (msg.toolResults.length > 0) {
        // This is a tool result message
        result.push({
          id: msg.uuid,
          role: 'tool',
          content: msg.toolResults.map(tr => {
            if (tr.isError) return `Error: ${tr.content}`;
            return tr.content;
          }).join('\n'),
          timestamp: msg.timestamp,
          toolResults: msg.toolResults.map(tr => ({
            toolCallId: tr.toolUseId,
            success: !tr.isError,
            output: tr.isError ? undefined : tr.content,
            error: tr.isError ? tr.content : undefined,
          })),
        });
      } else {
        // Plain user message
        const text = typeof msg.content === 'string'
          ? msg.content
          : extractTextFromBlocks(msg.content);
        result.push({
          id: msg.uuid,
          role: 'user',
          content: text,
          timestamp: msg.timestamp,
        });
      }
    } else if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : extractTextFromBlocks(msg.content);

      const toolCalls = msg.toolUses.length > 0
        ? msg.toolUses.map(tu => ({
            id: tu.id,
            name: tu.name,
            arguments: tu.input,
          }))
        : undefined;

      result.push({
        id: msg.uuid,
        role: 'assistant',
        content: text,
        timestamp: msg.timestamp,
        toolCalls,
        thinking: msg.thinking,
      });
    }
  }

  return result;
}

/**
 * Merge consecutive assistant messages that are part of the same response.
 *
 * Claude Code writes streaming responses as separate JSONL lines:
 *   assistant: [text] "Let me read..."
 *   assistant: [tool_use] Read(...)
 *
 * We merge these into a single ClaudeMessage with combined content.
 */
function mergeConsecutiveAssistant(messages: ClaudeMessage[]): ClaudeMessage[] {
  const result: ClaudeMessage[] = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role !== 'assistant') {
      result.push(msg);
      i++;
      continue;
    }

    // Collect consecutive assistant messages
    const group: ClaudeMessage[] = [msg];
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'assistant') {
      group.push(messages[j]);
      j++;
    }

    // Merge the group
    if (group.length === 1) {
      result.push(msg);
    } else {
      const merged = mergeAssistantGroup(group);
      result.push(merged);
    }

    i = j;
  }

  return result;
}

function mergeAssistantGroup(group: ClaudeMessage[]): ClaudeMessage {
  const first = group[0];
  const allToolUses: ClaudeMessage['toolUses'] = [];
  const allBlocks: ClaudeContentBlock[] = [];
  let thinking: string | undefined;

  for (const msg of group) {
    allToolUses.push(...msg.toolUses);
    if (msg.thinking) thinking = msg.thinking;

    if (Array.isArray(msg.content)) {
      allBlocks.push(...msg.content);
    } else if (typeof msg.content === 'string' && msg.content) {
      allBlocks.push({ type: 'text', text: msg.content });
    }
  }

  const last = group[group.length - 1];

  return {
    ...first,
    content: allBlocks,
    toolUses: allToolUses,
    thinking,
    stopReason: last.stopReason ?? first.stopReason,
    timestamp: first.timestamp,
  };
}

// ============================================================================
// Conversion: Claude Session -> SFT Training Data
// ============================================================================

/**
 * Export a parsed Claude session as SFT training examples.
 *
 * Each user turn + assistant response pair becomes one training example.
 * Tool use sequences (user -> assistant[tool_use] -> user[tool_result] -> assistant)
 * are flattened into a single output string that includes the full interaction.
 *
 * Format:
 * {
 *   instruction: system prompt / context description,
 *   input: user message,
 *   output: full assistant response (including tool use if applicable),
 *   tools_used: ["Read", "Bash", ...]
 * }
 */
export function toSFTFormat(session: ParsedClaudeSession): SFTExample[] {
  const examples: SFTExample[] = [];
  const msgs = session.messages.filter(m => m.role !== 'system');
  const merged = mergeConsecutiveAssistant(msgs);

  // Build system instruction from session metadata
  const instruction = buildSFTInstruction(session.metadata);

  // Walk through messages, pairing user inputs with assistant outputs
  let i = 0;
  while (i < merged.length) {
    const msg = merged[i];

    if (msg.role === 'user' && msg.toolResults.length === 0) {
      // This is a real user input
      const userText = typeof msg.content === 'string'
        ? msg.content
        : extractTextFromBlocks(msg.content);

      // Collect all assistant responses until the next real user message
      const outputParts: string[] = [];
      const toolsUsed: Set<string> = new Set();
      let j = i + 1;

      while (j < merged.length) {
        const next = merged[j];
        if (next.role === 'user' && next.toolResults.length === 0) {
          break; // Next real user message
        }

        if (next.role === 'assistant') {
          const text = typeof next.content === 'string'
            ? next.content
            : formatAssistantBlocks(next.content);
          if (text.trim()) outputParts.push(text);
          for (const tu of next.toolUses) {
            toolsUsed.add(tu.name);
          }
        } else if (next.role === 'user' && next.toolResults.length > 0) {
          // Tool result -- include as context in the output
          for (const tr of next.toolResults) {
            const prefix = tr.isError ? '[Tool Error]' : '[Tool Result]';
            const truncated = tr.content.length > 2000
              ? tr.content.slice(0, 2000) + '... (truncated)'
              : tr.content;
            outputParts.push(`${prefix} ${truncated}`);
          }
        }

        j++;
      }

      if (outputParts.length > 0) {
        examples.push({
          instruction,
          input: userText,
          output: outputParts.join('\n\n'),
          tools_used: toolsUsed.size > 0 ? [...toolsUsed] : undefined,
        });
      }

      i = j;
    } else {
      i++;
    }
  }

  return examples;
}

function buildSFTInstruction(meta: ClaudeSessionMetadata): string {
  const parts = [
    'You are an AI coding assistant with access to file system, shell, and web tools.',
    'You help users with software development tasks.',
  ];
  if (meta.cwd) parts.push(`Working directory: ${meta.cwd}`);
  if (meta.gitBranch) parts.push(`Git branch: ${meta.gitBranch}`);
  return parts.join(' ');
}

// ============================================================================
// Conversion: Claude Session -> ChatML Format
// ============================================================================

/**
 * Export a parsed Claude session as ChatML format for chat model fine-tuning.
 *
 * Produces an array of {role, content} messages suitable for OpenAI/Anthropic
 * fine-tuning APIs. Tool use is inlined as text within assistant messages.
 * Tool results are inlined as text within user messages.
 */
export function toChatMLFormat(
  session: ParsedClaudeSession
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const result: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  const msgs = session.messages.filter(m => m.role !== 'system');
  const merged = mergeConsecutiveAssistant(msgs);

  // Add system message
  result.push({
    role: 'system',
    content: buildSFTInstruction(session.metadata),
  });

  // Walk through merged messages
  for (const msg of merged) {
    if (msg.role === 'user') {
      if (msg.toolResults.length > 0) {
        // Tool results -> inline as user message with tool_result markers
        const parts = msg.toolResults.map(tr => {
          const prefix = tr.isError ? 'Error' : 'Result';
          const truncated = tr.content.length > 4000
            ? tr.content.slice(0, 4000) + '... (truncated)'
            : tr.content;
          return `[Tool ${prefix} for ${tr.toolUseId}]: ${truncated}`;
        });
        result.push({ role: 'user', content: parts.join('\n') });
      } else {
        const text = typeof msg.content === 'string'
          ? msg.content
          : extractTextFromBlocks(msg.content);
        if (text.trim()) {
          result.push({ role: 'user', content: text });
        }
      }
    } else if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : formatAssistantBlocks(msg.content);
      if (text.trim()) {
        result.push({ role: 'assistant', content: text });
      }
    }
  }

  // Merge consecutive same-role messages (can happen after filtering)
  return mergeConsecutiveChatML(result);
}

function mergeConsecutiveChatML(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  if (messages.length <= 1) return messages;

  const result: typeof messages = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];
    if (prev.role === curr.role) {
      prev.content += '\n\n' + curr.content;
    } else {
      result.push(curr);
    }
  }
  return result;
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

/**
 * Extract plain text from an array of content blocks.
 */
function extractTextFromBlocks(blocks: ClaudeContentBlock[]): string {
  return blocks
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .filter(Boolean)
    .join('\n');
}

/**
 * Format assistant content blocks as human-readable text (for SFT output).
 * Includes tool_use blocks as formatted text.
 */
function formatAssistantBlocks(blocks: ClaudeContentBlock[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      const inputStr = JSON.stringify(block.input ?? {}, null, 2);
      // Truncate large tool inputs (e.g. file writes)
      const truncatedInput = inputStr.length > 3000
        ? inputStr.slice(0, 3000) + '\n... (truncated)'
        : inputStr;
      parts.push(`[Tool: ${block.name}]\n${truncatedInput}`);
    } else if (block.type === 'thinking' && block.thinking) {
      parts.push(`[Thinking]\n${block.thinking}`);
    }
  }

  return parts.join('\n\n');
}

// ============================================================================
// Convenience: Parse from session ID
// ============================================================================

/**
 * Find and parse a session by its UUID.
 * Searches all project directories under ~/.claude/projects/.
 */
export async function parseSessionById(sessionId: string): Promise<ParsedClaudeSession | null> {
  const root = getClaudeProjectsRoot();

  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(root);
  } catch {
    return null;
  }

  for (const encodedDir of projectDirs) {
    const filePath = path.join(root, encodedDir, `${sessionId}.jsonl`);
    try {
      await fs.access(filePath);
      return parseClaudeSession(filePath);
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Get a brief summary of a parsed session for display purposes.
 */
export function formatSessionSummary(meta: ClaudeSessionMetadata): string {
  const lines: string[] = [];
  lines.push(`Session: ${meta.sessionId}`);
  lines.push(`Project: ${meta.projectPath}`);
  if (meta.cwd) lines.push(`CWD: ${meta.cwd}`);
  if (meta.gitBranch) lines.push(`Branch: ${meta.gitBranch}`);
  if (meta.model) lines.push(`Model: ${meta.model}`);
  if (meta.claudeVersion) lines.push(`Claude Version: ${meta.claudeVersion}`);
  lines.push(`Messages: ${meta.messageCount}, Tool calls: ${meta.toolCallCount}`);
  lines.push(`File size: ${formatBytes(meta.fileSizeBytes)}`);
  if (meta.startedAt) {
    lines.push(`Started: ${new Date(meta.startedAt).toISOString()}`);
  }
  if (meta.firstPrompt) {
    const truncated = meta.firstPrompt.length > 80
      ? meta.firstPrompt.slice(0, 80) + '...'
      : meta.firstPrompt;
    lines.push(`First prompt: "${truncated}"`);
  }
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
