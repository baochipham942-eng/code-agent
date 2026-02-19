// ============================================================================
// AntiPatternDetector Tests
// Tests for isPlausibleBashCommand and detectFailedToolCallPattern
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock toolRegistry before importing detector
const mockGet = vi.fn();
vi.mock('../../../src/main/tools/toolRegistry', () => ({
  getToolRegistry: () => ({
    get: mockGet,
  }),
}));

// Mock logger
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock logCollector
vi.mock('../../../src/main/mcp/logCollector', () => ({
  logCollector: {
    addLog: vi.fn(),
  },
}));

// Import after mocks are set up
import { AntiPatternDetector } from '../../../src/main/agent/antiPattern/detector';

// Simulate common registered tools
const REGISTERED_TOOLS = new Set([
  'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep',
  'list_directory', 'web_fetch', 'web_search', 'read_xlsx',
  'memory_store', 'memory_search', 'ask_user_question',
  'todo_write', 'task', 'spawn_agent', 'screenshot',
  'ppt_generate', 'skill', 'tool_search',
]);

beforeEach(() => {
  // Mock registry.get: return truthy for registered tools, undefined for others
  mockGet.mockImplementation((name: string) =>
    REGISTERED_TOOLS.has(name) ? { name } : undefined
  );
});

// ----------------------------------------------------------------------------
// isPlausibleBashCommand Tests (tested indirectly via detectFailedToolCallPattern)
// ----------------------------------------------------------------------------

