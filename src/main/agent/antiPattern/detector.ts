// ============================================================================
// Anti-Pattern Detector - Detect and prevent common loop patterns
// ============================================================================

import type { ToolCall } from '../../../shared/types';
import type { AntiPatternState, FailedToolCallMatch, ToolFailureEntry } from '../loopTypes';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../loopTypes';
import { createLogger } from '../../services/infra/logger';
import { logCollector } from '../../mcp/logCollector';

const logger = createLogger('AntiPatternDetector');

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

export interface AntiPatternConfig {
  /** Max consecutive reads before warning (before any write) */
  maxConsecutiveReadsBeforeWrite: number;
  /** Max consecutive reads before warning (after first write) */
  maxConsecutiveReadsAfterWrite: number;
  /** Hard limit - force stop after this many consecutive reads */
  maxConsecutiveReadsHardLimit: number;
  /** Max times same tool can fail with same error */
  maxSameToolFailures: number;
  /** Max duplicate successful calls with same args */
  maxDuplicateCalls: number;
}

export const DEFAULT_ANTI_PATTERN_CONFIG: AntiPatternConfig = {
  maxConsecutiveReadsBeforeWrite: 5,
  maxConsecutiveReadsAfterWrite: 10,
  maxConsecutiveReadsHardLimit: 15,
  maxSameToolFailures: 3,
  maxDuplicateCalls: 3,
};

// ----------------------------------------------------------------------------
// Anti-Pattern Detector
// ----------------------------------------------------------------------------

/**
 * Anti-Pattern Detector - Detects and prevents common agent loop patterns
 *
 * Patterns detected:
 * 1. Infinite read loop - Agent keeps reading without writing
 * 2. Repeated tool failures - Same tool fails with same error
 * 3. Duplicate successful calls - Same call repeated unnecessarily
 * 4. Text-described tool calls - Model describes tool calls as text instead of executing
 */
export class AntiPatternDetector {
  private state: AntiPatternState;
  private config: AntiPatternConfig;

  constructor(config: Partial<AntiPatternConfig> = {}) {
    this.config = { ...DEFAULT_ANTI_PATTERN_CONFIG, ...config };
    this.state = {
      consecutiveReadOps: 0,
      hasWrittenFile: false,
      toolFailureTracker: new Map(),
      duplicateCallTracker: new Map(),
    };
  }

  // --------------------------------------------------------------------------
  // Read/Write Tracking
  // --------------------------------------------------------------------------

  /**
   * Track a tool execution for read/write pattern detection
   *
   * @returns Warning message if pattern detected, null otherwise
   */
  trackToolExecution(toolName: string, success: boolean): string | null {
    if (WRITE_TOOLS.includes(toolName) && success) {
      this.state.hasWrittenFile = true;
      this.state.consecutiveReadOps = 0;
      return null;
    }

    if (READ_ONLY_TOOLS.includes(toolName)) {
      this.state.consecutiveReadOps++;

      // Hard limit check
      if (this.state.consecutiveReadOps >= this.config.maxConsecutiveReadsHardLimit) {
        logger.error(`HARD LIMIT: ${this.state.consecutiveReadOps} consecutive read ops! Force stopping.`);
        logCollector.agent('ERROR', `Hard limit reached: ${this.state.consecutiveReadOps} consecutive reads, forcing stop`);
        return 'HARD_LIMIT';
      }

      // Warning threshold
      const warningThreshold = this.state.hasWrittenFile
        ? this.config.maxConsecutiveReadsAfterWrite
        : this.config.maxConsecutiveReadsBeforeWrite;

      if (this.state.consecutiveReadOps >= warningThreshold) {
        logger.debug(`WARNING: ${this.state.consecutiveReadOps} consecutive read ops! hasWritten=${this.state.hasWrittenFile}`);
        return this.generateReadLoopWarning();
      }
    }

    return null;
  }

