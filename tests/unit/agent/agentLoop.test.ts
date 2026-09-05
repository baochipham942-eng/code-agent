// ============================================================================
// AgentLoop Tests
// Tests for utility functions and parallel execution logic
// Note: Full AgentLoop integration tests require extensive mocking
// ============================================================================

import { describe, it, expect } from 'vitest';

// ----------------------------------------------------------------------------
// Parallel Tool Safety Detection Tests
// These test the parallel execution logic without needing full AgentLoop setup
// ----------------------------------------------------------------------------

import { isParallelSafeTool } from '../../../src/host/agent/toolExecution/parallelStrategy';
import { SEQUENTIAL_TOOLS, MAX_PARALLEL_TOOLS } from '../../../src/host/agent/loopTypes';

/**
 * Check if any tool in the list requires sequential execution
 */
function hasSequentialTool(toolNames: string[]): boolean {
  return toolNames.some(name => SEQUENTIAL_TOOLS.has(name) || !isParallelSafeTool(name));
}

/**
 * Determine execution strategy for a list of tools
 */
function determineExecutionStrategy(toolNames: string[]): 'parallel' | 'sequential' | 'mixed' {
  const safeCount = toolNames.filter(isParallelSafeTool).length;
  const unsafeCount = toolNames.length - safeCount;

  if (safeCount === toolNames.length && toolNames.length <= MAX_PARALLEL_TOOLS) {
    return 'parallel';
  }
  if (unsafeCount === toolNames.length) {
    return 'sequential';
  }
  return 'mixed';
}

describe('Parallel Tool Safety Detection', () => {
  describe('isParallelSafeTool', () => {
    it('should identify read-only tools as parallel safe', () => {
      expect(isParallelSafeTool('Read')).toBe(true);
      expect(isParallelSafeTool('Glob')).toBe(true);
      expect(isParallelSafeTool('Grep')).toBe(true);
      expect(isParallelSafeTool('ListDirectory')).toBe(true);
      expect(isParallelSafeTool('WebSearch')).toBe(true);
      expect(isParallelSafeTool('memory_search')).toBe(true);
    });

    it('should identify write tools as not parallel safe', () => {
      expect(isParallelSafeTool('write_file')).toBe(false);
      expect(isParallelSafeTool('edit_file')).toBe(false);
      expect(isParallelSafeTool('bash')).toBe(false);
      expect(isParallelSafeTool('memory_store')).toBe(false);
    });

    it('should keep MCP tools without annotations sequential', () => {
      expect(isParallelSafeTool('mcp_read_resource')).toBe(false);
      expect(isParallelSafeTool('mcp_list_tools')).toBe(false);
      expect(isParallelSafeTool('mcp_list_resources')).toBe(false);
      expect(isParallelSafeTool('mcp_get_status')).toBe(false);
    });

    it('should handle MCP write tools as sequential', () => {
      expect(isParallelSafeTool('mcp_write_file')).toBe(false);
      expect(isParallelSafeTool('mcp_create_resource')).toBe(false);
    });

    it('should handle unknown tools as not parallel safe', () => {
      expect(isParallelSafeTool('unknown_tool')).toBe(false);
      expect(isParallelSafeTool('custom_action')).toBe(false);
    });
  });

  describe('hasSequentialTool', () => {
    it('should return false for all-parallel tools', () => {
      expect(hasSequentialTool(['Read', 'Glob', 'Grep'])).toBe(false);
    });

    it('should return true if any sequential tool exists', () => {
      expect(hasSequentialTool(['Read', 'write_file', 'Glob'])).toBe(true);
      expect(hasSequentialTool(['bash'])).toBe(true);
      expect(hasSequentialTool(['edit_file'])).toBe(true);
    });

    it('should return true for empty list as safe', () => {
      expect(hasSequentialTool([])).toBe(false);
    });
  });

  describe('determineExecutionStrategy', () => {
    it('should return parallel for all safe tools within limit', () => {
      expect(determineExecutionStrategy(['Read', 'Glob'])).toBe('parallel');
      expect(determineExecutionStrategy(['Read', 'Glob', 'Grep', 'ListDirectory'])).toBe('parallel');
    });

    it('should return sequential for all unsafe tools', () => {
      expect(determineExecutionStrategy(['write_file', 'edit_file'])).toBe('sequential');
      expect(determineExecutionStrategy(['bash'])).toBe('sequential');
    });

    it('should return mixed for combination of safe and unsafe', () => {
      expect(determineExecutionStrategy(['Read', 'write_file'])).toBe('mixed');
      expect(determineExecutionStrategy(['Glob', 'bash', 'Grep'])).toBe('mixed');
    });

    it('should return mixed if exceeds MAX_PARALLEL_TOOLS', () => {
      const manyReadOps = ['Read', 'Glob', 'Grep', 'ListDirectory', 'WebSearch'];
      expect(determineExecutionStrategy(manyReadOps)).toBe('mixed');
    });
  });
});

