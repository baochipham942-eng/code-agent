// ============================================================================
// Codex CLI Session Parser
//
// Parses Codex CLI's JSONL rollout files for import into code-agent.
// Session files are stored at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
//
// JSONL line types (confirmed from real rollout files):
//   - session_meta:     session lifecycle metadata (id, model, cwd, cli_version)
//   - turn_context:     per-turn context (model, sandbox_policy, approval_policy)
//   - response_item:    model responses — subtypes:
//       - message:        role-based message (developer/assistant/user)
//       - reasoning:      model reasoning (summary + encrypted_content)
//       - function_call:  tool invocation (name, arguments, call_id)
//       - function_call_output: tool result (call_id, output)
//   - event_msg:        events — subtypes:
//       - task_started:   turn start
//       - task_complete:  turn end (includes last_agent_message)
//       - user_message:   user input
//       - agent_message:  assistant text commentary
//       - agent_reasoning: reasoning summary text
//       - token_count:    rate limit info
//
// Use cases:
// 1. Extract error→recovery patterns for errorLearning
// 2. Cross-pollinate Codex shell patterns into code-agent
// ============================================================================

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { CODEX_SESSION } from '../../shared/constants';

// ============================================================================
// Types
// ============================================================================

/**
 * Metadata about a discovered Codex session.
 */
export interface CodexSessionMetadata {
  sessionId: string;
  model: string;
  sandboxPolicy: string;
  cwd: string;
  startTime: Date;
  rolloutPath: string;
  cliVersion?: string;
  modelProvider?: string;
}

/**
 * A single Codex tool call (exec_command).
 */
export interface CodexToolCall {
  id: string;
  name: string;         // 'exec_command' etc.
  input: string;        // command string
  output: string;       // execution result
  exitCode?: number;
  success: boolean;
}

/**
 * A fully parsed Codex session.
 */
export interface ParsedCodexSession {
  metadata: CodexSessionMetadata;
  toolCalls: CodexToolCall[];
  assistantMessages: string[];
  errors: string[];         // failed tool call outputs
  recoveries: Array<{      // fail→recovery pattern
    failedCall: CodexToolCall;
    recoveryCall: CodexToolCall;
  }>;
}

// ============================================================================
// Path Utilities
// ============================================================================

function getCodexSessionsRoot(): string {
  return CODEX_SESSION.DIR.replace('~', os.homedir());
}

/**
 * Extract session ID from a rollout filename.
 * Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
 */
function extractSessionId(filename: string): string {
  // UUID is the last segment before .jsonl, after the timestamp
  const base = path.basename(filename, '.jsonl');
  // rollout-2026-02-28T11-00-15-019ca230-8863-7c90-9750-6015fc1fc78a
  // The UUID starts after the 6th hyphen (YYYY-MM-DDTHH-MM-SS-)
  const parts = base.split('-');
  // "rollout", "2026", "02", "28T11", "00", "15", then UUID parts
  if (parts.length >= 7) {
    return parts.slice(6).join('-');
  }
  return base;
}

/**
 * Extract timestamp from rollout filename.
 */
function extractTimestampFromFilename(filename: string): Date | null {
  // rollout-2026-02-28T11-00-15-...
  const match = path.basename(filename).match(
    /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/
  );
  if (!match) return null;
  const [, year, month, day, hour, min, sec] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
}

// ============================================================================
// Session Discovery
// ============================================================================