  /**
   * Generate warning message for read loop
   */
  private generateReadLoopWarning(): string {
    if (this.state.hasWrittenFile) {
      return (
        `<critical-warning>\n` +
        `WARNING: You have performed ${this.state.consecutiveReadOps} consecutive read operations!\n` +
        `You have ALREADY created/modified files. The task may be COMPLETE.\n` +
        `Options:\n` +
        `1. If the task is done, respond with a completion message\n` +
        `2. If you need to make ONE more edit, do it now and then STOP\n` +
        `3. Do NOT keep reading the same file repeatedly\n` +
        `</critical-warning>`
      );
    }

    return (
      `<critical-warning>\n` +
      `WARNING: You have performed ${this.state.consecutiveReadOps} read operations without creating any files!\n` +
      `If this is a CREATION task (like "create a snake game"), you must:\n` +
      `1. STOP reading files\n` +
      `2. IMMEDIATELY use write_file to create the requested content\n` +
      `3. Do NOT continue researching - just CREATE!\n` +
      `</critical-warning>`
    );
  }

  /**
   * Generate error message for hard limit reached
   */
  generateHardLimitError(): string {
    return `操作已被系统中止：检测到无限循环（连续 ${this.state.consecutiveReadOps} 次只读操作）。请检查任务是否已完成，或尝试其他方法。`;
  }

  // --------------------------------------------------------------------------
  // Tool Failure Tracking
  // --------------------------------------------------------------------------

  /**
   * Track a tool failure and detect repeated failures
   *
   * @returns Warning message if pattern detected, null otherwise
   */
  trackToolFailure(toolCall: ToolCall, error: string): string | null {
    const toolKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
    const tracker = this.state.toolFailureTracker.get(toolKey);

    if (tracker && tracker.lastError === error) {
      tracker.count++;
      if (tracker.count >= this.config.maxSameToolFailures) {
        logger.warn(`Tool ${toolCall.name} failed ${tracker.count} times with same error`);
        // Clear tracker to avoid spamming
        this.state.toolFailureTracker.delete(toolKey);
        return this.generateRepeatedFailureWarning(toolCall.name, tracker.count, error);
      }
    } else {
      this.state.toolFailureTracker.set(toolKey, { count: 1, lastError: error });
    }

    return null;
  }

  /**
   * Clear failure tracker on success
   */
  clearToolFailure(toolCall: ToolCall): void {
    const toolKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
    this.state.toolFailureTracker.delete(toolKey);
  }

  /**
   * Generate warning for repeated failures
   */
  private generateRepeatedFailureWarning(toolName: string, count: number, error: string): string {
    return (
      `<repeated-failure-warning>\n` +
      `CRITICAL: The tool "${toolName}" has failed ${count} times with the SAME error:\n` +
      `Error: ${error}\n\n` +
      `You MUST:\n` +
      `1. STOP retrying this exact operation - it will NOT work\n` +
      `2. Analyze WHY it's failing (network issue? invalid parameters? missing config?)\n` +
      `3. Either try a DIFFERENT approach or inform the user that you cannot complete this task\n` +
      `4. If this is a network error, tell the user to check their network connection\n` +
      `</repeated-failure-warning>`
    );
  }

  // --------------------------------------------------------------------------
  // Duplicate Call Tracking
  // --------------------------------------------------------------------------

  /**
   * Track successful tool calls and detect duplicates
   *
   * @returns Warning message if pattern detected, null otherwise
   */
  trackDuplicateCall(toolCall: ToolCall): string | null {
    const toolKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
    const duplicateCount = (this.state.duplicateCallTracker.get(toolKey) || 0) + 1;
    this.state.duplicateCallTracker.set(toolKey, duplicateCount);

    if (duplicateCount >= this.config.maxDuplicateCalls) {
      logger.warn(`Detected ${duplicateCount} duplicate calls to ${toolCall.name} with same arguments`);
      // Clear tracker to avoid spamming
      this.state.duplicateCallTracker.delete(toolKey);
      return this.generateDuplicateCallWarning(toolCall.name, duplicateCount);
    }

    return null;
  }