// ----------------------------------------------------------------------------
// Anti-Pattern Detection Tests
// Test detection of common issues like infinite read loops
// ----------------------------------------------------------------------------

describe('Anti-Pattern Detection', () => {
  /**
   * Detect consecutive read operations that might indicate a loop
   */
  function detectConsecutiveReads(toolHistory: string[], threshold: number = 5): boolean {
    const readTools = ['Read', 'Glob', 'Grep', 'ListDirectory'];
    let consecutiveReads = 0;

    for (let i = toolHistory.length - 1; i >= 0; i--) {
      if (readTools.includes(toolHistory[i])) {
        consecutiveReads++;
      } else {
        break;
      }
    }

    return consecutiveReads >= threshold;
  }

  /**
   * Detect duplicate tool calls that might indicate stuck behavior
   */
  function detectDuplicateCalls(
    toolHistory: Array<{ name: string; args: string }>,
    maxDuplicates: number = 3
  ): boolean {
    const callMap = new Map<string, number>();

    for (const call of toolHistory) {
      const key = `${call.name}:${call.args}`;
      const count = (callMap.get(key) || 0) + 1;
      callMap.set(key, count);

      if (count >= maxDuplicates) {
        return true;
      }
    }

    return false;
  }

  describe('detectConsecutiveReads', () => {
    it('should detect excessive consecutive reads', () => {
      const history = ['Read', 'Read', 'Read', 'Read', 'Read'];
      expect(detectConsecutiveReads(history)).toBe(true);
    });

    it('should not flag normal read patterns', () => {
      const history = ['Read', 'write_file', 'Read', 'Read'];
      expect(detectConsecutiveReads(history)).toBe(false);
    });

    it('should respect custom threshold', () => {
      const history = ['Read', 'Read', 'Read'];
      expect(detectConsecutiveReads(history, 3)).toBe(true);
      expect(detectConsecutiveReads(history, 4)).toBe(false);
    });

    it('should count from end of history', () => {
      const history = ['Read', 'Read', 'write_file', 'Read', 'Read'];
      expect(detectConsecutiveReads(history, 3)).toBe(false);
    });
  });

  describe('detectDuplicateCalls', () => {
    it('should detect repeated identical calls', () => {
      const history = [
        { name: 'Read', args: '/path/to/file.txt' },
        { name: 'Read', args: '/path/to/file.txt' },
        { name: 'Read', args: '/path/to/file.txt' },
      ];
      expect(detectDuplicateCalls(history)).toBe(true);
    });

    it('should not flag different arguments', () => {
      const history = [
        { name: 'Read', args: '/path/to/file1.txt' },
        { name: 'Read', args: '/path/to/file2.txt' },
        { name: 'Read', args: '/path/to/file3.txt' },
      ];
      expect(detectDuplicateCalls(history)).toBe(false);
    });

    it('should not flag different tools', () => {
      const history = [
        { name: 'Read', args: '/path' },
        { name: 'Glob', args: '/path' },
        { name: 'Grep', args: '/path' },
      ];
      expect(detectDuplicateCalls(history)).toBe(false);
    });

    it('should respect custom max duplicates', () => {
      const history = [
        { name: 'Read', args: '/path' },
        { name: 'Read', args: '/path' },
      ];
      expect(detectDuplicateCalls(history, 2)).toBe(true);
      expect(detectDuplicateCalls(history, 3)).toBe(false);
    });
  });
});

// ----------------------------------------------------------------------------
// Tool Failure Tracking Tests
// Test circuit breaker and failure recovery logic
// ----------------------------------------------------------------------------