describe('detectFailedToolCallPattern', () => {
  let detector: AntiPatternDetector;

  beforeEach(() => {
    detector = new AntiPatternDetector();
  });

  // === Normal bash commands should be detected and returned ===

  describe('valid bash commands', () => {
    it('should match simple commands', () => {
      const result = detector.detectFailedToolCallPattern('Ran: ls -la');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
      expect(JSON.parse(result!.args).command).toBe('ls -la');
    });

    it('should match python script execution', () => {
      const result = detector.detectFailedToolCallPattern('Ran: python3 /tmp/script.py');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
      expect(JSON.parse(result!.args).command).toBe('python3 /tmp/script.py');
    });

    it('should match git commands', () => {
      const result = detector.detectFailedToolCallPattern('Ran: git status');
      expect(result).not.toBeNull();
      expect(JSON.parse(result!.args).command).toBe('git status');
    });

    it('should match echo with balanced quotes', () => {
      const result = detector.detectFailedToolCallPattern('Ran: echo "hello world"');
      expect(result).not.toBeNull();
      // Trailing quote cleanup may strip closing quote; verify detection works
      expect(JSON.parse(result!.args).command).toContain('echo');
    });

    it('should match npm/node commands', () => {
      const result = detector.detectFailedToolCallPattern('Ran: npm run build');
      expect(result).not.toBeNull();
      expect(JSON.parse(result!.args).command).toBe('npm run build');
    });

    it('should match piped commands', () => {
      const result = detector.detectFailedToolCallPattern('Ran: cat file.txt | grep pattern');
      expect(result).not.toBeNull();
      expect(JSON.parse(result!.args).command).toBe('cat file.txt | grep pattern');
    });

    it('should match "bash" alone as valid command', () => {
      const result = detector.detectFailedToolCallPattern('Ran: bash');
      expect(result).not.toBeNull();
      expect(JSON.parse(result!.args).command).toBe('bash');
    });

    it('should match commands with balanced single and double quotes', () => {
      const result = detector.detectFailedToolCallPattern(`Ran: python3 -c "print('hello')"`);
      expect(result).not.toBeNull();
      // Trailing paren/quote cleanup alters command; just verify detection
      expect(result!.toolName).toBe('bash');
    });
  });

  // === Tool name patterns (v32: no longer rejected at detection phase) ===
  // Since v32, detectFailedToolCallPattern is a pure pattern matcher.
  // Tool name validation moved to tryForceExecuteTextToolCall.

  describe('tool name patterns', () => {
    it('should match "write_file, bash" as Ran: pattern', () => {
      const result = detector.detectFailedToolCallPattern('Ran: write_file, bash');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should match "edit_file foo.ts" as Ran: pattern', () => {
      const result = detector.detectFailedToolCallPattern('Ran: edit_file foo.ts');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should match "read_file /tmp/data.csv" as Ran: pattern', () => {
      const result = detector.detectFailedToolCallPattern('Ran: read_file /tmp/data.csv');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should match "read_xlsx some_file.xlsx" as Ran: pattern', () => {
      const result = detector.detectFailedToolCallPattern('Ran: read_xlsx some_file.xlsx');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should match "glob *.ts" as Ran: pattern', () => {
      const result = detector.detectFailedToolCallPattern('Ran: glob *.ts');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should match "grep pattern src/" as Ran: pattern', () => {
      const result = detector.detectFailedToolCallPattern('Ran: grep pattern src/');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should match "bash" alone', () => {
      const result = detector.detectFailedToolCallPattern('Ran: bash');
      expect(result).not.toBeNull();
    });

    it('should match "bash script.sh" as Ran: pattern', () => {
      const result = detector.detectFailedToolCallPattern('Ran: bash script.sh');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });
  });

  // === Quote patterns (v32: no longer rejected at detection phase) ===
  // Quote balance validation was removed; detection is now permissive.

  describe('quote patterns', () => {
    it('should match truncated double-quoted command', () => {
      const result = detector.detectFailedToolCallPattern('Ran: python3 -c "');
      // Trailing quote stripped by cleanup → "python3 -c"
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should match truncated single-quoted command', () => {
      const result = detector.detectFailedToolCallPattern("Ran: awk '{");
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should match unbalanced quoted command', () => {
      const result = detector.detectFailedToolCallPattern('Ran: python3 -c "import pandas');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should accept command with balanced double quotes', () => {
      const result = detector.detectFailedToolCallPattern('Ran: echo "done"');
      expect(result).not.toBeNull();
    });

    it('should accept command with balanced single quotes', () => {
      const result = detector.detectFailedToolCallPattern("Ran: echo 'done'");
      expect(result).not.toBeNull();
    });

    it('should accept command with no quotes', () => {
      const result = detector.detectFailedToolCallPattern('Ran: ls -la /tmp');
      expect(result).not.toBeNull();
    });

    it('should match command with odd quotes', () => {
      const result = detector.detectFailedToolCallPattern('Ran: echo "hello" "world');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });
  });

  // === Short commands (v32: no longer rejected at detection phase) ===

  describe('short commands', () => {
    it('should match very short commands', () => {
      const result = detector.detectFailedToolCallPattern('Ran: ab');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should match single character', () => {
      const result = detector.detectFailedToolCallPattern('Ran: x');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should accept 3-character commands', () => {
      const result = detector.detectFailedToolCallPattern('Ran: pwd');
      expect(result).not.toBeNull();
    });
  });

  // === Heredoc handling ===

  describe('heredoc handling', () => {
    it('should match incomplete heredoc (returns opening line)', () => {
      const content = `Ran: python3 << 'EOF'
import pandas as pd
df = pd.read_excel("data.xlsx")`;
      const result = detector.detectFailedToolCallPattern(content);
      // Since v32, incomplete heredocs still detected (opening line returned)
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should match complete heredoc with closing delimiter', () => {
      const content = `Ran: python3 << 'EOF'
import pandas as pd
print("hello")
EOF`;
      const result = detector.detectFailedToolCallPattern(content);
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
      const cmd = JSON.parse(result!.args).command;
      expect(cmd).toContain('python3 <<');
      expect(cmd).toContain('import pandas');
      expect(cmd).toContain('EOF');
    });

    it('should match heredoc with only opening line', () => {
      const result = detector.detectFailedToolCallPattern("Ran: python3 << 'EOF'");
      // Heredoc opener without body is still detected as Ran: pattern
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('bash');
    });

    it('should handle heredoc with <<- (dash variant)', () => {
      const content = `Ran: python3 <<-EOF
print("hello")
EOF`;
      const result = detector.detectFailedToolCallPattern(content);
      expect(result).not.toBeNull();
    });

    it('should handle heredoc with XML residues in closing delimiter', () => {
      const content = `Ran: python3 << 'EOF'
print("test")
EOF</invoke>`;
      const result = detector.detectFailedToolCallPattern(content);
      expect(result).not.toBeNull();
      const cmd = JSON.parse(result!.args).command;
      // Closing line should be cleaned to just "EOF"
      expect(cmd.trim().endsWith('EOF')).toBe(true);
    });
  });

  // === CJK text truncation ===

  describe('CJK text truncation', () => {
    it('should truncate CJK explanatory text after command', () => {
      const result = detector.detectFailedToolCallPattern('Ran: python3 script.py  数据已成功保存');
      expect(result).not.toBeNull();
      const cmd = JSON.parse(result!.args).command;
      expect(cmd).toBe('python3 script.py');
      expect(cmd).not.toContain('数据');
    });

    it('should not truncate CJK in paths or arguments', () => {
      // Single space before CJK should not trigger truncation (needs 2+ spaces)
      const result = detector.detectFailedToolCallPattern('Ran: echo 你好');
      expect(result).not.toBeNull();
      const cmd = JSON.parse(result!.args).command;
      expect(cmd).toContain('你好');
    });
  });

  // === Other patterns (non-bash) ===

  describe('non-bash patterns', () => {
    it('should match "Edited <path>"', () => {
      const result = detector.detectFailedToolCallPattern('Edited /tmp/file.ts');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('edit_file');
    });

    it('should match "Read <path>"', () => {
      const result = detector.detectFailedToolCallPattern('Read /tmp/file.ts');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('read_file');
    });

    it('should match "Created <path>"', () => {
      const result = detector.detectFailedToolCallPattern('Created /tmp/new_file.ts');
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe('write_file');
    });
  });

  // === Edge cases ===

  describe('edge cases', () => {
    it('should handle empty string', () => {
      const result = detector.detectFailedToolCallPattern('');
      expect(result).toBeNull();
    });

    it('should handle string without any pattern', () => {
      const result = detector.detectFailedToolCallPattern('This is just regular text');
      expect(result).toBeNull();
    });

    it('should handle "Ran:" with no command', () => {
      const result = detector.detectFailedToolCallPattern('Ran: ');
      expect(result).toBeNull();
    });

    it('should be case-insensitive for "Ran:"', () => {
      const result = detector.detectFailedToolCallPattern('ran: ls -la');
      expect(result).not.toBeNull();
    });

    it('should handle command with mixed balanced quotes', () => {
      // 2 double + 2 single = all even → pass
      const result = detector.detectFailedToolCallPattern(`Ran: python3 -c "print('hi')"`);
      expect(result).not.toBeNull();
    });
  });
});
