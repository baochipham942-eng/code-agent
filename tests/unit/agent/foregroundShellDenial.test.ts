// N-FIX-NL-RULE-ASK-BASH-SILENT-ABORT：Bash 被本轮工具面收掉时必须留下可区分日志 + 人话终态，
// 不能是「Bash is disabled」式无原因中断。规则经 loadUserRules 真实装载（translator 同款规则串）。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

import { describeDeniedShellCalls } from '../../../src/host/agent/runtime/foregroundShellDenial';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { buildRuleString } from '../../../src/shared/permissionRuleTranslate';

const ctx = { sessionId: 'fg-shell' } as unknown as RuntimeContext;

describe('describeDeniedShellCalls', () => {
  beforeAll(() => { getProtocolRegistry(); });
  beforeEach(() => { resetPolicyEngine(); warn.mockClear(); });
  afterEach(() => resetPolicyEngine());

  it('Bash 被收出工具面 + 用户有 Bash(rm *) ask 规则：warn 带原因与规则 id，给出人话终态', () => {
    getPolicyEngine().loadUserRules({ ask: [buildRuleString({ tool: 'Bash', pattern: 'rm *' })] }, 'user-ui');
    const out = describeDeniedShellCalls(ctx, [{ name: 'Bash' }]);
    expect(out?.finalMessage).toContain('命令没有运行');
    expect(out?.guidance).toContain('NOT run');
    expect(out?.guidance).not.toMatch(/Bash is disabled/i);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Bash call dropped before approval'), expect.objectContaining({
      cause: 'tool-not-in-run-toolset',
      userBashRules: ['user-prompt-Bash(rm *)'],
    }));
  });

  it('非 Bash 工具被禁不触发本交代', () => {
    expect(describeDeniedShellCalls(ctx, [{ name: 'AskUserQuestion' }])).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
