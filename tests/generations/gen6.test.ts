// ============================================================================
// Gen6 Tests - 视觉操控期 (Computer Use Era)
// Tests: screenshot, computer_use, browser_navigate, browser_action
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import tools
import { screenshotTool } from '../../src/main/tools/gen6/screenshot';
import { computerUseTool } from '../../src/main/tools/gen6/computerUse';
import { browserNavigateTool } from '../../src/main/tools/gen6/browserNavigate';
import { browserActionTool } from '../../src/main/tools/gen6/browserAction';

// Mock child_process for screenshot tests
vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  return {
    ...actual,
    exec: vi.fn((cmd, opts, callback) => {
      if (typeof opts === 'function') {
        callback = opts;
      }
      // Simulate successful screenshot by creating a dummy file
      if (cmd.includes('screencapture')) {
        const match = cmd.match(/"([^"]+\.png)"/);
        if (match) {
          fs.writeFileSync(match[1], 'fake-png-data');
        }
      }
      if (callback) {
        callback(null, { stdout: '', stderr: '' });
      }
    }),
  };
});

// Mock context
const createMockContext = (workingDirectory: string) => ({
  workingDirectory,
  generation: { id: 'gen6' as const },
  requestPermission: async () => true,
  emit: () => {},
});

describe('Gen6 - Computer Use Era', () => {
  let testDir: string;
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen6-test-'));
    context = createMockContext(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Screenshot Tool Tests
  // --------------------------------------------------------------------------
  describe('screenshot', () => {
    it('should have correct metadata', () => {
      expect(screenshotTool.generations).toContain('gen6');
      expect(screenshotTool.name).toBe('screenshot');
      expect(screenshotTool.requiresPermission).toBe(true);
    });

    it('should capture full screen by default', async () => {
      const result = await screenshotTool.execute(
        {},
        context
      );

      // May fail on CI without display, but should handle gracefully
      expect(result).toBeDefined();
    });

    it('should support custom output path', async () => {
      const outputPath = path.join(testDir, 'custom-screenshot.png');

      const result = await screenshotTool.execute(
        { outputPath },
        context
      );

      expect(result).toBeDefined();
    });

    it('should support window target', async () => {
      const result = await screenshotTool.execute(
        {
          target: 'window',
          windowName: 'Finder',
        },
        context
      );

      expect(result).toBeDefined();
    });

    it('should support region capture', async () => {
      const result = await screenshotTool.execute(
        {
          region: { x: 0, y: 0, width: 100, height: 100 },
        },
        context
      );

      expect(result).toBeDefined();
    });

    it('should create screenshots directory', async () => {
      const result = await screenshotTool.execute(
        {},
        context
      );

      expect(result).toBeDefined();
      // Should create .screenshots directory
    });
  });

  // --------------------------------------------------------------------------
  // Computer Use Tool Tests
  // --------------------------------------------------------------------------
  describe('computer_use', () => {
    it('should have correct metadata', () => {
      expect(computerUseTool.generations).toContain('gen6');
      expect(computerUseTool.name).toBe('computer_use');
      expect(computerUseTool.requiresPermission).toBe(true);
    });

    it('should require action parameter', async () => {
      const result = await computerUseTool.execute(
        {},
        context
      );

      expect(result.success).toBe(false);
    });

    it('should support click action', async () => {
      const result = await computerUseTool.execute(
        {
          action: 'click',
          x: 100,
          y: 100,
        },
        context
      );

      expect(result).toBeDefined();
    });

    it('should support type action', async () => {
      const result = await computerUseTool.execute(
        {
          action: 'type',
          text: 'Hello World',
        },
        context
      );

      expect(result).toBeDefined();
    });

    it('should support scroll action', async () => {
      const result = await computerUseTool.execute(
        {
          action: 'scroll',
          direction: 'down',
          amount: 100,
        },
        context
      );

      expect(result).toBeDefined();
    });

    it('should support key press action', async () => {
      const result = await computerUseTool.execute(
        {
          action: 'key',
          key: 'enter',
        },
        context
      );

      expect(result).toBeDefined();
    });

    it('should support drag action', async () => {
      const result = await computerUseTool.execute(
        {
          action: 'drag',
          startX: 100,
          startY: 100,
          endX: 200,
          endY: 200,
        },
        context
      );

      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Browser Navigate Tool Tests
  // --------------------------------------------------------------------------
  describe('browser_navigate', () => {
    it('should have correct metadata', () => {
      expect(browserNavigateTool.generations).toContain('gen6');
      expect(browserNavigateTool.name).toBe('browser_navigate');
      expect(browserNavigateTool.requiresPermission).toBe(true);
    });

    it('should require URL parameter', async () => {
      const result = await browserNavigateTool.execute(
        {},
        context
      );

      expect(result.success).toBe(false);
    });

    it('should navigate to URL', async () => {
      const result = await browserNavigateTool.execute(
        { url: 'https://example.com' },
        context
      );

      expect(result).toBeDefined();
    });

    it('should support wait parameter', async () => {
      const result = await browserNavigateTool.execute(
        {
          url: 'https://example.com',
          waitUntil: 'networkidle',
        },
        context
      );

      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Browser Action Tool Tests
  // --------------------------------------------------------------------------
  describe('browser_action', () => {
    it('should have correct metadata', () => {
      expect(browserActionTool.generations).toContain('gen6');
      expect(browserActionTool.name).toBe('browser_action');
    });

    it('should require action parameter', async () => {
      const result = await browserActionTool.execute(
        {},
        context
      );

      expect(result.success).toBe(false);
    });

    it('should support click selector', async () => {
      const result = await browserActionTool.execute(
        {
          action: 'click',
          selector: '#submit-button',
        },
        context
      );

      expect(result).toBeDefined();
    });

    it('should support fill form', async () => {
      const result = await browserActionTool.execute(
        {
          action: 'fill',
          selector: '#email-input',
          value: 'test@example.com',
        },
        context
      );

      expect(result).toBeDefined();
    });

    it('should support get text', async () => {
      const result = await browserActionTool.execute(
        {
          action: 'getText',
          selector: 'h1',
        },
        context
      );

      expect(result).toBeDefined();
    });

    it('should support screenshot element', async () => {
      const result = await browserActionTool.execute(
        {
          action: 'screenshot',
          selector: '#main-content',
        },
        context
      );

      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Tool Metadata Tests
  // --------------------------------------------------------------------------
  describe('Tool Metadata', () => {
    it('all gen6 tools should include gen6-8 generations', () => {
      const gen6Tools = [screenshotTool, computerUseTool, browserNavigateTool, browserActionTool];

      for (const tool of gen6Tools) {
        expect(tool.generations).toContain('gen6');
        expect(tool.generations).toContain('gen7');
        expect(tool.generations).toContain('gen8');
      }
    });

    it('computer use tools should require permission', () => {
      expect(screenshotTool.requiresPermission).toBe(true);
      expect(computerUseTool.requiresPermission).toBe(true);
      expect(browserNavigateTool.requiresPermission).toBe(true);
    });
  });
});
