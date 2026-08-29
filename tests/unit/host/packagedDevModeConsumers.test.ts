import { beforeEach, describe, expect, it, vi } from 'vitest';

const authService = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  hasVerifiedSession: vi.fn(),
}));

vi.mock('../../../src/host/services/auth', () => ({
  getAuthService: () => authService,
}));

import { isCurrentUserAdmin } from '../../../src/host/ipc/adminGuard';
import { resolveUpstreamUrlOverride } from '../../../src/host/services/voice/realtimeUpstream';

describe('packaged dev mode host consumers', () => {
  beforeEach(() => {
    authService.getCurrentUser.mockReturnValue(null);
    authService.hasVerifiedSession.mockReturnValue(false);
  });

  it('does not grant local admin or replace the voice upstream in a packaged shell', () => {
    const env = {
      CODE_AGENT_WEB_MODE: 'true',
      CODE_AGENT_ENABLE_DEV_API: 'true',
      CODE_AGENT_TAURI_BOOT_TOKEN: 'boot-token',
      CODE_AGENT_VOICE_UPSTREAM_URL_OVERRIDE: 'ws://127.0.0.1:9999/realtime',
    } as NodeJS.ProcessEnv;

    expect(isCurrentUserAdmin(env)).toBe(false);
    expect(resolveUpstreamUrlOverride('wss://voice.example/realtime?model=live', env))
      .toBe('wss://voice.example/realtime?model=live');
  });

  it('preserves non-packaged dev admin and voice override behavior', () => {
    const env = {
      CODE_AGENT_WEB_MODE: 'true',
      CODE_AGENT_ENABLE_DEV_API: 'true',
      CODE_AGENT_VOICE_UPSTREAM_URL_OVERRIDE: 'ws://127.0.0.1:9999/realtime',
    } as NodeJS.ProcessEnv;

    expect(isCurrentUserAdmin(env)).toBe(true);
    expect(resolveUpstreamUrlOverride('wss://voice.example/realtime?model=live', env))
      .toBe('ws://127.0.0.1:9999/realtime?model=live');
  });
});