/**
 * Scan ~/.codex/sessions/ for available Codex rollout files.
 *
 * Directory structure: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
export async function discoverCodexSessions(options?: {
  lookbackDays?: number;
  limit?: number;
}): Promise<CodexSessionMetadata[]> {
  const root = getCodexSessionsRoot();
  const lookbackDays = options?.lookbackDays ?? CODEX_SESSION.LEARNING_LOOKBACK_DAYS;
  const limit = options?.limit ?? CODEX_SESSION.MAX_SESSIONS_PER_SCAN;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  const results: CodexSessionMetadata[] = [];

  // Walk YYYY/MM/DD directory structure
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return []; // ~/.codex/sessions/ doesn't exist
  }

  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearPath = path.join(root, year);

    let months: string[];
    try {
      months = await fs.readdir(yearPath);
    } catch { continue; }

    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue;
      const monthPath = path.join(yearPath, month);

      let days: string[];
      try {
        days = await fs.readdir(monthPath);
      } catch { continue; }

      for (const day of days) {
        if (!/^\d{2}$/.test(day)) continue;
        const dayPath = path.join(monthPath, day);

        // Quick date check before listing files
        const dirDate = new Date(`${year}-${month}-${day}T00:00:00Z`);
        if (dirDate < cutoff) continue;

        let files: string[];
        try {
          files = await fs.readdir(dayPath);
        } catch { continue; }

        for (const file of files) {
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;

          const filePath = path.join(dayPath, file);
          const fileTime = extractTimestampFromFilename(file);
          if (fileTime && fileTime < cutoff) continue;

          // Quick-scan first lines for metadata
          const meta = await quickScanCodexMetadata(filePath, file);
          if (meta) {
            results.push(meta);
          }
        }
      }
    }
  }

  // Sort newest first
  results.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

  return results.slice(0, limit);
}

/**
 * Quick-scan a rollout file's first few lines for metadata.
 */
async function quickScanCodexMetadata(
  filePath: string,
  filename: string,
): Promise<CodexSessionMetadata | null> {
  const stream = fsSync.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId = '';
  let model = '';
  let sandboxPolicy = '';
  let cwd = '';
  let startTime = extractTimestampFromFilename(filename) ?? new Date();
  let cliVersion: string | undefined;
  let modelProvider: string | undefined;
  let lineCount = 0;

  try {
    for await (const line of rl) {
      if (lineCount > 20) break; // only need first few lines
      lineCount++;

      if (!line.trim()) continue;
      if (line.length > CODEX_SESSION.MAX_LINE_LENGTH) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch { continue; }

      const type = obj.type as string;

      if (type === 'session_meta') {
        const payload = obj.payload as Record<string, unknown>;
        if (payload) {
          sessionId = (payload.id as string) ?? '';
          cwd = (payload.cwd as string) ?? '';
          cliVersion = payload.cli_version as string | undefined;
          modelProvider = payload.model_provider as string | undefined;
          const ts = payload.timestamp as string | undefined;
          if (ts) startTime = new Date(ts);
        }
      }

      if (type === 'turn_context') {
        const payload = obj.payload as Record<string, unknown>;
        if (payload) {
          if (!model && payload.model) model = payload.model as string;
          const sp = payload.sandbox_policy;
          if (!sandboxPolicy && sp) {
            sandboxPolicy = typeof sp === 'string' ? sp : (sp as Record<string, unknown>)?.type as string ?? '';
          }
          if (!cwd && payload.cwd) cwd = payload.cwd as string;
        }
      }
    }
  } finally {
    stream.destroy();
  }

  if (!sessionId) {
    sessionId = extractSessionId(filename);
  }

  return {
    sessionId,
    model,
    sandboxPolicy,
    cwd,
    startTime,
    rolloutPath: filePath,
    cliVersion,
    modelProvider,
  };
}

// ============================================================================
// Full Session Parsing
// ============================================================================

/**
 * Parse a Codex JSONL rollout file into structured data.
 *
 * Stream-based line-by-line parsing. Handles:
 * - Large files (readline stream)
 * - Corrupted/malformed lines (skipped)
 * - Extremely long lines (truncated)
 * - All known line types
 */
