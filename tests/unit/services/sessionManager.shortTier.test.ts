import { describe, expect, it, vi } from 'vitest';

const createSessionRow = vi.fn();
vi.mock('../../../src/host/services/core', () => ({
  getDatabase: () => ({ createSession: createSessionRow, logAuditEvent: vi.fn() }),
}));
vi.mock('../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({ ensureProjectForWorkspace: async () => ({ id: 'proj-1' }) }),
}));

import { getSessionManager } from '../../../src/host/services/infra/sessionManager';
import { resolveForegroundTimeoutTier } from '../../../src/host/tools/shell/foregroundTier';

describe('session origin → foreground timeout tier', () => {
  it('channel, cron (role-wake) and heartbeat sessions resolve to short; desktop chat stays interactive', async () => {
    const manager = getSessionManager();
    const make = (origin?: { kind: 'channel' | 'cron' | 'heartbeat'; name?: string }) =>
      manager.createSession({ title: 't', modelConfig: {} as never, workingDirectory: process.cwd(), origin });
    const channel = await make({ kind: 'channel', name: 'feishu' });
    const cron = await make({ kind: 'cron', name: 'role-wake' });
    const heartbeat = await make({ kind: 'heartbeat' });
    const desktop = await make();
    expect(resolveForegroundTimeoutTier(channel.id)).toBe('short');
    expect(resolveForegroundTimeoutTier(cron.id)).toBe('short');
    expect(resolveForegroundTimeoutTier(heartbeat.id)).toBe('short');
    expect(resolveForegroundTimeoutTier(desktop.id)).toBe('interactive');
  });
});
