import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, PermissionRequest } from '../../../src/shared/contract';
import type { ConfigService } from '../../../src/host/services/core/configService';
import { AgentOrchestrator } from '../../../src/host/agent/agentOrchestrator';
import { AcpClientHostBridge } from '../../../src/host/services/agentEngine/acpClientHostBridge';
import {
  getPermissionModeManager,
  resetPermissionModeManager,
  type PermissionMode,
} from '../../../src/host/permissions/modes';

const SESSION = 'engine-permmode-map';

function permissionCards(events: AgentEvent[]): PermissionRequest[] {
  return events.flatMap((event) => (event.type === 'permission_request' ? [event.data] : []));
}

describe('requestExternalEnginePermission session ceiling', () => {
  let orchestrator: AgentOrchestrator;
  let events: AgentEvent[];

  beforeEach(() => {
    resetPermissionModeManager();
    events = [];
    const configService = {
      getSettings: () => ({
        permissions: {
          autoApprove: { read: false, write: false, execute: false, network: false },
          devModeAutoApprove: false,
        },
      }),
      isDevModeAutoApproveEnabled: () => false,
    } as unknown as ConfigService;
    orchestrator = new AgentOrchestrator({
      configService,
      hasApprovalUi: () => true,
      onEvent: (event) => { events.push(event); },
    });
  });

  afterEach(async () => {
    for (const pending of orchestrator.getPendingPermissionRequests()) {
      orchestrator.handlePermissionResponse(pending.id, 'deny');
    }
    await orchestrator.drainWorkspaceServices();
    resetPermissionModeManager();
  });

  function setMode(mode: PermissionMode): void {
    expect(getPermissionModeManager().setSessionMode(SESSION, mode, true)).toBe(true);
  }

  function writeRequest(type: 'file_write' | 'command' | 'file_read') {
    return {
      sessionId: SESSION,
      type,
      tool: type === 'command' ? 'acp:terminal/create' : 'acp:fs/write_text_file',
      details: { path: '/tmp/engine-permmode-map.txt', command: type === 'command' ? 'true' : undefined },
    };
  }

  async function expectFailClosed(type: 'file_write' | 'command'): Promise<void> {
    const before = permissionCards(events).length;
    const pending = orchestrator.requestExternalEnginePermission(writeRequest(type));
    await Promise.resolve();
    expect(permissionCards(events).length).toBe(before);
    await expect(pending).resolves.toEqual({ approved: false, denialSource: 'fail-closed' });
  }

  async function expectApprovalChain(type: 'file_write' | 'command' | 'file_read'): Promise<void> {
    const before = permissionCards(events).length;
    const pending = orchestrator.requestExternalEnginePermission(writeRequest(type));
    await Promise.resolve();
    const cards = permissionCards(events);
    expect(cards.length).toBe(before + 1);
    const card = cards[cards.length - 1];
    if (!card) throw new Error('missing permission_request');
    orchestrator.handlePermissionResponse(card.id, 'deny');
    await expect(pending).resolves.toMatchObject({ approved: false, denialSource: 'user' });
  }

  it('plan mode denies ACP file writes and terminal commands without an approval card', async () => {
    setMode('plan');
    await expectFailClosed('file_write');
    await expectFailClosed('command');
  });

  it('plan mode still asks for a file read', async () => {
    setMode('plan');
    await expectApprovalChain('file_read');
  });

  it('acceptEdits, default, and bypassPermissions still reach the approval chain', async () => {
    for (const mode of ['acceptEdits', 'default', 'bypassPermissions'] as const) {
      setMode(mode);
      await expectApprovalChain('file_write');
      await expectApprovalChain('command');
    }
  });

  it('a mid-run switch to plan denies the next write without a cached launch mode', async () => {
    setMode('acceptEdits');
    await expectApprovalChain('file_write');
    setMode('plan');
    await expectFailClosed('command');
  });

  it('plan mode denies an unclassifiable tool permission with no card, same as a classified write', async () => {
    setMode('plan');
    const seen: string[] = [];
    const bridge = new AcpClientHostBridge({
      workspaceRoot: '/tmp/engine-permmode-map',
      cwd: '/tmp/engine-permmode-map',
      sessionId: SESSION,
      requestPermission: (request) => {
        seen.push(request.type);
        return orchestrator.requestExternalEnginePermission(request);
      },
    });
    const options = [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ];
    const denied = { outcome: { outcome: 'selected', optionId: 'no' } };
    const calls: Array<{ title: string; kind?: string }> = [
      { title: 'Edit', kind: 'edit' },
      { title: 'Mystery', kind: 'not-a-real-kind' },
      { title: 'NoKind' },
    ];

    for (const toolCall of calls) {
      const before = permissionCards(events).length;
      await expect(bridge.requestToolPermission({ toolCall, options })).resolves.toEqual(denied);
      expect(permissionCards(events).length).toBe(before);
    }

    expect(seen).toEqual(['file_write', 'file_write', 'file_write']);
    expect(orchestrator.getPendingPermissionRequests()).toHaveLength(0);
  });
});

describe('requestExternalEnginePermission ignores global auto-approve', () => {
  let orchestrator: AgentOrchestrator;
  let events: AgentEvent[];

  beforeEach(() => {
    resetPermissionModeManager();
    events = [];
    const configService = {
      getSettings: () => ({
        permissions: {
          autoApprove: { read: true, write: true, execute: true, network: true },
          devModeAutoApprove: true,
        },
      }),
      isDevModeAutoApproveEnabled: () => true,
    } as unknown as ConfigService;
    orchestrator = new AgentOrchestrator({
      configService,
      hasApprovalUi: () => true,
      onEvent: (event) => { events.push(event); },
    });
  });

  afterEach(async () => {
    for (const pending of orchestrator.getPendingPermissionRequests()) {
      orchestrator.handlePermissionResponse(pending.id, 'deny');
    }
    await orchestrator.drainWorkspaceServices();
    resetPermissionModeManager();
  });

  function setMode(mode: PermissionMode): void {
    expect(getPermissionModeManager().setSessionMode(SESSION, mode, true)).toBe(true);
  }

  function writeRequest(type: 'file_write' | 'command') {
    return {
      sessionId: SESSION,
      type,
      tool: type === 'command' ? 'acp:terminal/create' : 'acp:fs/write_text_file',
      details: { path: '/tmp/engine-permmode-map.txt', command: type === 'command' ? 'true' : undefined },
    };
  }

  async function expectHumanCard(type: 'file_write' | 'command'): Promise<void> {
    const before = permissionCards(events).length;
    const pending = orchestrator.requestExternalEnginePermission(writeRequest(type));
    await Promise.resolve();
    const cards = permissionCards(events);
    expect(cards.length).toBe(before + 1);
    const card = cards[cards.length - 1];
    if (!card) throw new Error('missing permission_request');
    expect(card.forceConfirm).toBe(true);
    expect(card.type).toBe(type);
    orchestrator.handlePermissionResponse(card.id, 'deny');
    await expect(pending).resolves.toMatchObject({ approved: false, denialSource: 'user' });
  }

  it('acceptEdits, default, and bypassPermissions still raise a card for ACP writes and commands', async () => {
    for (const mode of ['acceptEdits', 'default', 'bypassPermissions'] as const) {
      setMode(mode);
      await expectHumanCard('file_write');
      await expectHumanCard('command');
    }
  });
});
