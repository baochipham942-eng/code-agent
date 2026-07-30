import { describe, expect, it, vi } from 'vitest';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/host/protocol/tools';
import type { SpaceOperations } from '../../../../../src/host/services/project/spaceOperationsService';
import { ToolRegistry } from '../../../../../src/host/tools/registry';
import { registerMigratedTools } from '../../../../../src/host/tools/modules';
import { executeSpaceCreate } from '../../../../../src/host/tools/modules/planning/spaceCreate';
import { executeSpaceList } from '../../../../../src/host/tools/modules/planning/spaceList';
import { executeSpaceQuery } from '../../../../../src/host/tools/modules/planning/spaceQuery';
import { spaceCreateSchema } from '../../../../../src/host/tools/modules/planning/spaceCreate.schema';
import { spaceListSchema } from '../../../../../src/host/tools/modules/planning/spaceList.schema';
import { spaceQuerySchema } from '../../../../../src/host/tools/modules/planning/spaceQuery.schema';

function makeContext(): ToolContext {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    sessionId: 'session_1',
    workingDir: '/tmp',
    abortSignal: new AbortController().signal,
    logger,
    emit: vi.fn(),
  };
}

const space = {
  id: 'proj_space',
  name: 'Launch room',
  status: 'active' as const,
  createdAt: 1,
  updatedAt: 1,
  spacePromotedAt: 1,
};

function makeOperations(): SpaceOperations {
  return {
    list: vi.fn(() => [{
      ...space,
      activeTopicCount: 2,
      lastActivityAt: 10,
    }]),
    query: vi.fn(async () => ({
      space,
      cloudMembers: [],
      capabilities: {
        experts: [],
        skills: ['planning'],
        connectors: ['lark'],
        automations: [],
      },
      recentActivity: {
        activeTopicCount: 2,
        lastActivityAt: 10,
        sessions: [],
      },
      artifacts: [],
    })),
    create: vi.fn(async () => space),
  };
}

describe('space tools', () => {
  it('registers read-only list/query tools and an approval-gated write tool', async () => {
    expect(spaceListSchema).toMatchObject({ readOnly: true, permissionLevel: 'read' });
    expect(spaceQuerySchema).toMatchObject({ readOnly: true, permissionLevel: 'read' });
    expect(spaceCreateSchema).toMatchObject({ readOnly: false, permissionLevel: 'write' });

    const registry = new ToolRegistry();
    registerMigratedTools(registry, 'win32');
    expect(registry.has('space_list')).toBe(true);
    expect(registry.has('space_query')).toBe(true);
    expect(registry.has('space_create')).toBe(true);
    expect((await registry.resolve('space_create')).schema.name).toBe('space_create');
  });

  it('lists and aggregates collaboration spaces without requesting write approval', async () => {
    const operations = makeOperations();
    const canUseTool = vi.fn<CanUseToolFn>(async () => ({ allow: true }));
    const listResult = await executeSpaceList({}, makeContext(), canUseTool, undefined, operations);
    const queryResult = await executeSpaceQuery(
      { projectId: 'proj_space' },
      makeContext(),
      canUseTool,
      undefined,
      operations,
    );

    expect(listResult.ok).toBe(true);
    expect(queryResult.ok).toBe(true);
    expect(canUseTool).not.toHaveBeenCalled();
    expect(queryResult.ok && queryResult.output).toContain('"skills": [');
    expect(queryResult.ok && queryResult.output).toContain('"artifacts": []');
  });

  it('requires explicit approval before creating durable space state', async () => {
    const operations = makeOperations();
    const denied = vi.fn<CanUseToolFn>(async () => ({ allow: false, reason: 'user denied' }));
    const deniedResult = await executeSpaceCreate(
      { name: 'Launch room' },
      makeContext(),
      denied,
      undefined,
      operations,
    );

    expect(deniedResult).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(operations.create).not.toHaveBeenCalled();
    expect(denied).toHaveBeenCalledWith(
      'space_create',
      { name: 'Launch room' },
      expect.any(String),
      expect.objectContaining({ forceConfirm: true }),
    );

    const allowed = vi.fn<CanUseToolFn>(async () => ({ allow: true }));
    const created = await executeSpaceCreate(
      { name: ' Launch room ', description: ' ship ', trustAcknowledged: true },
      makeContext(),
      allowed,
      undefined,
      operations,
    );
    expect(created.ok).toBe(true);
    expect(operations.create).toHaveBeenCalledWith({
      name: 'Launch room',
      description: 'ship',
      workspacePath: undefined,
      trustAcknowledged: true,
    });
  });
});
