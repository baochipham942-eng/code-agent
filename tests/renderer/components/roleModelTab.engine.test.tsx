// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEngineDescriptor } from '../../../src/shared/contract/agentEngine';
import type { RolePanelDetail } from '../../../src/shared/contract/roleAssets';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const domainInvoke = vi.fn();
const invokeDomain = vi.fn();
const originalDomainAPI = window.domainAPI;

// RoleDetailPage 链路走 ipcService；RoleModelTab 直连 window.domainAPI。
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    on: () => () => {},
  },
}));

import { RoleModelTab } from '../../../src/renderer/components/features/expert/RoleModelTab';
import { RoleDetailPage } from '../../../src/renderer/components/features/expert/RoleDetailPage';

type Equipment = NonNullable<RolePanelDetail['equipment']>;

function makeEquipment(overrides: Partial<Equipment> = {}): Equipment {
  return {
    skills: ['research'],
    tools: ['Read'],
    model: 'balanced',
    maxIterations: 20,
    availableSkills: ['research'],
    availableTools: ['Read'],
    ...overrides,
  };
}

function makeDescriptor(overrides: Partial<AgentEngineDescriptor> = {}): AgentEngineDescriptor {
  return {
    manifestId: 'codex_cli',
    kind: 'codex_cli',
    label: 'Codex CLI',
    summary: '',
    installState: 'installed',
    runtimeState: 'ready',
    executable: true,
    capabilities: ['execute'],
    defaultPermissionProfile: 'read_only',
    cwdPolicy: 'workspace_only',
    riskTier: 'medium',
    detectedAt: 0,
    modelSelection: 'runtime_catalog',
    ...overrides,
  };
}

function mockEngineList(descriptors: AgentEngineDescriptor[] | Error) {
  domainInvoke.mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.AGENT_ENGINE && action === 'list') {
      return descriptors instanceof Error
        ? Promise.reject(descriptors)
        : Promise.resolve({ success: true, data: descriptors });
    }
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
      return Promise.resolve({ success: true, data: null });
    }
    return Promise.resolve({ success: false });
  });
}

beforeEach(() => {
  Object.defineProperty(window, 'domainAPI', {
    configurable: true,
    value: { invoke: domainInvoke },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(window, 'domainAPI', { configurable: true, value: originalDomainAPI });
});

describe('RoleModelTab 引擎行', () => {
  it('ready 的外部引擎可点；missing / 未就绪的灰显并带原因', async () => {
    mockEngineList([
      makeDescriptor({ manifestId: 'codex_cli', kind: 'codex_cli', label: 'Codex CLI' }),
      makeDescriptor({ manifestId: 'claude_code', kind: 'claude_code', label: 'Claude Code', installState: 'missing', executable: false, runtimeState: 'unknown' }),
      // 装了但运行态没就绪：只认 runtimeState==='ready'，这条是反向变异的锚点。
      makeDescriptor({ manifestId: 'mimo_code', kind: 'mimo_code', label: 'MiMo-Code', runtimeState: 'error', lastError: 'probe boom\nsecond line' }),
    ]);
    render(<RoleModelTab equipment={makeEquipment()} onSave={vi.fn().mockResolvedValue(undefined)} />);

    await waitFor(() => {
      expect((screen.getByTestId('role-model-engine-codex_cli') as HTMLButtonElement).disabled).toBe(false);
    });
    const claude = screen.getByTestId('role-model-engine-claude_code') as HTMLButtonElement;
    expect(claude.disabled).toBe(true);
    expect(claude.textContent).toContain('本机未安装');
    const mimo = screen.getByTestId('role-model-engine-mimo_code') as HTMLButtonElement;
    expect(mimo.disabled).toBe(true);
    expect(mimo.textContent).toContain('probe boom');
    // 显示名只取 manifest label / i18n，不出现 kind 标识符。
    expect(screen.getByTestId('role-model-engine').textContent).toContain('Codex CLI');
    expect(screen.getByTestId('role-model-engine').textContent).toContain('Neo 原生');
    expect(screen.getByTestId('role-model-engine').textContent).not.toContain('codex_cli');
  });

  it('当前值高亮：equipment.engine 缺省选中 Neo 原生，显式值选中对应引擎', async () => {
    mockEngineList([makeDescriptor()]);
    const { unmount } = render(<RoleModelTab equipment={makeEquipment()} onSave={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => {
      expect(screen.getByTestId('role-model-engine-native').getAttribute('aria-pressed')).toBe('true');
    });
    unmount();

    render(<RoleModelTab equipment={makeEquipment({ engine: 'codex_cli' })} onSave={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => {
      expect(screen.getByTestId('role-model-engine-codex_cli').getAttribute('aria-pressed')).toBe('true');
    });
    expect(screen.getByTestId('role-model-engine-native').getAttribute('aria-pressed')).toBe('false');
  });

  it('点选 ready 的外部引擎，onSave 收到 engine kind', async () => {
    mockEngineList([makeDescriptor()]);
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RoleModelTab equipment={makeEquipment()} onSave={onSave} />);

    await waitFor(() => {
      expect((screen.getByTestId('role-model-engine-codex_cli') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('role-model-engine-codex_cli'));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({ model: 'balanced', modelOverride: null, engine: 'codex_cli' });
    });
  });

  it('描述符取不到时 fail-closed：除 Neo 原生外全部灰显「状态未知」', async () => {
    mockEngineList(new Error('ipc down'));
    render(<RoleModelTab equipment={makeEquipment()} onSave={vi.fn().mockResolvedValue(undefined)} />);

    await waitFor(() => {
      expect((screen.getByTestId('role-model-engine-codex_cli') as HTMLButtonElement).disabled).toBe(true);
    });
    expect(screen.getByTestId('role-model-engine-codex_cli').textContent).toContain('状态未知');
    expect((screen.getByTestId('role-model-engine-claude_code') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('role-model-engine-native') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('RoleDetailPage 其他 tab 保存不冲掉 engine', () => {
  function makeRoleDetail(overrides: Partial<RolePanelDetail> = {}): RolePanelDetail {
    return {
      roleId: '牧之',
      definition: '---\nname: 牧之\nengine: codex_cli\n---\n你是产品专家',
      definitionPath: '/roles/牧之.md',
      memories: [],
      history: [],
      proactivity: { level: 'silent' },
      visual: { displayName: '牧之', profession: '资深产品经理', icon: 'ClipboardList', category: 'product', tags: [], quickPrompts: [] },
      isBuiltin: true,
      personalization: { userExpectation: '', soul: '', boundaries: { disallowExternalSending: false } },
      equipment: makeEquipment({ engine: 'codex_cli' }),
      ...overrides,
    };
  }

  it('技能页保存 payload 不带 engine 键（宿主 undefined=保留 frontmatter 现值）', async () => {
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'detail') return Promise.resolve(makeRoleDetail());
      if (action === 'listBoundCronJobs' || action === 'listBindings') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<RoleDetailPage roleId="牧之" />);
    fireEvent.click(await screen.findByTestId('role-detail-tab-skills'));
    fireEvent.click(await screen.findByTestId('role-equipment-save'));

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.ROLES,
        'updateEquipment',
        expect.objectContaining({ roleId: '牧之' }),
      );
    });
    const call = invokeDomain.mock.calls.find(([, action]) => action === 'updateEquipment');
    const payload = (call?.[2] as { equipment: Record<string, unknown> }).equipment;
    expect('engine' in payload).toBe(false);
    expect(payload.model).toBe('balanced');
  });
});
