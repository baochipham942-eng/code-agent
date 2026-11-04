// ============================================================================
// 保存 permissions.nlRules 必须立即装载进 PolicyEngine（N-PERM-NL-RULES-K2 r2）
// 真机 web 构建复现：只写 nlRules（一句话规则卡的保存路径）时，config.json 已落盘，
// 但引擎里 nlRules=0，规则要等重启才生效——handback/preapprove 整条链路形同虚设。
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ConfigService.updateSettings：只改 nlRules 也要重载规则', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'neo-nlrules-reload-'));
    vi.stubEnv('CODE_AGENT_DATA_DIR', join(root, 'env-data'));
    vi.stubEnv('CODE_AGENT_LOG_DIR', join(root, 'logger-sink'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('updateSettings({permissions:{nlRules}}) → 引擎立刻按该规则判 handback', async () => {
    const { ConfigService } = await import('../../../../src/host/services/core/configService');
    const { getPolicyEngine } = await import('../../../../src/host/permissions/policyEngine');
    const service = new ConfigService() as unknown as {
      configPath: string;
      updateSettings: (u: unknown) => Promise<void>;
    };
    service.configPath = join(root, 'data', 'config.json');
    await service.updateSettings({
      permissions: { nlRules: [{ behavior: 'handback', rule: 'Bash(rm *)' }] },
    });
    const matched = getPolicyEngine().matchUserRules(
      { tool: 'Bash', level: 'execute', description: 'x', command: 'rm /tmp/a' },
    );
    expect(matched.some((rule) => rule.userNlRule?.behavior === 'handback')).toBe(true);
  });
});
