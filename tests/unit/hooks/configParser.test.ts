// ============================================================================
// Hook Config Parser Tests
// ============================================================================
//
// Tests for the hook configuration parsing module.
// Tests cover:
// - Parsing hooks configuration from JSON
// - Validating hook definitions
// - Tool name matching
// - Config file path generation
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseHooksConfig,
  loadAllHooksConfig,
  hookMatchesTool,
  getHooksConfigPaths,
  type HooksConfig,
  type ParsedHookConfig,
} from '../../../src/main/hooks/configParser';

describe('Hook Config Parser', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-config-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // --------------------------------------------------------------------------
  // parseHooksConfig
  // --------------------------------------------------------------------------
  describe('parseHooksConfig', () => {
    it('should parse valid hooks configuration', async () => {
      const configFile = path.join(tempDir, 'settings.json');
      const config = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'bash',
              hooks: [
                { type: 'command', command: '/path/to/script.sh' },
              ],
            },
          ],
        },
      };
      fs.writeFileSync(configFile, JSON.stringify(config));

      const result = await parseHooksConfig(configFile, 'project');

      expect(result).toHaveLength(1);
      expect(result[0].event).toBe('PreToolUse');
      expect(result[0].matcher?.source).toBe('bash');
      expect(result[0].hooks).toHaveLength(1);
      expect(result[0].source).toBe('project');
    });

    it('should parse multiple event types', async () => {
      const configFile = path.join(tempDir, 'settings.json');
      const config: { hooks: HooksConfig } = {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: 'pre.sh' }] },
          ],
          PostToolUse: [
            { hooks: [{ type: 'command', command: 'post.sh' }] },
          ],
          SessionStart: [
            { hooks: [{ type: 'command', command: 'start.sh' }] },
          ],
        },
      };
      fs.writeFileSync(configFile, JSON.stringify(config));

      const result = await parseHooksConfig(configFile, 'global');

      expect(result).toHaveLength(3);
      expect(result.map(r => r.event)).toContain('PreToolUse');
      expect(result.map(r => r.event)).toContain('PostToolUse');
      expect(result.map(r => r.event)).toContain('SessionStart');
    });

    it('should parse prompt hooks', async () => {
      const configFile = path.join(tempDir, 'settings.json');
      const config = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'bash',
              hooks: [
                { type: 'prompt', prompt: 'Evaluate this tool call: $TOOL_NAME' },
              ],
            },
          ],
        },
      };
      fs.writeFileSync(configFile, JSON.stringify(config));

      const result = await parseHooksConfig(configFile, 'project');

      expect(result[0].hooks[0].type).toBe('prompt');
      expect(result[0].hooks[0].prompt).toBe('Evaluate this tool call: $TOOL_NAME');
    });

    it('should return empty array for non-existent file', async () => {
      const result = await parseHooksConfig('/non/existent/file.json', 'global');
      expect(result).toEqual([]);
    });

    it('should return empty array for invalid JSON', async () => {
      const configFile = path.join(tempDir, 'invalid.json');
      fs.writeFileSync(configFile, 'not valid json');

      const result = await parseHooksConfig(configFile, 'project');
      expect(result).toEqual([]);
    });

    it('should return empty array for file without hooks', async () => {
      const configFile = path.join(tempDir, 'settings.json');
      fs.writeFileSync(configFile, JSON.stringify({ other: 'setting' }));

      const result = await parseHooksConfig(configFile, 'project');
      expect(result).toEqual([]);
    });

    it('should filter invalid hook definitions', async () => {
      const configFile = path.join(tempDir, 'settings.json');
      const config = {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: 'valid.sh' },
                { type: 'command' }, // Missing command
                { type: 'invalid' }, // Invalid type
                { type: 'prompt' }, // Missing prompt
                { type: 'prompt', prompt: 'valid prompt' },
              ],
            },
          ],
        },
      };
      fs.writeFileSync(configFile, JSON.stringify(config));

      const result = await parseHooksConfig(configFile, 'project');

      // Only valid hooks should be included
      expect(result[0].hooks).toHaveLength(2);
      expect(result[0].hooks[0].type).toBe('command');
      expect(result[0].hooks[1].type).toBe('prompt');
    });

    it('should handle multiple matchers for same event', async () => {
      const configFile = path.join(tempDir, 'settings.json');
      const config = {
        hooks: {
          PreToolUse: [
            { matcher: 'bash', hooks: [{ type: 'command', command: 'bash-hook.sh' }] },
            { matcher: 'edit_file', hooks: [{ type: 'command', command: 'edit-hook.sh' }] },
          ],
        },
      };
      fs.writeFileSync(configFile, JSON.stringify(config));

      const result = await parseHooksConfig(configFile, 'project');

      expect(result).toHaveLength(2);
      expect(result[0].matcher?.source).toBe('bash');
      expect(result[1].matcher?.source).toBe('edit_file');
    });

    it('should handle hooks without matcher (matches all)', async () => {
      const configFile = path.join(tempDir, 'settings.json');
      const config = {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: 'all-tools.sh' }] },
          ],
        },
      };
      fs.writeFileSync(configFile, JSON.stringify(config));

      const result = await parseHooksConfig(configFile, 'project');

      expect(result[0].matcher).toBeNull();
    });

    it('should preserve hook timeout configuration', async () => {
      const configFile = path.join(tempDir, 'settings.json');
      const config = {
        hooks: {
          PreToolUse: [
            {
              hooks: [{ type: 'command', command: 'slow.sh', timeout: 30000 }],
            },
          ],
        },
      };
      fs.writeFileSync(configFile, JSON.stringify(config));

      const result = await parseHooksConfig(configFile, 'project');

      expect(result[0].hooks[0].timeout).toBe(30000);
    });
  });

  // --------------------------------------------------------------------------
  // hookMatchesTool
  // --------------------------------------------------------------------------
  describe('hookMatchesTool', () => {
    it('should match exact tool name', () => {
      const config: ParsedHookConfig = {
        event: 'PreToolUse',
        matcher: /bash/,
        hooks: [],
        source: 'project',
      };

      expect(hookMatchesTool(config, 'bash')).toBe(true);
      expect(hookMatchesTool(config, 'edit_file')).toBe(false);
    });

    it('should match with regex pattern', () => {
      const config: ParsedHookConfig = {
        event: 'PreToolUse',
        matcher: /bash|edit_file|write_file/,
        hooks: [],
        source: 'project',
      };

      expect(hookMatchesTool(config, 'bash')).toBe(true);
      expect(hookMatchesTool(config, 'edit_file')).toBe(true);
      expect(hookMatchesTool(config, 'read_file')).toBe(false);
    });

    it('should match all when no matcher specified', () => {
      const config: ParsedHookConfig = {
        event: 'PreToolUse',
        matcher: null,
        hooks: [],
        source: 'project',
      };

      expect(hookMatchesTool(config, 'bash')).toBe(true);
      expect(hookMatchesTool(config, 'edit_file')).toBe(true);
      expect(hookMatchesTool(config, 'any_tool')).toBe(true);
    });

    it('should support wildcard patterns', () => {
      const config: ParsedHookConfig = {
        event: 'PreToolUse',
        matcher: /.*_file/,
        hooks: [],
        source: 'project',
      };

      expect(hookMatchesTool(config, 'edit_file')).toBe(true);
      expect(hookMatchesTool(config, 'read_file')).toBe(true);
      expect(hookMatchesTool(config, 'bash')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getHooksConfigPaths
  // --------------------------------------------------------------------------
  describe('getHooksConfigPaths', () => {
    it('should return global and project paths', () => {
      const paths = getHooksConfigPaths('/test/project');

      expect(paths.global).toContain('.claude');
      expect(paths.global).toContain('settings.json');
      expect(paths.project).toBe('/test/project/.claude/settings.json');
    });

    it('should handle different working directories', () => {
      const paths1 = getHooksConfigPaths('/project1');
      const paths2 = getHooksConfigPaths('/project2');

      expect(paths1.project).toBe('/project1/.claude/settings.json');
      expect(paths2.project).toBe('/project2/.claude/settings.json');
      // Global path should be the same
      expect(paths1.global).toBe(paths2.global);
    });
  });

  // --------------------------------------------------------------------------
  // loadAllHooksConfig
  // --------------------------------------------------------------------------
  describe('loadAllHooksConfig', () => {
    it('should load from both global and project', async () => {
      // Create temp project directory
      const projectDir = path.join(tempDir, 'project');
      const projectClaudeDir = path.join(projectDir, '.claude');
      fs.mkdirSync(projectClaudeDir, { recursive: true });

      const projectConfig = {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: 'project-hook.sh' }] },
          ],
        },
      };
      fs.writeFileSync(
        path.join(projectClaudeDir, 'settings.json'),
        JSON.stringify(projectConfig)
      );

      // Note: Global config won't exist in test, so only project hooks will load
      const result = await loadAllHooksConfig(projectDir);

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.some(h => h.source === 'project')).toBe(true);
    });

    it('should return only global hooks when project config does not exist', async () => {
      // Note: This test may pick up actual global ~/.claude/settings.json
      // We just verify it returns an array (may contain global hooks)
      const result = await loadAllHooksConfig('/non/existent/project');
      expect(Array.isArray(result)).toBe(true);
      // If there are results, they should all be from global source
      for (const config of result) {
        expect(config.source).toBe('global');
      }
    });
  });
});
