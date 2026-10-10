// ============================================================================
// AgentLoop Tests
// Tests for utility functions and parallel execution logic
// Note: Full AgentLoop integration tests require extensive mocking
// ============================================================================

import { describe, it, expect } from 'vitest';

import { classifyToolCalls } from '../../../src/host/agent/toolExecution/parallelStrategy';
import type { ToolCall } from '../../../src/shared/contract';

const ROOT = '/tmp/toolres-k2';

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args };
}

function segmentNames(toolCalls: ToolCall[]): string[][] {
  return classifyToolCalls(toolCalls, undefined, { workspace: ROOT, cwd: ROOT })
    .segments.map((segment) => segment.map((entry) => entry.toolCall.name));
}

describe('order-preserving tool segments', () => {
  it('keeps independent reads together', () => {
    expect(segmentNames([
      call('1', 'Read', { file_path: 'a.txt' }),
      call('2', 'Glob', { pattern: '*.ts', path: 'src' }),
      call('3', 'Grep', { pattern: 'x', path: 'src' }),
      call('4', 'ListDirectory', { path: 'src' }),
    ])).toEqual([['Read', 'Glob', 'Grep', 'ListDirectory']]);
  });

  it('serializes pathless writes and shell calls', () => {
    expect(segmentNames([
      call('1', 'write_file'),
      call('2', 'edit_file'),
    ])).toEqual([['write_file'], ['edit_file']]);
    expect(segmentNames([call('1', 'bash', { command: 'pwd' })])).toEqual([['bash']]);
    expect(segmentNames([call('1', 'memory_store')])).toEqual([['memory_store']]);
  });

  it('puts an unannotated MCP call in its own segment before a later read', () => {
    expect(segmentNames([
      call('1', 'mcp_read_resource'),
      call('2', 'Read', { file_path: 'a.txt' }),
    ])).toEqual([['mcp_read_resource'], ['Read']]);
    expect(segmentNames([call('1', 'unknown_tool')])).toEqual([['unknown_tool']]);
  });

  it('splits a same-path read from the write that precedes it', () => {
    expect(segmentNames([
      call('1', 'Write', { file_path: 'a.txt', content: 'x' }),
      call('2', 'Read', { file_path: 'a.txt' }),
    ])).toEqual([['Write'], ['Read']]);
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
