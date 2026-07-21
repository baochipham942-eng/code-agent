import { describe, expect, it, vi } from 'vitest';

const buildRoleContextBlock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock,
}));

import { buildCronAgentRunOptions } from '../../../src/host/cron/cronAgentRoleContext';

describe('buildCronAgentRunOptions', () => {
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
});