  /**
   * Generate warning for duplicate calls
   */
  private generateDuplicateCallWarning(toolName: string, count: number): string {
    return (
      `<duplicate-call-warning>\n` +
      `CRITICAL: You have called "${toolName}" ${count} times with the EXACT SAME arguments!\n` +
      `This indicates an infinite loop. You MUST:\n` +
      `1. STOP calling this tool with the same parameters\n` +
      `2. The data you need is already available from previous calls\n` +
      `3. If the task is complete, respond with a completion message\n` +
      `4. If you need different data, use DIFFERENT parameters\n` +
      `</duplicate-call-warning>`
    );
  }

  // --------------------------------------------------------------------------
  // Text Tool Call Detection
  // --------------------------------------------------------------------------

  /**
   * Detect if the model described a tool call as text instead of actually executing it
   *
   * Detection strategies:
   * 1. History format patterns - Reverse parsing of formatToolCallForHistory output
   * 2. Generic call patterns - "Called toolname({...})"
   * 3. Intent description patterns - "I'll call the toolname tool..."
   * 4. JSON format patterns - {"name": "toolname", "arguments": ...}
   */
  detectFailedToolCallPattern(content: string): FailedToolCallMatch | null {
    const trimmed = content.trim();

    // ========== History format patterns (reverse parse formatToolCallForHistory) ==========

    // bash: "Ran: <command>"
    const ranMatch = trimmed.match(/^Ran:\s*(.+)$/is);
    if (ranMatch) {
      return { toolName: 'bash', args: JSON.stringify({ command: ranMatch[1].trim() }) };
    }

    // edit_file: "Edited <path>"
    const editedMatch = trimmed.match(/^Edited\s+(.+)$/i);
    if (editedMatch) {
      return { toolName: 'edit_file', args: JSON.stringify({ file_path: editedMatch[1].trim() }) };
    }

    // read_file: "Read <path>"
    const readMatch = trimmed.match(/^Read\s+(.+)$/i);
    if (readMatch) {
      return { toolName: 'read_file', args: JSON.stringify({ file_path: readMatch[1].trim() }) };
    }

    // write_file: "Created <path>"
    const createdMatch = trimmed.match(/^Created\s+(.+)$/i);
    if (createdMatch) {
      return { toolName: 'write_file', args: JSON.stringify({ file_path: createdMatch[1].trim() }) };
    }

    // glob: "Found files matching: <pattern>"
    const globMatch = trimmed.match(/^Found files matching:\s*(.+)$/i);
    if (globMatch) {
      return { toolName: 'glob', args: JSON.stringify({ pattern: globMatch[1].trim() }) };
    }

    // grep: "Searched for: <pattern>"
    const grepMatch = trimmed.match(/^Searched for:\s*(.+)$/i);
    if (grepMatch) {
      return { toolName: 'grep', args: JSON.stringify({ pattern: grepMatch[1].trim() }) };
    }

    // list_directory: "Listed: <path>"
    const listedMatch = trimmed.match(/^Listed:\s*(.+)$/i);
    if (listedMatch) {
      return { toolName: 'list_directory', args: JSON.stringify({ path: listedMatch[1].trim() }) };
    }

    // web_fetch: "Fetched: <url>"
    const fetchedMatch = trimmed.match(/^Fetched:\s*(.+)$/i);
    if (fetchedMatch) {
      return { toolName: 'web_fetch', args: JSON.stringify({ url: fetchedMatch[1].trim() }) };
    }

    // skill: "Invoked skill: <name>"
    const skillMatch = trimmed.match(/^Invoked skill:\s*(.+)$/i);
    if (skillMatch) {
      return { toolName: 'skill', args: JSON.stringify({ name: skillMatch[1].trim() }) };
    }

    // ========== Generic call patterns ==========

    // "Called toolname({...})" - most common error pattern
    const calledPattern = /Called\s+(\w+)\s*\(\s*(\{[\s\S]*?\})\s*\)/i;
    const calledMatch = trimmed.match(calledPattern);
    if (calledMatch) {
      return { toolName: calledMatch[1], args: calledMatch[2] };
    }

    // ========== Intent description patterns ==========

    // "I'll/Let me call/use the toolname tool" - describes intent but doesn't execute
    const intentPattern = /(?:I'll|Let me|I will|I'm going to)\s+(?:call|use|invoke|execute)\s+(?:the\s+)?(\w+)\s+tool/i;
    const intentMatch = trimmed.match(intentPattern);
    if (intentMatch) {
      // Only trigger for short content (likely pure intent description) with tool params
      if (trimmed.length < 500 && /\{[\s\S]*?\}/.test(trimmed)) {
        return { toolName: intentMatch[1] };
      }
    }

    // ========== JSON format patterns ==========

    // {"name": "toolname", "arguments": ...} or {"tool": "toolname", ...}
    const jsonToolPattern = /\{\s*"(?:name|tool)"\s*:\s*"(\w+)"\s*,\s*"(?:arguments|params|input)"\s*:/i;
    const jsonMatch = trimmed.match(jsonToolPattern);
    if (jsonMatch && trimmed.startsWith('{')) {
      return { toolName: jsonMatch[1] };
    }

    return null;
  }

  /**
   * Try to parse tool arguments from text-described tool call and construct ToolCall
   * Used to force execute tool calls the model described as text
   */
  tryForceExecuteTextToolCall(
    match: FailedToolCallMatch,
    content: string
  ): ToolCall | null {
    const { toolName, args: matchedArgs } = match;

    // Prefer regex-matched args
    if (matchedArgs) {
      try {
        const parsedArgs = JSON.parse(matchedArgs);
        logger.debug(`Parsed tool args from regex match: ${JSON.stringify(parsedArgs)}`);
        return {
          id: `force_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
          name: toolName,
          arguments: parsedArgs,
        };
      } catch (e) {
        logger.debug(`Failed to parse matched args: ${matchedArgs}`);
      }
    }

    // Try to extract full JSON args from content
    const jsonExtractPattern = new RegExp(
      `${toolName}\\s*\\(\\s*(\\{[\\s\\S]*\\})\\s*\\)`,
      'i'
    );
    const jsonMatch = content.match(jsonExtractPattern);
    if (jsonMatch) {
      try {
        let jsonStr = jsonMatch[1];
        // Fix common JSON issues
        jsonStr = jsonStr.replace(/'/g, '"');
        jsonStr = jsonStr.replace(/(\w+)(?=\s*:)/g, '"$1"');
        jsonStr = jsonStr.replace(/""(\w+)""/g, '"$1"');

        const parsedArgs = JSON.parse(jsonStr);
        logger.debug(`Parsed tool args from content: ${JSON.stringify(parsedArgs)}`);
        return {
          id: `force_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
          name: toolName,
          arguments: parsedArgs,
        };
      } catch (e) {
        logger.debug(`Failed to parse JSON from content: ${jsonMatch[1]?.slice(0, 200)}`);
      }
    }

    // Try to extract JSON from code block
    const codeBlockPattern = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;
    const codeBlockMatch = content.match(codeBlockPattern);
    if (codeBlockMatch) {
      try {
        const parsedArgs = JSON.parse(codeBlockMatch[1]);
        if (parsedArgs.server || parsedArgs.tool || parsedArgs.arguments || parsedArgs.file_path || parsedArgs.command) {
          logger.debug(`Parsed tool args from code block: ${JSON.stringify(parsedArgs)}`);
          return {
            id: `force_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
            name: toolName,
            arguments: parsedArgs,
          };
        }
      } catch (e) {
        logger.debug(`Failed to parse JSON from code block`);
      }
    }

    return null;
  }

  /**
   * Generate warning message for text-described tool call
   */
  generateToolCallFormatError(toolName: string, contentPreview: string): string {
    return (
      `<tool-call-format-error>\n` +
      `⚠️ ERROR: You just described a tool call as text instead of actually calling the tool.\n` +
      `You wrote: "${contentPreview.slice(0, 200)}..."\n\n` +
      `This is WRONG. You must use the actual tool calling mechanism, not describe it in text.\n` +
      `Please call the "${toolName}" tool properly using the tool_use format.\n` +
      `</tool-call-format-error>`
    );
  }

  // --------------------------------------------------------------------------
  // State Management
  // --------------------------------------------------------------------------

  /**
   * Get current state
   */
  getState(): Readonly<AntiPatternState> {
    return {
      ...this.state,
      toolFailureTracker: new Map(this.state.toolFailureTracker),
      duplicateCallTracker: new Map(this.state.duplicateCallTracker),
    };
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.state = {
      consecutiveReadOps: 0,
      hasWrittenFile: false,
      toolFailureTracker: new Map(),
      duplicateCallTracker: new Map(),
    };
  }

  /**
   * Get consecutive read count
   */
  getConsecutiveReadCount(): number {
    return this.state.consecutiveReadOps;
  }

  /**
   * Check if has written file
   */
  hasWritten(): boolean {
    return this.state.hasWrittenFile;
  }

  // --------------------------------------------------------------------------
  // Read-Only Stop Pattern Detection (P1 Nudge)
  // --------------------------------------------------------------------------

  /**
   * Detect if agent is about to stop after only reading files (no writes)
   * This is a common anti-pattern where agent reads files but doesn't execute modifications
   *
   * @param toolsUsedInTurn - List of tools used in the current turn
   * @returns Nudge message if pattern detected, null otherwise
   */
  detectReadOnlyStopPattern(toolsUsedInTurn: string[]): string | null {
    // Check if any read tools were used
    const hasReadTools = toolsUsedInTurn.some(tool => READ_ONLY_TOOLS.includes(tool));

    // Check if any write tools were used
    const hasWriteTools = toolsUsedInTurn.some(tool => WRITE_TOOLS.includes(tool));

    // Pattern: has reads but no writes
    if (hasReadTools && !hasWriteTools) {
      const readCount = toolsUsedInTurn.filter(tool => READ_ONLY_TOOLS.includes(tool)).length;
      logger.debug(`[ReadOnlyStop] Detected read-only pattern: ${readCount} reads, no writes`);

      return this.generateReadOnlyStopNudge(readCount);
    }

    return null;
  }

  /**
   * Generate nudge message for read-only stop pattern
   * Uses increasingly urgent tone based on read count
   */
  private generateReadOnlyStopNudge(readCount: number): string {
    // More urgent message for higher read counts
    if (readCount >= 3) {
      return (
        `<execution-nudge priority="critical">\n` +
        `🚨 **立即执行修改** - 你已读取 ${readCount} 个文件但没有任何修改！\n\n` +
        `**你必须现在使用 edit_file 或 write_file 工具。**\n\n` +
        `不要再读取文件。不要解释。不要计划。\n` +
        `直接调用工具执行修改。这是强制要求。\n` +
        `</execution-nudge>`
      );
    }

    return (
      `<execution-nudge>\n` +
      `⚠️ 检测到只读模式：你执行了 ${readCount} 次文件读取操作，但没有进行任何修改。\n\n` +
      `**下一步必须是 edit_file 或 write_file 工具调用。**\n\n` +
      `- 你已经读取了足够的信息\n` +
      `- 现在立即执行修改，不要继续读取\n` +
      `- 任务完成 = 产出文件变更，不是理解代码\n` +
      `</execution-nudge>`
    );
  }
}

/**
 * Create a new anti-pattern detector instance
 */
export function createAntiPatternDetector(
  config?: Partial<AntiPatternConfig>
): AntiPatternDetector {
  return new AntiPatternDetector(config);
}
