import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { AppSettings, PermissionAskResult, PermissionRequest } from '../../../src/shared/contract';
import { permissionDenialError } from '../../../src/host/tools/toolPermissionClassification';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyAppGrantsSchema } from '../../../src/host/services/core/database/schemaAppGrants';
import {
  appGrantKey,
  extractComputerTargetApp,
} from '../../../src/host/permissions/computerAppTarget';
import {
  bindAppGrantDatabase,
  listAppGrants,
  matchAppGrant,
  mintAppGrantSession,
  mintAppGrantStanding,
  revokeAppGrant,
} from '../../../src/host/permissions/appGrantStore';
import { resolvePreAskGrant } from '../../../src/host/permissions/preAskGrant';
import { hasNeedsInputForSession, isToolCallAwaitingApproval } from '../../../src/renderer/utils/sessionNeedsInput';

const logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as unknown as Parameters<typeof applySchema>[1];

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  applyAppGrantsSchema(db, logger);
  bindAppGrantDatabase(db, true);
  return db;
}

describe('computer app grant identity', () => {
  it('extracts a target only for computer_use when targetApp is present', () => {
    expect(extractComputerTargetApp('computer_use', { action: 'click', targetApp: ' Notes ' })).toEqual({ name: 'Notes' });
    expect(extractComputerTargetApp('Computer', { action: 'type', targetApp: 'Safari', bundleId: ' com.apple.Safari ' })).toEqual({
      name: 'Safari',
      bundleId: 'com.apple.Safari',
    });
    expect(extractComputerTargetApp('computer_use', { action: 'click' })).toBeNull();
    expect(extractComputerTargetApp('computer_use', { action: 'click', targetApp: '   ' })).toBeNull();
    expect(extractComputerTargetApp('browser_action', { action: 'click', targetApp: 'Notes' })).toBeNull();
  });

  it('keeps the grant key stable under trim and name case', () => {
    const nameKey = appGrantKey({ name: ' Notes ' });
    expect(nameKey).toBe(appGrantKey({ name: 'notes' }));
    expect(nameKey).toBe('name:notes');
    const bundleKey = appGrantKey({ name: 'Notes', bundleId: ' com.apple.Notes ' });
    expect(bundleKey).toBe(appGrantKey({ name: 'Other', bundleId: 'com.apple.Notes' }));
    expect(bundleKey).toBe('bundle:com.apple.Notes');
    expect(bundleKey).not.toBe(nameKey);
  });
});

describe('app grant store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = memoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('matches bundleId when both sides have one, otherwise the trimmed name ignoring case', () => {
    mintAppGrantStanding({ name: 'Safari', bundleId: 'com.apple.Safari' }, 1_700_000_000_000);
    expect(matchAppGrant('s1', { name: 'Safari Browser', bundleId: 'com.apple.Safari' })).toBe(true);
    expect(matchAppGrant('s1', { name: 'safari' })).toBe(true);
    expect(matchAppGrant('s1', { name: 'Safari', bundleId: 'com.apple.Other' })).toBe(false);

    mintAppGrantStanding({ name: ' Notes ' }, 1_700_000_000_001);
    expect(matchAppGrant('s1', { name: 'notes', bundleId: 'com.apple.Notes' })).toBe(true);
  });

  it('does not let a session grant leak to another session or another app', () => {
    mintAppGrantSession('session-a', { name: 'Notes' });
    expect(matchAppGrant('session-a', { name: 'Notes' })).toBe(true);
    expect(matchAppGrant('session-b', { name: 'Notes' })).toBe(false);
    expect(matchAppGrant('session-a', { name: 'Safari' })).toBe(false);
  });

  it('keeps a standing grant across a new session id and a fresh store on the same database', () => {
    mintAppGrantStanding({ name: 'Preview', bundleId: 'com.apple.Preview' }, 1_700_000_000_000);
    mintAppGrantSession('session-a', { name: 'Notes' });
    expect(matchAppGrant('session-b', { name: 'Preview' })).toBe(true);

    bindAppGrantDatabase(db, true);
    expect(matchAppGrant('session-c', { name: 'preview', bundleId: 'com.apple.Preview' })).toBe(true);
    expect(matchAppGrant('session-a', { name: 'Notes' })).toBe(false);
  });

  it('revoke removes the standing grant so the next request asks again', () => {
    mintAppGrantStanding({ name: 'Notes' }, 1_700_000_000_000);
    const key = appGrantKey({ name: 'Notes' });
    expect(listAppGrants().map((row) => row.appKey)).toEqual([key]);
    expect(revokeAppGrant(key)).toBe(true);
    expect(matchAppGrant('later-session', { name: 'Notes' })).toBe(false);
    expect(listAppGrants()).toEqual([]);
  });

  it('applySchema creates the app grant table', () => {
    const full = new Database(':memory:');
    applySchema(full, logger);
    const row = full.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_permission_grants'").get() as { name: string };
    expect(row.name).toBe('app_permission_grants');
    full.close();
  });
});

