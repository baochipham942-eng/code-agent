import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';

const resolverState = vi.hoisted(() => ({
  definition: undefined as ToolDefinition | undefined,
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: (name: string) => resolverState.definition?.name === name
      ? resolverState.definition
      : undefined,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';

describe('shell desktop automation approval boundary', () => {
  let permissionRequests: Array<Record<string, unknown>>;
  let executor: ToolExecutor;

  beforeEach(() => {
    resetPermissionModeManager();
    resolverState.definition = {
      name: 'Bash',
      description: 'shell test tool',
      outputSchema: { type: 'string' },
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      requiresPermission: true,
      permissionLevel: 'execute',
    };
    resolverState.execute.mockReset().mockResolvedValue({ success: true, output: 'ok' });
    permissionRequests = [];
    executor = new ToolExecutor({
      requestPermission: async (request) => {
        permissionRequests.push(request as unknown as Record<string, unknown>);
        return true;
      },
      workingDirectory: '/test/workspace',
    });
  });

  it('routes an Apple Events coordinate click through approval before dispatch', async () => {
    const result = await executor.execute('Bash', {
      command: `osascript -e 'tell application "System Events" to click at {120, 240}'`,
    }, { preApprovedTools: new Set(['Bash']) });

    expect(result.success).toBe(true);
    expect(permissionRequests).toHaveLength(1);
    expect(resolverState.execute).toHaveBeenCalledOnce();
  });

  it('blocks the real Apple Events click shape when approval is denied', async () => {
    executor = new ToolExecutor({
      requestPermission: async (request) => {
        permissionRequests.push(request as unknown as Record<string, unknown>);
        return false;
      },
      workingDirectory: '/test/workspace',
    });

    const result = await executor.execute('Bash', {
      command: `osascript -e 'tell application "System Events" to click at {120, 240}'`,
    }, {});

    expect(result.success).toBe(false);
    expect(permissionRequests).toHaveLength(1);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it.each([
    'renamed-driver c:120,240',
    'custom-wrapper keyboard press enter',
    'python -c "controller.mouse.click(120, 240)"',
  ])('classifies GUI input by semantic shape without depending on a binary name: %s', async (command) => {
    expect((await executor.execute('Bash', { command }, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(1);
  });

  // 主控 2026-08-24 探针补：首版判据漏过 AppleScript 官方缩写 tell app、
  // 以及 pyautogui/pydirectinput 这类「任意模块名 + 屏幕坐标」的 GUI 驱动。
  it.each([
    `osascript -e 'tell app "System Events" to keystroke "hello"'`,
    'python3 -c "import pyautogui; pyautogui.click(100,200)"',
    `python3 -c "import pyautogui; pyautogui.typewrite('secret')"`,
    `python3 -c "import pyautogui; pyautogui.hotkey('cmd','q')"`,
    'python3 -c "import pydirectinput; pydirectinput.moveTo(10, 20)"',
  ])('catches GUI drivers the first draft missed: %s', async (command) => {
    expect((await executor.execute('Bash', { command }, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(1);
  });

  it.each([
    'npm test',
    'npm run build',
    'git status --short',
    'git log --grep="click at" -1',
    // 没有屏幕坐标的普通调用不许被误伤——判据靠坐标形态区分，不是靠方法名
    `node -e "document.querySelector('#b').click()"`,
    `node -e "page.click('#submit')"`,
    'python3 -c "btn.press()"',
  ])('does not slow down ordinary shell work: %s', async (command) => {
    expect((await executor.execute('Bash', { command }, {
      preApprovedTools: new Set(['Bash']),
    })).success).toBe(true);
    expect(permissionRequests).toHaveLength(0);
  });
});
