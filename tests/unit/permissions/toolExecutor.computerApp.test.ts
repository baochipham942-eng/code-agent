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

  it('V2 observe schema accepts targetApp and optional bundleId without opening additionalProperties', () => {
    expect(validateToolInputSchema(cuaStatefulComputerUseSchema.inputSchema, {
      operation: 'observe', targetApp: 'Notes', bundleId: 'com.example.notes', target: { pid: 42, windowId: 7 },
    })).toEqual([]);
    expect(cuaStatefulComputerUseSchema.inputSchema.additionalProperties).toBe(false);
    expect(cuaStatefulComputerUseSchema.inputSchema.properties?.targetApp).toMatchObject({ type: 'string' });
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
