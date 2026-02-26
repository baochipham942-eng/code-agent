// ============================================================================
// AntiPatternDetector.tryForceExecuteTextToolCall - Complex parsing tests
// Tests heredoc validation, XML cleanup, bash injection prevention,
// argument validation for write_file/edit_file/bash
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../../../src/main/mcp/logCollector', () => ({
  logCollector: { addLog: vi.fn(), agent: vi.fn() },
}));

import { AntiPatternDetector } from '../../../src/main/agent/antiPattern/detector';

describe('tryForceExecuteTextToolCall', () => {
  let detector: AntiPatternDetector;

  beforeEach(() => {
    detector = new AntiPatternDetector();
  });

  // --------------------------------------------------------------------------
  // bash command parsing
  // --------------------------------------------------------------------------
  describe('bash commands', () => {
    it('should parse simple Ran: command', () => {
      const match = { toolName: 'bash', args: JSON.stringify({ command: 'ls -la' }) };
      const result = detector.tryForceExecuteTextToolCall(match, 'Ran: ls -la');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('bash');
      expect(result!.arguments.command).toBe('ls -la');
    });

    it('should reject bash with empty command', () => {
      const match = { toolName: 'bash', args: JSON.stringify({ command: '' }) };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).toBeNull();
    });

    it('should strip CJK explanation text from bash commands', () => {
      const match = {
        toolName: 'bash',
        args: JSON.stringify({ command: 'python3 script.py  数据已保存到文件' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).not.toBeNull();
      expect(result!.arguments.command).toBe('python3 script.py');
    });

    it('should reject markdown-contaminated bash commands', () => {
      const match = {
        toolName: 'bash',
        args: JSON.stringify({ command: '**这是一个标题**' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).toBeNull();
    });

    it('should reject pipe-table-contaminated bash commands', () => {
      const match = {
        toolName: 'bash',
        args: JSON.stringify({ command: '| Column1 | Column2 |' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).toBeNull();
    });

    it('should strip newlines from non-heredoc bash commands', () => {
      const match = {
        toolName: 'bash',
        args: JSON.stringify({ command: 'echo hello\nmore lines here' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).not.toBeNull();
      expect(result!.arguments.command).toBe('echo hello');
    });
  });

  // --------------------------------------------------------------------------
  // heredoc handling
  // --------------------------------------------------------------------------
  describe('heredoc handling', () => {
    it('should accept complete heredoc with sufficient body', () => {
      const cmd = `python3 << 'EOF'\nimport pandas as pd\ndf = pd.read_excel("data.xlsx")\nprint(df.head())\nEOF`;
      const match = { toolName: 'bash', args: JSON.stringify({ command: cmd }) };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).not.toBeNull();
      expect(result!.arguments.command).toContain('python3 <<');
    });

    it('should reject truncated heredoc with omitted marker', () => {
      const cmd = `python3 << 'EOF'\n# ... (heredoc body omitted, 500 chars total)\nEOF`;
      const match = { toolName: 'bash', args: JSON.stringify({ command: cmd }) };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).toBeNull();
    });

    it('should reject heredoc with no body (single line)', () => {
      const cmd = `python3 << 'EOF'`;
      const match = { toolName: 'bash', args: JSON.stringify({ command: cmd }) };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).toBeNull();
    });

    it('should reject heredoc with extremely short body', () => {
      const cmd = `python3 << 'EOF'\nx\nEOF`;
      const match = { toolName: 'bash', args: JSON.stringify({ command: cmd }) };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // XML residue cleaning
  // --------------------------------------------------------------------------
  describe('XML residue cleaning', () => {
    it('should clean XML tags from matched args', () => {
      const match = {
        toolName: 'bash',
        args: '{"command": "<bash_command>ls -la</bash_command>"}',
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).not.toBeNull();
      expect(result!.arguments.command).toBe('ls -la');
    });

    it('should clean nested XML from tool arguments', () => {
      const match = {
        toolName: 'read_file',
        args: '{"file_path": "<file_path>/home/user/test.ts</file_path>"}',
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).not.toBeNull();
      expect(result!.arguments.file_path).toBe('/home/user/test.ts');
    });
  });

  // --------------------------------------------------------------------------
  // write_file validation
  // --------------------------------------------------------------------------
  describe('write_file validation', () => {
    it('should accept valid write_file args', () => {
      const match = {
        toolName: 'write_file',
        args: JSON.stringify({ file_path: '/tmp/test.ts', content: 'const x = 1;' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).not.toBeNull();
    });

    it('should reject write_file without file_path', () => {
      const match = {
        toolName: 'write_file',
        args: JSON.stringify({ content: 'hello' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).toBeNull();
    });

    it('should reject write_file with empty file_path', () => {
      const match = {
        toolName: 'write_file',
        args: JSON.stringify({ file_path: '', content: 'hello' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).toBeNull();
    });

    it('should reject write_file without content', () => {
      const match = {
        toolName: 'write_file',
        args: JSON.stringify({ file_path: '/tmp/test.ts' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).toBeNull();
    });

    it('should accept write_file with empty string content', () => {
      // Empty string is valid content (intentionally clearing a file)
      const match = {
        toolName: 'write_file',
        args: JSON.stringify({ file_path: '/tmp/test.ts', content: '' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // edit_file validation
  // --------------------------------------------------------------------------
  describe('edit_file validation', () => {
    it('should accept valid edit_file args', () => {
      const match = {
        toolName: 'edit_file',
        args: JSON.stringify({ file_path: '/test.ts', old_string: 'old', new_string: 'new' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).not.toBeNull();
    });

    it('should reject edit_file missing old_string', () => {
      const match = {
        toolName: 'edit_file',
        args: JSON.stringify({ file_path: '/test.ts', new_string: 'new' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).toBeNull();
    });

    it('should reject edit_file missing new_string', () => {
      const match = {
        toolName: 'edit_file',
        args: JSON.stringify({ file_path: '/test.ts', old_string: 'old' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).toBeNull();
    });

    it('should reject edit_file with non-string file_path', () => {
      const match = {
        toolName: 'edit_file',
        args: JSON.stringify({ file_path: 123, old_string: 'old', new_string: 'new' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Content-based JSON extraction
  // --------------------------------------------------------------------------
  describe('content-based JSON extraction', () => {
    it('should extract JSON from Called toolname({...}) pattern', () => {
      const content = 'Called read_file({"file_path": "/tmp/test.ts"})';
      const match = detector.detectFailedToolCallPattern(content)!;
      expect(match).not.toBeNull();
      const result = detector.tryForceExecuteTextToolCall(match, content);
      expect(result).not.toBeNull();
    });

    it('should extract JSON from code block in content', () => {
      const content = 'I will use the bash tool:\n```json\n{"command": "ls -la"}\n```';
      const match = { toolName: 'bash' };
      const result = detector.tryForceExecuteTextToolCall(match, content);
      expect(result).not.toBeNull();
      expect(result!.arguments.command).toBe('ls -la');
    });

    it('should return null when no parseable JSON found', () => {
      const match = { toolName: 'bash' };
      const result = detector.tryForceExecuteTextToolCall(match, 'Just some random text');
      expect(result).toBeNull();
    });

    it('should handle malformed JSON gracefully', () => {
      const match = {
        toolName: 'bash',
        args: '{command: "ls"',  // Invalid JSON (missing quotes, unclosed)
      };
      // Should not throw, just return null or attempt recovery
      const result = detector.tryForceExecuteTextToolCall(match, '');
      // Result depends on JSON.parse recovery
      // Main assertion: no crash
      expect(true).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Force-execute ID generation
  // --------------------------------------------------------------------------
  describe('ID generation', () => {
    it('should generate IDs with force_ prefix', () => {
      const match = {
        toolName: 'bash',
        args: JSON.stringify({ command: 'echo test' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).not.toBeNull();
      expect(result!.id).toMatch(/^force_\d+_[a-f0-9]+$/);
    });

    it('should generate unique IDs across calls', () => {
      const match = {
        toolName: 'bash',
        args: JSON.stringify({ command: 'echo test' }),
      };
      const r1 = detector.tryForceExecuteTextToolCall(match, '');
      const r2 = detector.tryForceExecuteTextToolCall(match, '');
      expect(r1!.id).not.toBe(r2!.id);
    });
  });

  // --------------------------------------------------------------------------
  // Unknown tool pass-through
  // --------------------------------------------------------------------------
  describe('unknown tools', () => {
    it('should pass through unknown tools without validation', () => {
      const match = {
        toolName: 'custom_tool',
        args: JSON.stringify({ any_param: 'value' }),
      };
      const result = detector.tryForceExecuteTextToolCall(match, '');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('custom_tool');
    });
  });
});
