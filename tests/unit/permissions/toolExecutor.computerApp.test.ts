import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { resetDecisionHistory, getDecisionHistory } from '../../../src/host/security/decisionHistory';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { applyAppGrantsSchema } from '../../../src/host/services/core/database/schemaAppGrants';
import {
  bindAppGrantDatabase,
  mintAppGrantStanding,
  mintAppGrantSession,
} from '../../../src/host/permissions/appGrantStore';
import { appGrantKey } from '../../../src/host/permissions/computerAppTarget';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';

import { cuaStatefulComputerUseSchema } from '../../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse.schema';
import { validateToolInputSchema } from '../../../src/host/tools/toolSchemaValidator';

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function computerDefinition() {
  return {
    name: 'computer_use',
    description: 'computer',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: true,
    permissionLevel: 'execute' as const,
  };
}

describe('ToolExecutor computer app grants', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetDecisionHistory();
    resetPermissionModeManager();
    db = new Database(':memory:');
    applyAppGrantsSchema(db, logger as never);
    bindAppGrantDatabase(db, true);
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.getDefinition.mockReturnValue(computerDefinition());
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
  });

  afterEach(() => {
    resetPermissionModeManager();
    db.close();
  });

  it('V2 observe schema accepts targetApp and keeps additionalProperties closed: model-declared bundleId is not a declared param', () => {
    // rework r1：Host 无法在门上校验 bundleId（门跑在工具之前，拿不到真实 bundle），
    // 模型可伪造 bundle 铸跨 app 授权——schema 不再声明它，executor 的未声明参数
    // 剥离（toolExecutor.ts validateToolInputSchema + stripUndeclaredToolParams）
    // 在权限门之前就把它拿掉。
    expect(validateToolInputSchema(cuaStatefulComputerUseSchema.inputSchema, {
      operation: 'observe', targetApp: 'Notes', target: { pid: 42, windowId: 7 },
    })).toEqual([]);
    expect(validateToolInputSchema(cuaStatefulComputerUseSchema.inputSchema, {
      operation: 'observe', targetApp: 'Notes', bundleId: 'com.example.notes', target: { pid: 42, windowId: 7 },
    })).toEqual([
      expect.objectContaining({ category: 'additional_property', field_path: 'bundleId' }),
    ]);
    expect(cuaStatefulComputerUseSchema.inputSchema.additionalProperties).toBe(false);
    expect(cuaStatefulComputerUseSchema.inputSchema.properties?.targetApp).toMatchObject({ type: 'string' });
    expect(cuaStatefulComputerUseSchema.inputSchema.properties?.bundleId).toBeUndefined();
  });

  it('a grant recorded with a bundleId never authorizes a different app name (fabricated-bundle portable grant)', async () => {
    // 评审攻击链：首次获批带编造 bundleId x 铸出 bundle:x 授权；之后对未同意的
    // app 传其真实 appName + bundleId:x，bundle 命中自动放行。名字是唯一锚点。
    mintAppGrantStanding({ name: 'Calculator', bundleId: 'evil fabricated bundle' }, 1);
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute('computer_use', {
      operation: 'observe', targetApp: 'Bank', bundleId: 'evil fabricated bundle', target: { pid: 42, windowId: 7 },
    }, { sessionId: 's1' });
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.targetApp).toEqual({
      name: 'Bank', bundleId: 'evil fabricated bundle',
    });
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('same name with the recorded bundle still matches, and a different bundle re-asks', async () => {
    mintAppGrantStanding({ name: 'Calculator', bundleId: 'com.apple.calculator' }, 1);
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    await executor.execute('computer_use', {
      operation: 'observe', targetApp: 'calculator', bundleId: 'com.apple.calculator', target: { pid: 42, windowId: 7 },
    }, { sessionId: 's1' });
    expect(requestPermission).not.toHaveBeenCalled();
    await executor.execute('computer_use', {
      operation: 'observe', targetApp: 'Calculator', bundleId: 'other.bundle', target: { pid: 42, windowId: 7 },
    }, { sessionId: 's1' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('V2 observe unauthorized app asks with details.targetApp before execution', async () => {
    const requestPermission = vi.fn(async (request) => {
      expect(request.details.targetApp).toEqual({ name: 'Notes' });
      expect(resolverState.execute).not.toHaveBeenCalled();
      return true;
    });
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute('computer_use', {
      operation: 'observe', targetApp: 'Notes', target: { pid: 42, windowId: 7 },
    }, { sessionId: 's1' });
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it.each(['session', 'always'] as const)('V2 observe authorized app (%s) runs without asking', async (scope) => {
    if (scope === 'session') mintAppGrantSession('s1', { name: 'Notes' });
    else mintAppGrantStanding({ name: 'Notes' }, 1);
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute('computer_use', {
      operation: 'observe', targetApp: 'Notes', target: { pid: 42, windowId: 7 },
    }, { sessionId: 's1' });
    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('V2 observe denied app never executes the handler', async () => {
    const requestPermission = vi.fn().mockResolvedValue(false);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute('computer_use', {
      operation: 'observe', targetApp: 'Notes', target: { pid: 42, windowId: 7 },
    }, { sessionId: 's1' });
    expect(result.success).toBe(false);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('asks with the target app before a grant exists', async () => {
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'computer_use',
      { action: 'click', targetApp: 'Notes' },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.targetApp).toEqual({ name: 'Notes' });
  });

  it('skips the ask when a standing app grant matches and records the app key', async () => {
    mintAppGrantStanding({ name: 'Notes' }, 1);
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'computer_use',
      { action: 'click', targetApp: 'Notes' },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    const [entry] = getDecisionHistory().getRecent(1);
    expect(entry).toMatchObject({
      outcome: 'auto-approve',
      reason: `app_grant:${appGrantKey({ name: 'Notes' })}`,
    });
  });

  it('still denies an unknown action when a grant exists', async () => {
    mintAppGrantStanding({ name: 'Notes' }, 1);
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'computer_use',
      { action: 'not_a_real_action', targetApp: 'Notes' },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(String(result.error)).toContain('Denied');
  });

  it('still asks in readOnly mode even when a grant matches', async () => {
    mintAppGrantStanding({ name: 'Notes' }, 1);
    getPermissionModeManager().setMode('readOnly');
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    await executor.execute(
      'computer_use',
      { action: 'click', targetApp: 'Notes' },
      { sessionId: 's1' },
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('still auto-approves a computer click that has no target app', async () => {
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute('computer_use', { action: 'click' }, { sessionId: 's1' });
    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