describe('pre-ask grant does not beat a hard gate', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = memoryDb();
    mintAppGrantStanding({ name: 'Notes' }, 1);
  });

  afterEach(() => {
    db.close();
  });

  it('returns no skip when a forced-confirm gate is set', () => {
    expect(resolvePreAskGrant({
      toolName: 'computer_use',
      sessionId: 's1',
      standingGrantTarget: null,
      computerApp: { name: 'Notes' },
      blocked: true,
    })).toBeNull();
    expect(resolvePreAskGrant({
      toolName: 'computer_use',
      sessionId: 's1',
      standingGrantTarget: null,
      computerApp: { name: 'Notes' },
      blocked: false,
    })).toMatchObject({ ledgerReason: `app_grant:${appGrantKey({ name: 'Notes' })}` });
  });
});

describe('permission denial names the app only for a user denial', () => {
  it('keeps every other denial text byte-identical', () => {
    expect(permissionDenialError('Write', 'user').modelText).toBe('Permission denied by user');
    expect(permissionDenialError('computer_use', 'timeout', { name: 'Notes' }).modelText)
      .toBe(permissionDenialError('computer_use', 'timeout').modelText);
    expect(permissionDenialError('computer_use', 'fail-closed', { name: 'Notes' }).modelText)
      .toBe(permissionDenialError('computer_use', 'fail-closed').modelText);
  });

  it('tells the model the user denied that app and not to retry it', () => {
    const text = permissionDenialError('computer_use', 'user', { name: 'Notes' }).modelText;
    expect(text).toContain('Notes');
    expect(text).toContain('denied');
    expect(text.toLowerCase()).toContain('do not retry');
  });
});

describe('no self grant', () => {
  it('only the human approval resolver calls the mint functions', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts') || name.endsWith('.tsx')) files.push(full);
      }
    };
    walk(path.join(process.cwd(), 'src'));
    const needle = /mintAppGrant(?:Session|Standing)\b/g;
    const hits = files.filter((file) => needle.test(readFileSync(file, 'utf8')));
    expect(hits.map((file) => path.relative(process.cwd(), file)).sort()).toEqual([
      'src/host/agent/orchestratorPermissions.ts',
      'src/host/permissions/appGrantStore.ts',
    ]);
  });
});

describe('sidebar waiting marker', () => {
  it('treats a pending computer_use approval as waiting for approval', () => {
    const request = {
      id: 'perm-computer',
      tool: 'computer_use',
      parentToolUseId: 'tool-call-1',
      sessionId: 'session-computer',
      details: { targetApp: { name: 'Notes' } },
    } as PermissionRequest;
    expect(hasNeedsInputForSession('session-computer', {
      permissionState: {
        pendingPermissionRequest: request,
        pendingPermissionSessionId: 'session-computer',
      },
    })).toBe(true);
    expect(isToolCallAwaitingApproval('tool-call-1', 'session-computer', {
      pendingPermissionRequest: request,
      pendingPermissionSessionId: 'session-computer',
    })).toBe(true);
    expect(hasNeedsInputForSession('session-other', {
      permissionState: {
        pendingPermissionRequest: request,
        pendingPermissionSessionId: 'session-computer',
      },
    })).toBe(false);
  });
});

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

