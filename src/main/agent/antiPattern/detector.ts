// ============================================================================
// Anti-Pattern Detector - Detect and prevent common loop patterns
// ============================================================================

import type { ToolCall } from '../../../shared/types';
import type { AntiPatternState, FailedToolCallMatch, ToolFailureEntry } from '../loopTypes';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../loopTypes';
import { cleanXmlResidues } from './cleanXml';
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
  /** Max times same tool can fail before suggesting alternative */
  maxFailuresBeforeAlternative: number;
}

/**
 * Tool alternative strategies - what to try when a tool fails repeatedly
 */
export const TOOL_ALTERNATIVES: Record<string, { alternative: string; reason: string }> = {
  edit_file: {
    alternative: 'write_file',
    reason: 'If edit_file fails repeatedly (old_string not found), re-read the file and use write_file to replace the entire content',
  },
  read_file: {
    alternative: 'bash',
    reason: 'If read_file fails, try: bash(command="cat <file>" or "head -n <lines> <file>")',
  },
  glob: {
    alternative: 'bash',
    reason: 'If glob fails, try: bash(command="find . -name \\"<pattern>\\"")',
  },
  grep: {
    alternative: 'bash',
    reason: 'If grep fails, try: bash(command="grep -r \\"<pattern>\\" .")',
  },
  web_fetch: {
    alternative: 'bash',
    reason: 'If web_fetch fails, try: bash(command="curl -s <url>")',
  },
};

