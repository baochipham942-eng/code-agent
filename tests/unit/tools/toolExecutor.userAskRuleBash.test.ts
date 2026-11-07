// N-FIX-NL-RULE-ASK-BASH-SILENT-ABORT：用户「Bash(rm *) → ask」规则必须走审批通道，
// 不得被自动放行捷径吞掉，也不得变成静默中断 / tool-disabled。规则串用 translator 同款
// buildRuleString 构造，经 loadUserRules 真实装载（不手搓 PolicyEngine mock）。

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { buildRuleString } from '../../../src/shared/permissionRuleTranslate';

const ASK_RULE = buildRuleString({ tool: 'Bash', pattern: 'rm *' });

describe('用户 Bash(rm *) ask 规则 → 审批通道', () => {
  let dir: string;
  let target: string;
  let requests: PermissionRequestData[];

  beforeAll(() => {
    getProtocolRegistry();
  });
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join('/tmp', 'ask-rule-bash-'));
    target = path.join(dir, 'x.txt');
    await fs.writeFile(target, 'x');
    requests = [];
    resetPolicyEngine();
    resetPermissionModeManager();
    getToolCache().clear();
    getPolicyEngine().loadUserRules({ ask: [ASK_RULE] }, 'user-ui');
  });
  afterEach(async () => {
    resetPolicyEngine();
    resetPermissionModeManager();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const exists = () => fs.access(target).then(() => true, () => false);

  const makeExecutor = (answer: boolean, workingDirectory: string) => {
    const e = new ToolExecutor({
      workingDirectory,
      requestPermission: async (request) => {
        requests.push(request);
        return answer;
      },
    });
    e.setAuditEnabled(false);
    return e;
  };

  it('ask 规则串形态 = Bash(rm *)', () => {
    expect(ASK_RULE).toBe('Bash(rm *)');
  });

  it.each([
    ['default', 'workspace'],
    ['default', 'no-workspace'],
    ['acceptEdits', 'workspace'],
    ['bypassPermissions', 'workspace'],
  ] as const)('%s / %s：批准 → 走审批通道且命令只执行一次', async (mode, ws) => {
    const modes = getPermissionModeManager();
    const previous = modes.getEffectiveMode();
    const ok = mode === 'default' ? true : modes.setMode(mode, true);
    try {
      if (!ok) return;
      const result = await makeExecutor(true, ws === 'workspace' ? dir : path.join(dir, 'missing-workdir'))
        .execute('Bash', { command: `rm ${target}` }, { sessionId: `ask-${mode}-${ws}` });
      expect(requests).toHaveLength(1);
      // 工作目录不存在时审批后 spawn 才失败（另一层，非本单范围）；这里只钉审批通道。
      if (ws === 'workspace') {
        expect(result.success).toBe(true);
        expect(await exists()).toBe(false);
      }
    } finally {
      modes.setMode(previous, true);
    }
  });

  it('拒绝 → 带原因的 denied 结果，不是 tool-disabled，文件仍在', async () => {
    const result = await makeExecutor(false, dir).execute('Bash', { command: `rm ${target}` }, { sessionId: 'ask-deny' });
    expect(requests).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.error ?? '').not.toMatch(/disabled|TOOL_DISABLED/i);
    expect(result.error ?? '').toMatch(/denied|declined|permission/i);
    expect(await exists()).toBe(true);
  });

  it('不匹配 ask 规则的命令不被它拦（echo 仍按原链）', async () => {
    const result = await makeExecutor(true, dir).execute('Bash', { command: 'echo hi' }, { sessionId: 'ask-echo' });
    expect(result.success).toBe(true);
  });
});