export async function parseCodexSession(filePath: string): Promise<ParsedCodexSession> {
  const filename = path.basename(filePath);

  // Metadata defaults
  let sessionId = extractSessionId(filename);
  let model = '';
  let sandboxPolicy = '';
  let cwd = '';
  let startTime = extractTimestampFromFilename(filename) ?? new Date();
  let cliVersion: string | undefined;
  let modelProvider: string | undefined;

  const toolCalls: CodexToolCall[] = [];
  const assistantMessages: string[] = [];

  // Temporary map: call_id -> pending CodexToolCall (waiting for output)
  const pendingCalls = new Map<string, {
    id: string;
    name: string;
    input: string;
  }>();

  const stream = fsSync.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      // Guard against extremely long lines
      const safeLine = line.length > CODEX_SESSION.MAX_LINE_LENGTH
        ? line.slice(0, CODEX_SESSION.MAX_LINE_LENGTH)
        : line;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(safeLine);
      } catch {
        continue; // skip malformed lines
      }

      const type = obj.type as string;
      const payload = obj.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== 'object') continue;

      switch (type) {
        case 'session_meta': {
          sessionId = (payload.id as string) ?? sessionId;
          cwd = (payload.cwd as string) ?? cwd;
          cliVersion = (payload.cli_version as string) ?? cliVersion;
          modelProvider = (payload.model_provider as string) ?? modelProvider;
          const ts = payload.timestamp as string | undefined;
          if (ts) startTime = new Date(ts);
          break;
        }

        case 'turn_context': {
          if (!model && payload.model) model = payload.model as string;
          const sp = payload.sandbox_policy;
          if (!sandboxPolicy && sp) {
            sandboxPolicy = typeof sp === 'string' ? sp : (sp as Record<string, unknown>)?.type as string ?? '';
          }
          if (!cwd && payload.cwd) cwd = payload.cwd as string;
          break;
        }

        case 'response_item': {
          const subtype = payload.type as string;

          if (subtype === 'function_call') {
            const callId = payload.call_id as string ?? '';
            const name = payload.name as string ?? '';
            const argsStr = payload.arguments as string ?? '';
            // Extract command from arguments JSON
            let input = argsStr;
            try {
              const args = JSON.parse(argsStr);
              input = args.cmd ?? args.command ?? argsStr;
            } catch {
              // arguments might not be JSON, use as-is
            }
            pendingCalls.set(callId, { id: callId, name, input });
          }

          if (subtype === 'function_call_output') {
            const callId = payload.call_id as string ?? '';
            const output = payload.output as string ?? '';
            const pending = pendingCalls.get(callId);

            // Parse exit code from output
            let exitCode: number | undefined;
            const exitMatch = output.match(/exited with code (\d+)/);
            if (exitMatch) {
              exitCode = parseInt(exitMatch[1], 10);
            }

            // Check for sandbox denial
            const isDenied = output.includes('Sandbox(Denied');
            const success = exitCode === 0 && !isDenied;

            const toolCall: CodexToolCall = {
              id: callId,
              name: pending?.name ?? 'exec_command',
              input: pending?.input ?? '',
              output,
              exitCode,
              success,
            };

            toolCalls.push(toolCall);
            pendingCalls.delete(callId);
          }

          if (subtype === 'message') {
            const role = payload.role as string;
            if (role === 'assistant') {
              const content = payload.content;
              if (Array.isArray(content)) {
                for (const block of content as Array<Record<string, unknown>>) {
                  if (block.type === 'output_text' && typeof block.text === 'string') {
                    assistantMessages.push(block.text);
                  }
                }
              }
            }
          }
          break;
        }

        case 'event_msg': {
          const subtype = payload.type as string;
          if (subtype === 'agent_message') {
            const msg = payload.message as string;
            if (msg) assistantMessages.push(msg);
          }
          if (subtype === 'task_complete') {
            const lastMsg = payload.last_agent_message as string;
            if (lastMsg) assistantMessages.push(lastMsg);
          }
          break;
        }
      }
    }
  } finally {
    stream.destroy();
  }

  // Extract errors and recovery patterns
  const errors: string[] = [];
  const recoveries: ParsedCodexSession['recoveries'] = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    if (!call.success) {
      errors.push(call.output);

      // Look for recovery: next successful tool call of same type
      for (let j = i + 1; j < toolCalls.length && j <= i + 3; j++) {
        const next = toolCalls[j];
        if (next.success && next.name === call.name) {
          recoveries.push({
            failedCall: call,
            recoveryCall: next,
          });
          break;
        }
      }
    }
  }

  return {
    metadata: {
      sessionId,
      model,
      sandboxPolicy,
      cwd,
      startTime,
      rolloutPath: filePath,
      cliVersion,
      modelProvider,
    },
    toolCalls,
    assistantMessages,
    errors,
    recoveries,
  };
}