describe('orchestrator mints app grants from the human response', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = memoryDb();
  });

  afterEach(async () => {
    db.close();
    const { getConfirmationGate } = await import('../../../src/host/agent/confirmationGate');
    getConfirmationGate().updateConfig({ policy: 'ask_if_dangerous' });
    const { resetPermissionModeManager } = await import('../../../src/host/permissions/modes');
    resetPermissionModeManager();
  });

  async function respond(response: 'allow_session' | 'allow_standing' | 'allow', parked: boolean) {
    const { OrchestratorPermissionIsland } = await import('../../../src/host/agent/orchestratorPermissions');
    const { getConfirmationGate } = await import('../../../src/host/agent/confirmationGate');
    const { getPermissionModeManager, resetPermissionModeManager } = await import('../../../src/host/permissions/modes');
    resetPermissionModeManager();
    const gate = getConfirmationGate();
    gate.updateConfig({ policy: 'session_approve' });
    gate.clearSessionApprovals('session-notes');
    const events: { type: string; data: { id: string } }[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: settings,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => (parked ? 'async_agent' : 'main'),
      hasApprovalUi: () => true,
      onEvent: (event) => events.push(event as { type: string; data: { id: string } }),
      injectedPendingApprovalRepo: parked
        ? { insert: vi.fn(), resolve: vi.fn(() => 1) } as never
        : undefined,
    });
    if (parked) getPermissionModeManager().markUnattendedSession('session-notes');
    const promise = island.requestPermission({
      type: 'command',
      tool: 'computer_use',
      sessionId: 'session-notes',
      details: { targetApp: { name: 'Notes', bundleId: 'com.apple.Notes' } },
    });
    const request = events.find((event) => event.type === 'permission_request');
    if (!request) throw new Error('no permission request');
    expect(island.handlePermissionResponse(request.data.id, response)).toBe('delivered');
    const result = await promise as PermissionAskResult;
    return { result, gate };
  }

  it('allow_session records an app grant and does not approve the tool for another app', async () => {
    const { result, gate } = await respond('allow_session', false);
    expect(result).toEqual({ approved: true, approvalSource: 'user' });
    expect(matchAppGrant('session-notes', { name: 'Notes' })).toBe(true);
    expect(matchAppGrant('session-notes', { name: 'Safari' })).toBe(false);
    expect(gate.shouldConfirm({
      toolName: 'computer_use',
      params: { targetApp: 'Safari' },
      riskLevel: 'low',
    }, 'session-notes')).toBe(true);
    gate.updateConfig({ policy: 'ask_if_dangerous' });
  });

  it('allow_standing mints a persistent grant with no automation', async () => {
    const { result, gate } = await respond('allow_standing', false);
    expect(result.approved).toBe(true);
    expect(matchAppGrant('brand-new-session', { name: 'Notes', bundleId: 'com.apple.Notes' })).toBe(true);
    expect(listAppGrants()).toHaveLength(1);
    gate.updateConfig({ policy: 'ask_if_dangerous' });
  });

  it('a parked allow_standing also mints the app grant', async () => {
    const { result, gate } = await respond('allow_standing', true);
    expect(result.approved).toBe(true);
    expect(matchAppGrant('after-park', { name: 'notes' })).toBe(true);
    gate.updateConfig({ policy: 'ask_if_dangerous' });
  });

  it('a plain allow stays one-time', async () => {
    const { result, gate } = await respond('allow', false);
    expect(result.approved).toBe(true);
    expect(matchAppGrant('session-notes', { name: 'Notes' })).toBe(false);
    expect(listAppGrants()).toEqual([]);
    gate.updateConfig({ policy: 'ask_if_dangerous' });
  });
});
