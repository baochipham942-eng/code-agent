import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildRoleContextBlock = vi.hoisted(() => vi.fn());
const runtimeRole = vi.hoisted(() => ({ value: undefined as undefined | { id: string; tools: string[] } }));
const resolveRoleToolBoundary = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock,
}));
vi.mock('../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: () => runtimeRole.value,
}));
vi.mock('../../../src/host/services/roleAssets/rolePersonalization', () => ({
  resolveRoleToolBoundary,
}));

import { buildCronAgentRunOptions } from '../../../src/host/cron/cronAgentRoleContext';

describe('buildCronAgentRunOptions', () => {
  beforeEach(() => {
    buildRoleContextBlock.mockReset();
    resolveRoleToolBoundary.mockReset().mockReturnValue(null);
    runtimeRole.value = undefined;
  });

  it('returns undefined without a roleId and does not resolve role assets', async () => {
    expect(await buildCronAgentRunOptions(undefined, '/workspace')).toBeUndefined();
    expect(buildRoleContextBlock).not.toHaveBeenCalled();
  });

  it('injects persistent role L0 and L1 context', async () => {
    buildRoleContextBlock.mockResolvedValue('## 角色记忆索引\\n...');

    await expect(buildCronAgentRunOptions('muzhi', '/workspace')).resolves.toEqual({
      mode: 'normal',
      agentOverrideId: 'muzhi',
      turnSystemContext: ['## 角色记忆索引\\n...'],
    });
    expect(buildRoleContextBlock).toHaveBeenCalledWith('muzhi', '/workspace');
  });

  it('falls back to the default agent when the persistent role cannot be resolved', async () => {
    buildRoleContextBlock.mockResolvedValue(null);

    await expect(buildCronAgentRunOptions('deleted-role', '/workspace')).resolves.toBeUndefined();
  });

  it('passes the translated tool allowlist into the actual cron run options', async () => {
    buildRoleContextBlock.mockResolvedValue('## 常驻边界\n只起草不发送');
    runtimeRole.value = { id: 'mailer', tools: ['mail_draft', 'mail_send'] };
    resolveRoleToolBoundary.mockReturnValue({
      boundaryText: '只起草不发送',
      allowedTools: ['mail_draft'],
      blockedTools: ['mail_send'],
    });

    await expect(buildCronAgentRunOptions('mailer', '/workspace')).resolves.toEqual({
      mode: 'normal',
      agentOverrideId: 'mailer',
      turnSystemContext: ['## 常驻边界\n只起草不发送'],
      allowedToolNames: ['mail_draft'],
    });
  });
});
