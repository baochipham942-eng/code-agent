// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';

const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const appState = { activeAgentId: 'muzhi', openExpertRoleDetail: vi.fn() };
const swarmState = { agents: [], activeSessionId: undefined };
const sessionState = { sessions: [{ id: 'session-1', title: '产品诊断' }] };

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/services/rolesClient', () => ({ listRoles: () => listRoles() }));
vi.mock('../../../src/renderer/stores/appStore', () => ({ useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState) }));
vi.mock('../../../src/renderer/stores/swarmStore', () => ({ useSwarmStore: (selector: (state: typeof swarmState) => unknown) => selector(swarmState) }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({ useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState) }));

import { SessionAgentIdentityBar } from '../../../src/renderer/components/features/expert/SessionAgentIdentityBar';

describe('SessionAgentIdentityBar', () => {
  beforeEach(() => {
    appState.activeAgentId = 'muzhi';
    listRoles.mockResolvedValue([{ roleId: 'muzhi', displayName: '牧之', profession: '资深产品经理', description: '', source: 'builtin', memoryCount: 0, lastWork: null }]);
  });
  afterEach(() => cleanup());

  it('已绑定专家显示花名、职业与首字头像', async () => {
    render(<SessionAgentIdentityBar sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('session-agent-identity')).toBeTruthy());
    expect(screen.getByText('资深产品经理')).toBeTruthy();
    expect(screen.getByTestId('role-initial-avatar-muzhi').textContent).toBe('牧');
  });

  it('普通未绑定会话不渲染身份条', async () => {
    appState.activeAgentId = null as unknown as string;
    render(<SessionAgentIdentityBar sessionId="session-1" />);
    await Promise.resolve();
    expect(screen.queryByTestId('session-agent-identity')).toBeNull();
  });
});