describe('Tool Failure Tracking', () => {
  /**
   * Simple circuit breaker implementation
   */
  class ToolCircuitBreaker {
    private failureCounts: Map<string, number> = new Map();
    private consecutiveFailures: number = 0;

    constructor(
      private maxSameToolFailures: number = 3,
      private maxConsecutiveFailures: number = 5
    ) {}

    recordFailure(toolName: string): { tripped: boolean; reason?: string } {
      // Track per-tool failures
      const count = (this.failureCounts.get(toolName) || 0) + 1;
      this.failureCounts.set(toolName, count);

      // Track consecutive failures
      this.consecutiveFailures++;

      // Check circuit breaker conditions
      if (count >= this.maxSameToolFailures) {
        return { tripped: true, reason: `Tool ${toolName} failed ${count} times` };
      }

      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        return { tripped: true, reason: `${this.consecutiveFailures} consecutive failures` };
      }

      return { tripped: false };
    }

    recordSuccess(): void {
      this.consecutiveFailures = 0;
    }

    reset(): void {
      this.failureCounts.clear();
      this.consecutiveFailures = 0;
    }
  }

  describe('ToolCircuitBreaker', () => {
    it('should trip after too many same-tool failures', () => {
      const breaker = new ToolCircuitBreaker(3, 10);

      expect(breaker.recordFailure('Read').tripped).toBe(false);
      expect(breaker.recordFailure('Read').tripped).toBe(false);
      expect(breaker.recordFailure('Read').tripped).toBe(true);
    });

    it('should trip after too many consecutive failures', () => {
      const breaker = new ToolCircuitBreaker(10, 3);

      expect(breaker.recordFailure('tool1').tripped).toBe(false);
      expect(breaker.recordFailure('tool2').tripped).toBe(false);
      expect(breaker.recordFailure('tool3').tripped).toBe(true);
    });

    it('should reset consecutive counter on success', () => {
      const breaker = new ToolCircuitBreaker(10, 3);

      breaker.recordFailure('tool1');
      breaker.recordFailure('tool2');
      breaker.recordSuccess();
      expect(breaker.recordFailure('tool3').tripped).toBe(false);
    });

    it('should track per-tool failures independently', () => {
      const breaker = new ToolCircuitBreaker(3, 10);

      breaker.recordFailure('tool1');
      breaker.recordFailure('tool2');
      breaker.recordFailure('tool1');
      expect(breaker.recordFailure('tool1').tripped).toBe(true);
    });

    it('should fully reset on reset()', () => {
      const breaker = new ToolCircuitBreaker(3, 3);

      breaker.recordFailure('tool1');
      breaker.recordFailure('tool1');
      breaker.reset();

      expect(breaker.recordFailure('tool1').tripped).toBe(false);
      expect(breaker.recordFailure('tool1').tripped).toBe(false);
    });
  });
});

// ----------------------------------------------------------------------------
// Message Conversion Tests
// Test conversion between internal and API message formats
// ----------------------------------------------------------------------------

describe('Message Format Handling', () => {
  interface MessageContent {
    type: 'text' | 'image';
    text?: string;
    source?: {
      type: 'base64';
      media_type: string;
      data: string;
    };
  }

  interface ModelMessage {
    role: string;
    content: string | MessageContent[];
  }

  /**
   * Convert multimodal message content to string for display
   */
  function extractTextContent(content: string | MessageContent[]): string {
    if (typeof content === 'string') {
      return content;
    }

    return content
      .filter((c): c is MessageContent & { type: 'text'; text: string } =>
        c.type === 'text' && typeof c.text === 'string'
      )
      .map(c => c.text)
      .join('\n');
  }

  /**
   * Check if message contains images
   */
  function hasImageContent(content: string | MessageContent[]): boolean {
    if (typeof content === 'string') {
      return false;
    }
    return content.some(c => c.type === 'image');
  }

  describe('extractTextContent', () => {
    it('should handle string content', () => {
      expect(extractTextContent('Hello world')).toBe('Hello world');
    });

    it('should extract text from array content', () => {
      const content: MessageContent[] = [
        { type: 'text', text: 'First part' },
        { type: 'text', text: 'Second part' },
      ];
      expect(extractTextContent(content)).toBe('First part\nSecond part');
    });

    it('should ignore image content', () => {
      const content: MessageContent[] = [
        { type: 'text', text: 'Description' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      ];
      expect(extractTextContent(content)).toBe('Description');
    });

    it('should handle empty array', () => {
      expect(extractTextContent([])).toBe('');
    });
  });

  describe('hasImageContent', () => {
    it('should return false for string content', () => {
      expect(hasImageContent('Hello')).toBe(false);
    });

    it('should return true if array contains image', () => {
      const content: MessageContent[] = [
        { type: 'text', text: 'Look at this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      ];
      expect(hasImageContent(content)).toBe(true);
    });

    it('should return false if array has no images', () => {
      const content: MessageContent[] = [
        { type: 'text', text: 'Just text' },
      ];
      expect(hasImageContent(content)).toBe(false);
    });
  });
});
