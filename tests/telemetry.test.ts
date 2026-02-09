// ============================================================================
// Unit Tests for Telemetry Module - Intent Classifier
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyIntent, evaluateOutcome, IntentType } from '../src/main/telemetry/intentClassifier';

// ============================================================================
// Test Suite: classifyIntent
// ============================================================================

describe('classifyIntent', () => {
  describe('File Operations', () => {
    it('should classify read file intent with high confidence', () => {
      const result = classifyIntent({
        userPrompt: '读取 package.json 文件',
        toolCalls: [{ name: 'read_file', arguments: { file_path: 'package.json' } }],
        toolResults: [{ success: true, output: '{ "name": "test" }' }],
      });

      expect(result.intent).toBe(IntentType.READ_FILE);
      expect(result.confidence).toBeGreaterThan(0.8);
      expect(result.method).toBe('rule');
    });

    it('should classify write file intent correctly', () => {
      const result = classifyIntent({
        userPrompt: '创建一个新的文件 hello.js',
        toolCalls: [{ name: 'write_file', arguments: { file_path: 'hello.js' } }],
        toolResults: [{ success: true }],
      });

      expect(result.intent).toBe(IntentType.WRITE_FILE);
    });

    it('should classify edit file intent', () => {
      const result = classifyIntent({
        userPrompt: '修改 index.ts 中的导出',
        toolCalls: [{ name: 'edit_file', arguments: { file_path: 'index.ts' } }],
        toolResults: [{ success: true }],
      });

      expect(result.intent).toBe(IntentType.EDIT_FILE);
    });

    it('should detect file operation from tool calls alone', () => {
      const result = classifyIntent({
        userPrompt: '帮我处理这个文件',
        toolCalls: [{ name: 'delete_file', arguments: { file_path: 'old.js' } }],
        toolResults: [{ success: true }],
      });

      expect(result.intent).toBe(IntentType.DELETE_FILE);
    });
  });

  describe('Search Operations', () => {
    it('should classify code search intent', () => {
      const result = classifyIntent({
        userPrompt: '搜索所有包含 "console.log" 的文件',
        toolCalls: [{ name: 'grep', arguments: { pattern: 'console.log' } }],
        toolResults: [{ success: true, output: 'Found 10 matches' }],
      });

      expect(result.intent).toBe(IntentType.CODE_SEARCH);
    });

    it('should classify file search intent', () => {
      const result = classifyIntent({
        userPrompt: '找出所有的 TypeScript 文件',
        toolCalls: [{ name: 'glob', arguments: { pattern: '**/*.ts' } }],
        toolResults: [{ success: true, output: ['file1.ts', 'file2.ts'] }],
      });

      expect(result.intent).toBe(IntentType.FILE_SEARCH);
    });

    it('should classify web search intent', () => {
      const result = classifyIntent({
        userPrompt: '搜索最新的 React 文档',
        toolCalls: [{ name: 'web_search', arguments: { query: 'React documentation' } }],
        toolResults: [{ success: true }],
      });

      expect(result.intent).toBe(IntentType.WEB_SEARCH);
    });
  });

  describe('Code Operations', () => {
    it('should classify refactor intent', () => {
      const result = classifyIntent({
        userPrompt: '重构这个函数，提高可读性',
        toolCalls: [{ name: 'edit_file', arguments: { file_path: 'utils.ts' } }],
        toolResults: [{ success: true }],
      });

      expect(result.intent).toBe(IntentType.REFACTOR);
    });

    it('should classify debug intent', () => {
      const result = classifyIntent({
        userPrompt: '修复这个 bug',
        toolCalls: [{ name: 'read_file', arguments: { file_path: 'bug.js' } }],
        toolResults: [{ success: false, error: 'Syntax error' }],
      });

      expect(result.intent).toBe(IntentType.DEBUG);
    });

    it('should classify test generation intent', () => {
      const result = classifyIntent({
        userPrompt: '为这个模块写单元测试',
        toolCalls: [{ name: 'write_file', arguments: { file_path: 'tests/module.test.ts' } }],
        toolResults: [{ success: true }],
      });

      expect(result.intent).toBe(IntentType.TEST_GEN);
    });
  });

  describe('Documentation Operations', () => {
    it('should classify documentation intent', () => {
      const result = classifyIntent({
        userPrompt: '为这个 API 添加文档注释',
        toolCalls: [{ name: 'edit_file', arguments: { file_path: 'api.ts' } }],
        toolResults: [{ success: true }],
      });

      expect(result.intent).toBe(IntentType.DOCUMENTATION);
    });

    it('should classify README generation intent', () => {
      const result = classifyIntent({
        userPrompt: '生成项目 README',
        toolCalls: [{ name: 'write_file', arguments: { file_path: 'README.md' } }],
        toolResults: [{ success: true }],
      });

      expect(result.intent).toBe(IntentType.DOCUMENTATION);
    });
  });

  describe('Shell Operations', () => {
    it('should classify shell execution intent', () => {
      const result = classifyIntent({
        userPrompt: '运行 npm install',
        toolCalls: [{ name: 'bash', arguments: { command: 'npm install' } }],
        toolResults: [{ success: true, output: 'installed 50 packages' }],
      });

      expect(result.intent).toBe(IntentType.SHELL_EXEC);
    });

    it('should classify git operations', () => {
      const result = classifyIntent({
        userPrompt: '提交代码',
        toolCalls: [{ name: 'bash', arguments: { command: 'git commit -m "fix bug"' } }],
        toolResults: [{ success: true }],
      });

      expect(result.intent).toBe(IntentType.SHELL_EXEC);
    });
  });

  describe('Edge Cases and Complex Scenarios', () => {
    it('should handle empty input gracefully', () => {
      const result = classifyIntent({
        userPrompt: '',
        toolCalls: [],
        toolResults: [],
      });

      expect(result.intent).toBe(IntentType.GENERAL_QUERY);
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('should handle missing tool calls', () => {
      const result = classifyIntent({
        userPrompt: '帮我看看这个文件',
        toolCalls: [],
        toolResults: [],
      });

      expect(result.intent).toBe(IntentType.READ_FILE);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should handle failed tool calls', () => {
      const result = classifyIntent({
        userPrompt: '读取配置文件',
        toolCalls: [{ name: 'read_file', arguments: { file_path: 'config.json' } }],
        toolResults: [{ success: false, error: 'File not found' }],
      });

      expect(result.intent).toBe(IntentType.READ_FILE);
    });

    it('should classify complex multi-tool scenarios', () => {
      const result = classifyIntent({
        userPrompt: '搜索 bug 并修复',
        toolCalls: [
          { name: 'grep', arguments: { pattern: 'bug' } },
          { name: 'read_file', arguments: { file_path: 'buggy.js' } },
          { name: 'edit_file', arguments: { file_path: 'buggy.js' } },
        ],
        toolResults: [
          { success: true, output: 'Found in buggy.js' },
          { success: true, output: 'code content' },
          { success: true },
        ],
      });

      expect([IntentType.DEBUG, IntentType.REFACTOR]).toContain(result.intent);
    });

    it('should handle low confidence scenarios', () => {
      const result = classifyIntent({
        userPrompt: '你好',
        toolCalls: [],
        toolResults: [],
      });

      expect(result.confidence).toBeLessThan(0.3);
    });

    it('should classify unknown tools as general query', () => {
      const result = classifyIntent({
        userPrompt: '执行自定义操作',
        toolCalls: [{ name: 'custom_tool', arguments: {} }],
        toolResults: [{ success: true }],
      });

      expect(result.intent).toBe(IntentType.GENERAL_QUERY);
    });

    it('should prioritize successful tool calls for classification', () => {
      const result = classifyIntent({
        userPrompt: '检查文件状态',
        toolCalls: [
          { name: 'bash', arguments: { command: 'ls -la' } },
          { name: 'read_file', arguments: { file_path: 'test.ts' } },
        ],
        toolResults: [
          { success: false, error: 'Permission denied' },
          { success: true, output: 'file content' },
        ],
      });

      expect(result.intent).toBe(IntentType.READ_FILE);
    });

    it('should handle concurrent tool calls', () => {
      const result = classifyIntent({
        userPrompt: '同时搜索和列出文件',
        toolCalls: [
          { name: 'grep', arguments: { pattern: 'import' } },
          { name: 'glob', arguments: { pattern: '*.ts' } },
        ],
        toolResults: [
          { success: true, output: 'matches' },
          { success: true, output: ['file.ts'] },
        ],
      });

      expect([IntentType.CODE_SEARCH, IntentType.FILE_SEARCH]).toContain(result.intent);
    });
  });

  describe('Signal Extraction', () => {
    it('should extract signals from tool calls', () => {
      const result = classifyIntent({
        userPrompt: '读取文件',
        toolCalls: [{ name: 'read_file', arguments: { file_path: 'test.js' } }],
        toolResults: [{ success: true }],
      });

      expect(result.signals).toBeDefined();
      expect(Object.keys(result.signals).length).toBeGreaterThan(0);
    });

    it('should track tool success rate', () => {
      const result = classifyIntent({
        userPrompt: '多次尝试',
        toolCalls: [
          { name: 'read_file', arguments: { file_path: 'a.js' } },
          { name: 'read_file', arguments: { file_path: 'b.js' } },
          { name: 'read_file', arguments: { file_path: 'c.js' } },
        ],
        toolResults: [
          { success: true },
          { success: false, error: 'not found' },
          { success: true },
        ],
      });

      expect(result.signals).toBeDefined();
    });
  });
});

// ============================================================================
// Test Suite: evaluateOutcome
// ============================================================================

describe('evaluateOutcome', () => {
  it('should evaluate successful file read outcome', () => {
    const result = evaluateOutcome({
      intent: IntentType.READ_FILE,
      toolCalls: [{ name: 'read_file', arguments: { file_path: 'test.js' } }],
      toolResults: [{ success: true, output: 'file content' }],
    });

    expect(result.success).toBe(true);
    expect(result.matchedIntent).toBe(IntentType.READ_FILE);
  });

  it('should evaluate failed operation outcome', () => {
    const result = evaluateOutcome({
      intent: IntentType.READ_FILE,
      toolCalls: [{ name: 'read_file', arguments: { file_path: 'missing.js' } }],
      toolResults: [{ success: false, error: 'File not found' }],
    });

    expect(result.success).toBe(false);
  });

  it('should detect intent mismatch', () => {
    const result = evaluateOutcome({
      intent: IntentType.READ_FILE,
      toolCalls: [{ name: 'bash', arguments: { command: 'ls' } }],
      toolResults: [{ success: true, output: 'files listed' }],
    });

    expect(result.matchedIntent).not.toBe(IntentType.READ_FILE);
    expect(result.matchedIntent).toBe(IntentType.SHELL_EXEC);
  });

  it('should provide confidence score for outcome', () => {
    const result = evaluateOutcome({
      intent: IntentType.WRITE_FILE,
      toolCalls: [
        { name: 'write_file', arguments: { file_path: 'test.js' } },
        { name: 'read_file', arguments: { file_path: 'test.js' } },
      ],
      toolResults: [
        { success: true },
        { success: true, output: 'verified content' },
      ],
    });

    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('should handle partial success scenarios', () => {
    const result = evaluateOutcome({
      intent: IntentType.CODE_SEARCH,
      toolCalls: [
        { name: 'grep', arguments: { pattern: 'pattern1' } },
        { name: 'grep', arguments: { pattern: 'pattern2' } },
      ],
      toolResults: [
        { success: true, output: 'found 5 matches' },
        { success: false, error: 'no matches' },
      ],
    });

    expect(result.success).toBe(false); // Not all operations succeeded
  });

  it('should track outcome metrics', () => {
    const result = evaluateOutcome({
      intent: IntentType.DEBUG,
      toolCalls: [{ name: 'bash', arguments: { command: 'npm test' } }],
      toolResults: [{ success: true, output: 'All tests passed' }],
    });

    expect(result.metrics).toBeDefined();
    expect(result.metrics.toolCallCount).toBe(1);
    expect(result.metrics.successCount).toBe(1);
  });

  it('should classify outcome type', () => {
    const result = evaluateOutcome({
      intent: IntentType.REFACTOR,
      toolCalls: [{ name: 'edit_file', arguments: { file_path: 'code.ts' } }],
      toolResults: [{ success: true }],
    });

    expect(result.outcomeType).toBeDefined();
    expect(['SUCCESS', 'FAILURE', 'PARTIAL', 'MISMATCH']).toContain(result.outcomeType);
  });

  it('should provide suggestions for failed operations', () => {
    const result = evaluateOutcome({
      intent: IntentType.WRITE_FILE,
      toolCalls: [{ name: 'write_file', arguments: { file_path: '/readonly/file.js' } }],
      toolResults: [{ success: false, error: 'Permission denied' }],
    });

    if (result.suggestions) {
      expect(result.suggestions.length).toBeGreaterThan(0);
    }
  });

  it('should validate tool result completeness', () => {
    const result = evaluateOutcome({
      intent: IntentType.READ_FILE,
      toolCalls: [{ name: 'read_file', arguments: { file_path: 'test.js' } }],
      toolResults: [{ success: true }], // Missing output
    });

    expect(result.metrics).toBeDefined();
    expect(result.metrics.completeResultCount).toBe(0);
  });

  it('should handle no tool results', () => {
    const result = evaluateOutcome({
      intent: IntentType.GENERAL_QUERY,
      toolCalls: [],
      toolResults: [],
    });

    expect(result.success).toBe(false);
    expect(result.outcomeType).toBe('FAILURE');
  });
});

// ============================================================================
// Test Suite: Intent Type Constants
// ============================================================================

describe('IntentType', () => {
  it('should have all required intent types defined', () => {
    const expectedTypes = [
      'READ_FILE',
      'WRITE_FILE',
      'EDIT_FILE',
      'DELETE_FILE',
      'CODE_SEARCH',
      'FILE_SEARCH',
      'WEB_SEARCH',
      'REFACTOR',
      'DEBUG',
      'TEST_GEN',
      'DOCUMENTATION',
      'SHELL_EXEC',
      'GENERAL_QUERY',
    ];

    expectedTypes.forEach(type => {
      expect(IntentType).toHaveProperty(type);
    });
  });

  it('should have unique intent type values', () => {
    const values = Object.values(IntentType);
    const uniqueValues = new Set(values);
    expect(values.length).toBe(uniqueValues.size);
  });
});

// ============================================================================
// Test Suite: Integration Tests
// ============================================================================

describe('Intent Classifier Integration', () => {
  it('should classify and evaluate complete file read workflow', () => {
    const classification = classifyIntent({
      userPrompt: '读取 package.json 文件',
      toolCalls: [{ name: 'read_file', arguments: { file_path: 'package.json' } }],
      toolResults: [{ success: true, output: '{ "version": "1.0.0" }' }],
    });

    expect(classification.intent).toBe(IntentType.READ_FILE);

    const outcome = evaluateOutcome({
      intent: classification.intent,
      toolCalls: [{ name: 'read_file', arguments: { file_path: 'package.json' } }],
      toolResults: [{ success: true, output: '{ "version": "1.0.0" }' }],
    });

    expect(outcome.success).toBe(true);
    expect(outcome.matchedIntent).toBe(IntentType.READ_FILE);
  });

  it('should handle code search and refactor workflow', () => {
    const classification = classifyIntent({
      userPrompt: '搜索并重构旧的代码',
      toolCalls: [
        { name: 'grep', arguments: { pattern: 'var ' } },
        { name: 'edit_file', arguments: { file_path: 'old.js' } },
      ],
      toolResults: [
        { success: true, output: 'Found 10 matches' },
        { success: true },
      ],
    });

    expect([IntentType.REFACTOR, IntentType.CODE_SEARCH]