export const DEFAULT_ANTI_PATTERN_CONFIG: AntiPatternConfig = {
  maxConsecutiveReadsBeforeWrite: 5,
  maxConsecutiveReadsAfterWrite: 10,
  maxConsecutiveReadsHardLimit: 15,
  maxSameToolFailures: 3,
  maxDuplicateCalls: 3,
  maxFailuresBeforeAlternative: 2,
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
  private rereadCounter: Map<string, number> = new Map();

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
  // Re-read Loop Detection (P0 fix for observation masking death loop)
  // --------------------------------------------------------------------------

  /**
   * Track file reads and detect re-read loops caused by observation masking.
   * When the same file is read 3+ times in a session, it means masking cleared
   * a previous result and the model is stuck re-reading.
   *
   * @returns Warning message to inject if loop detected, null otherwise
   */
  trackFileReread(filePath: string): string | null {
    const count = (this.rereadCounter.get(filePath) || 0) + 1;
    this.rereadCounter.set(filePath, count);

    if (count >= 3) {
      logger.warn(`[RereadLoop] File "${filePath}" read ${count} times — injecting loop breaker`);
      logCollector.agent('WARN', `Re-read loop detected: ${filePath} read ${count} times`);
      return (
        `<reread-loop-detected>\n` +
        `You are re-reading "${filePath}" repeatedly (${count} times). This means observation masking cleared the previous result.\n` +
        `STOP re-reading. Proceed based on what you remember, or ask the user for guidance.\n` +
        `</reread-loop-detected>`
      );
    }

    return null;
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
   * 4-level escalation: Strike 1 → 参数检查 | Strike 2 → 换工具 | Strike 3 → 重新分析 | Strike 4+ → 升级给用户
   *
   * @returns Warning message if pattern detected, 'ESCALATE_TO_USER' for 4+, null otherwise
   */
  trackToolFailure(toolCall: ToolCall, error: string): string | null {
    // 1. Always track by exact args for repeated failure detection (original behavior)
    const toolKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
    const tracker = this.state.toolFailureTracker.get(toolKey);
    let exactArgsWarning: string | null = null;

    if (tracker && tracker.lastError === error) {
      tracker.count++;
      if (tracker.count >= this.config.maxSameToolFailures) {
        logger.warn(`Tool ${toolCall.name} failed ${tracker.count} times with same error`);
        this.state.toolFailureTracker.delete(toolKey);
        exactArgsWarning = this.generateRepeatedFailureWarning(toolCall.name, tracker.count, error);
      }
    } else {
      this.state.toolFailureTracker.set(toolKey, { count: 1, lastError: error });
    }

    // 2. Track by tool name for 4-level escalation
    const toolNameKey = `__toolname__:${toolCall.name}`;
    const toolNameTracker = this.state.toolFailureTracker.get(toolNameKey);

    if (toolNameTracker) {
      toolNameTracker.count++;
      toolNameTracker.lastError = error;
    } else {
      this.state.toolFailureTracker.set(toolNameKey, { count: 1, lastError: error });
    }

    const count = this.state.toolFailureTracker.get(toolNameKey)?.count || 0;

    // Strike 4+: Escalate to user (highest priority)
    if (count >= 4) {
      logger.warn(`Tool ${toolCall.name} failed ${count} times — escalating to user`);
      logCollector.agent('WARN', `Strike 4+: Escalating ${toolCall.name} failure to user`, { count, error: error.substring(0, 200) });
      return 'ESCALATE_TO_USER';
    }

    // Strike 3: 硬阻断 — 强制使用替代工具（Harness Engineering: 机械式约束）
    if (count === 3) {
      const alternative = TOOL_ALTERNATIVES[toolCall.name];
      if (alternative) {
        logger.warn(`Tool ${toolCall.name} failed 3 times — FORCE switching to ${alternative.alternative}`);
        logCollector.agent('WARN', `Strike 3: Force alternative for ${toolCall.name} → ${alternative.alternative}`, { error: error.substring(0, 200) });
        return this.generateForceAlternative(toolCall.name, alternative.alternative, alternative.reason, error);
      }
      // 无替代工具时仍使用重新分析
      logger.warn(`Tool ${toolCall.name} failed 3 times — injecting rethink directive`);
      logCollector.agent('WARN', `Strike 3: Rethink directive for ${toolCall.name}`, { error: error.substring(0, 200) });
      return this.generateStrike3Rethink(toolCall.name, error);
    }

    // Strike 2: 建议换工具 or exact-args repeated failure warning
    if (count === 2) {
      const alternative = TOOL_ALTERNATIVES[toolCall.name];
      if (alternative) {
        logger.info(`Tool ${toolCall.name} failed 2 times — suggesting alternative: ${alternative.alternative}`);
        return this.generateAlternativeSuggestion(toolCall.name, count, error);
      }
      // 无替代工具时，返回 exact-args 警告（如果触发了）
      return exactArgsWarning;
    }

    // Strike 1: 参数检查引导
    if (count === 1) {
      return this.generateStrike1Guidance(toolCall.name, error);
    }

    return exactArgsWarning;
  }

  /**
   * Generate early alternative suggestion (before max retries reached)
   */
  private generateAlternativeSuggestion(toolName: string, count: number, error: string): string {
    const alternative = TOOL_ALTERNATIVES[toolName];
    if (!alternative) return '';

    return (
      `<strategy-switch-suggestion>\n` +
      `⚠️ Tool "${toolName}" has failed ${count} times. Consider switching strategy:\n\n` +
      `**Alternative:** Use "${alternative.alternative}"\n` +
      `**Why:** ${alternative.reason}\n\n` +
      `Last error: ${error.substring(0, 200)}${error.length > 200 ? '...' : ''}\n` +
      `</strategy-switch-suggestion>`
    );
  }

  /**
   * Strike 1: 参数检查引导 — 温和提示检查参数和前置条件
   */
  private generateStrike1Guidance(toolName: string, error: string): string {
    return (
      `<strike-1-guidance>\n` +
      `Tool "${toolName}" failed. Before retrying, verify:\n` +
      `1. All parameters are correct (paths exist, values are valid)\n` +
      `2. Required preconditions are met (file exists, directory created)\n` +
      `3. The error message: ${error.substring(0, 200)}${error.length > 200 ? '...' : ''}\n` +
      `Fix the root cause before retrying.\n` +
      `</strike-1-guidance>`
    );
  }

  /**
   * Strike 3 (with alternative): 强制切换工具 — 不再允许使用原工具
   */
  private generateForceAlternative(toolName: string, alternative: string, reason: string, error: string): string {
    return (
      `<force-alternative>\n` +
      `🚫 HARD BLOCK: Tool "${toolName}" is now DISABLED after 3 failures.\n\n` +
      `**You MUST use "${alternative}" instead.**\n` +
      `Reason: ${reason}\n\n` +
      `Do NOT attempt "${toolName}" again — it will be rejected.\n` +
      `Last error: ${error.substring(0, 200)}${error.length > 200 ? '...' : ''}\n` +
      `</force-alternative>`
    );
  }

  /**
   * Strike 3 (no alternative): 重新分析指令 — 强制用 read_file 确认状态 + 质疑假设
   */
  private generateStrike3Rethink(toolName: string, error: string): string {
    return (
      `<strike-3-rethink>\n` +
      `🚨 Tool "${toolName}" has failed 3 times. STOP and rethink your approach:\n\n` +
      `1. Use read_file to confirm the ACTUAL current state of the target\n` +
      `2. Question your assumptions — is the file/path/content what you expect?\n` +
      `3. Consider a COMPLETELY different approach to achieve the goal\n` +
      `4. DO NOT retry "${toolName}" with the same method\n\n` +
      `Last error: ${error.substring(0, 200)}${error.length > 200 ? '...' : ''}\n` +
      `</strike-3-rethink>`
    );
  }

  /**
   * Clear failure tracker on success
   */
  clearToolFailure(toolCall: ToolCall): void {
    const toolKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
    this.state.toolFailureTracker.delete(toolKey);
    // Also clear tool name tracker on success
    const toolNameKey = `__toolname__:${toolCall.name}`;
    this.state.toolFailureTracker.delete(toolNameKey);
  }

  /**
   * Generate warning for repeated failures with alternative strategy suggestion
   */
  private generateRepeatedFailureWarning(toolName: string, count: number, error: string): string {
    const alternative = TOOL_ALTERNATIVES[toolName];

    let alternativeSection = '';
    if (alternative) {
      alternativeSection = (
        `\n**SWITCH STRATEGY NOW:**\n` +
        `→ Use "${alternative.alternative}" instead\n` +
        `→ Reason: ${alternative.reason}\n`
      );
    }

    return (
      `<repeated-failure-warning>\n` +
      `🚨 CRITICAL: Tool "${toolName}" failed ${count} times with SAME error:\n` +
      `Error: ${error}\n` +
      alternativeSection +
      `\nYou MUST:\n` +
      `1. STOP retrying "${toolName}" with same parameters - it will NOT work\n` +
      `2. ${alternative ? `Switch to "${alternative.alternative}" as suggested above` : 'Try a completely different approach'}\n` +
      `3. If still failing, inform the user that you need their help\n` +
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

    // Early hint on 2nd duplicate for read-only tools
    if (duplicateCount === 2 && READ_ONLY_TOOLS.includes(toolCall.name)) {
      logger.debug(`Second call to ${toolCall.name} with same args - hinting to use cached result`);
      return this.generateCacheHintMessage(toolCall.name);
    }

    if (duplicateCount >= this.config.maxDuplicateCalls) {
      logger.warn(`Detected ${duplicateCount} duplicate calls to ${toolCall.name} with same arguments`);
      // Clear tracker to avoid spamming
      this.state.duplicateCallTracker.delete(toolKey);
      return this.generateDuplicateCallWarning(toolCall.name, duplicateCount);
    }

    return null;
  }

  /**
   * Generate a hint that result is already available (from cache or context)
   */
  private generateCacheHintMessage(toolName: string): string {
    return (
      `<cache-hint>\n` +
      `ℹ️ You just called "${toolName}" with the same parameters as before.\n` +
      `The result is already available in the conversation context above.\n` +
      `Please use the existing result instead of calling again.\n` +
      `</cache-hint>`
    );
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

    // bash: "Ran: <command>" — 不使用 s flag，避免 .+ 跨行匹配 markdown 内容
    const ranMatch = trimmed.match(/^Ran:\s*(.+)/i);
    if (ranMatch) {
      let cmd = ranMatch[1].trim();

      // 检测 heredoc（<< 'DELIM' / << "DELIM" / << DELIM / <<-DELIM）
      const heredocDelim = cmd.match(/<<-?\s*['"]?(\w+)['"]?\s*$/);
      if (heredocDelim) {
        // 从完整内容中提取 heredoc 块（Ran: 之后到闭合 delimiter）
        const delim = heredocDelim[1];
        const lines = trimmed.split('\n');
        // 闭合 delimiter 匹配：精确匹配或去掉 XML 残留后匹配（模型常输出 "EOF</invoke>" 等）
        const endIdx = lines.findIndex((line, i) => {
          if (i === 0) return false;
          const stripped = line.trim();
          return stripped === delim || stripped.replace(/<\/?[^>]+>/g, '').trim() === delim;
        });
        if (endIdx > 0) {
          const block = lines.slice(0, endIdx + 1);
          // 确保闭合行是干净的 delimiter（去掉 XML 残留）
          block[block.length - 1] = delim;
          cmd = block.join('\n').replace(/^Ran:\s*/i, '').trim();
        }
      } else {
        // 非 heredoc：截断命令中混入的中文解释文字（常见模式："cmd  数据已成功..."）
        const cjkBoundary = cmd.search(/\s{2,}[\u4e00-\u9fff\u3000-\u303f]/);
        if (cjkBoundary > 0) {
          cmd = cmd.substring(0, cjkBoundary).trim();
        }
        // 清理尾部泄漏的括号/引号（来自 "bash({...})" 格式的闭合符号）
        cmd = cmd.replace(/[)}\]"'`]+$/, '').trim();
      }

      if (cmd) {
        return { toolName: 'bash', args: JSON.stringify({ command: cmd }) };
      }
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

  // cleanXmlResidues 已提取为独立函数，见 ./cleanXml.ts

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
        // Clean XML residues before parsing
        const cleanedArgs = cleanXmlResidues(matchedArgs) as string;
        const parsedArgs = JSON.parse(cleanedArgs);
        // Clean parsed object recursively
        const sanitizedArgs = cleanXmlResidues(parsedArgs) as Record<string, unknown>;

        // bash 命令专项清理：防止 markdown/中文解释文字混入
        if (toolName === 'bash' && typeof sanitizedArgs.command === 'string') {
          let cmd = sanitizedArgs.command;
          // heredoc 命令：检测是否被截断/省略，只拒绝不完整的 heredoc
          const isHeredoc = /<<-?\s*['"]?\w+['"]?\s*$/m.test(cmd.split('\n')[0]);
          if (isHeredoc) {
            // 检测截断标记（模型常输出 "# ... (heredoc body omitted, N chars total)" 等占位符）
            const isTruncated = /\(.*(?:omitted|truncated|省略|chars total)\)/i.test(cmd)
              || /^#\s*\.\.\./m.test(cmd);
            if (isTruncated) {
              logger.warn(`[AntiPatternDetector] Refusing to force-execute truncated heredoc, will nudge model to use tool_use`);
              return null;
            }
            // 检测空/极短 heredoc body（maxTokens 截断导致 body 丢失）
            const firstNewline = cmd.indexOf('\n');
            if (firstNewline < 0) {
              logger.warn(`[AntiPatternDetector] Refusing to force-execute heredoc with no body`);
              return null;
            }
            const bodyAfterFirst = cmd.substring(firstNewline + 1).trim();
            if (bodyAfterFirst.length < 20) {
              logger.warn(`[AntiPatternDetector] Refusing to force-execute empty heredoc (body ${bodyAfterFirst.length} chars)`);
              return null;
            }
          }
          // 非 heredoc：移除换行后的内容（防止多行 markdown 泄漏）
          const nlIdx = cmd.indexOf('\n');
          if (nlIdx > 0) cmd = cmd.substring(0, nlIdx);
          // 移除命令后混入的中文解释
          const cjkBoundary = cmd.search(/\s{2,}[\u4e00-\u9fff\u3000-\u303f]/);
          if (cjkBoundary > 0) cmd = cmd.substring(0, cjkBoundary);
          cmd = cmd.trim();
          // 如果清理后命令以 markdown 格式开头或为空，拒绝执行
          if (!cmd || /^\*\*|^\|/.test(cmd)) {
            logger.warn(`[AntiPatternDetector] Bash command contains markdown, rejecting force execute`);
            return null;
          }
          sanitizedArgs.command = cmd;
        }

        logger.debug(`Parsed tool args from regex match: ${JSON.stringify(sanitizedArgs)}`);

        // Validate required fields before returning
        if (!this._validateForceExecuteArgs(toolName, sanitizedArgs)) return null;

        return {
          id: `force_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
          name: toolName,
          arguments: sanitizedArgs as Record<string, unknown>,
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
        // Clean XML residues first
        jsonStr = jsonStr.replace(/<\/?\w+(?:_\w+)*\s*\/?>/g, '').replace(/<\w+[^>]*>/g, '');
        // Fix common JSON issues
        jsonStr = jsonStr.replace(/'/g, '"');
        jsonStr = jsonStr.replace(/(\w+)(?=\s*:)/g, '"$1"');
        jsonStr = jsonStr.replace(/""(\w+)""/g, '"$1"');

        const parsedArgs = JSON.parse(jsonStr);
        const sanitizedArgs = cleanXmlResidues(parsedArgs);
        logger.debug(`Parsed tool args from content: ${JSON.stringify(sanitizedArgs)}`);

        if (!this._validateForceExecuteArgs(toolName, sanitizedArgs as Record<string, unknown>)) return null;

        return {
          id: `force_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
          name: toolName,
          arguments: sanitizedArgs as Record<string, unknown>,
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
        // Clean XML residues first
        const cleanedJson = codeBlockMatch[1].replace(/<\/?\w+(?:_\w+)*\s*\/?>/g, '').replace(/<\w+[^>]*>/g, '');
        const parsedArgs = JSON.parse(cleanedJson);
        if (parsedArgs.server || parsedArgs.tool || parsedArgs.arguments || parsedArgs.file_path || parsedArgs.command) {
          const sanitizedArgs = cleanXmlResidues(parsedArgs);
          logger.debug(`Parsed tool args from code block: ${JSON.stringify(sanitizedArgs)}`);

          if (!this._validateForceExecuteArgs(toolName, sanitizedArgs as Record<string, unknown>)) return null;

          return {
            id: `force_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
            name: toolName,
            arguments: sanitizedArgs as Record<string, unknown>,
          };
        }
      } catch (e) {
        logger.debug(`Failed to parse JSON from code block`);
      }
    }

    return null;
  }

  /**
   * Validate required fields for force-executed tool calls.
   * Rejects calls with missing/undefined critical args (e.g. write_file without content).
   */
  private _validateForceExecuteArgs(toolName: string, args: Record<string, unknown>): boolean {
    switch (toolName) {
      case 'write_file':
        if (typeof args.file_path !== 'string' || !args.file_path) {
          logger.warn(`[AntiPatternDetector] Force-execute rejected: write_file missing file_path`);
          return false;
        }
        if (args.content === undefined || args.content === null) {
          logger.warn(`[AntiPatternDetector] Force-execute rejected: write_file missing content`);
          return false;
        }
        return true;
      case 'edit_file':
        if (typeof args.file_path !== 'string' || !args.file_path) {
          logger.warn(`[AntiPatternDetector] Force-execute rejected: edit_file missing file_path`);
          return false;
        }
        if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
          logger.warn(`[AntiPatternDetector] Force-execute rejected: edit_file missing old_string/new_string`);
          return false;
        }
        return true;
      case 'bash':
        if (typeof args.command !== 'string' || !args.command) {
          logger.warn(`[AntiPatternDetector] Force-execute rejected: bash missing command`);
          return false;
        }
        return true;
      default:
        return true;
    }
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
    this.rereadCounter.clear();
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
