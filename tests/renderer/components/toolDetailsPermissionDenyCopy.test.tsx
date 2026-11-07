// ============================================================================
// 用户 deny 规则 / 内置安全规则硬拒 / ask 拒绝（真人点拒审批）的人话卡片
// （N-FIX-PERM-DENY-ENGLISH-COPY）
// ----------------------------------------------------------------------------
// hermetic-protocol：renderer 测试里起**真实 ToolExecutor**（用户 deny 规则 / 内置
// block-ssh-keys 两条硬拒路径，规则名取自 policyEngine 真源；ask 拒绝路径让审批
// 回调回 false = 真人拒绝），拿真实执行结果（error + metadata.hostReason）喂
// humanizeToolError / humanizeToolFailureReason，并 zh/en 各渲染一遍 ToolDetails。
// 钉死：登记表文案上卡、英文原句不漏、结构化 hostReason 路径不出「查看原始报错」
// 开关；executor 不透传 hostReason 时整链变红。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

// ToolDetails 依赖 appStore 的两个 selector，mock 掉即可（同 toolDetailsHighlight.test.tsx）。
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openPreview: vi.fn(),
      openSettingsTab: vi.fn(),
    }),
}));

// useI18n 按测试内设置的语言出 zh/en（同 turnDiffSummary.confirmation.test.tsx 的 mock 先例）。
const i18nState = vi.hoisted(() => ({ lang: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh: zhTable } = await import('../../../src/renderer/i18n/zh');
  const { en: enTable } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => (i18nState.lang === 'en'
      ? { t: enTable, language: 'en' }
      : { t: zhTable, language: 'zh' }),
  };
});

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { ToolExecutionResult } from '../../../src/host/tools/types';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import { HostReasonCode } from '../../../src/shared/contract/permission';
import type { ToolCall } from '../../../src/shared/contract/tool';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';
import {
  humanizeToolError,
  humanizeToolFailureReason,
} from '../../../src/renderer/utils/toolExecutionPresentation';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';

/**
 * 真实 executor 硬拒结果：工作区临时目录 + 审批回调一叫就炸（硬拒必须发生在审批之前）。
 * 传 requestPermission 覆盖时走 ask 路径（回调回 false = 真人点拒）。
 * 返回的 { error, metadata } 与 toolExecutor 拒绝出口逐字段一致。
 */
async function executeRealDeny(
  tool: string,
  params: Record<string, unknown>,
  requestPermission: () => Promise<boolean> = async () => {
    throw new Error('硬拒发生在审批之前，审批回调不该被叫起');
  },
): Promise<ToolExecutionResult> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'perm-deny-copy-'));
  try {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission,
    });
    executor.setAuditEnabled(false);
    return await executor.execute(tool, params, { sessionId: 'perm-deny-copy' });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

/** 真实执行结果包成 ToolCall（ToolDetails / humanizeToolFailureReason 的入参形状）。 */
function asToolCall(id: string, name: string, args: Record<string, unknown>, result: ToolExecutionResult): ToolCall {
  return { id, name, arguments: args, result } as unknown as ToolCall;
}

describe('用户 deny 规则硬拒的人话卡片（真实 executor 结果）', () => {
  let userDenyResult: ToolExecutionResult;

  beforeAll(() => {
    getProtocolRegistry();
  });
  beforeEach(() => {
    resetPolicyEngine();
    resetPermissionModeManager();
    getToolCache().clear();
    getPolicyEngine().loadUserRules({ deny: ['Write'] }, 'user-ui');
  });
  afterEach(() => {
    resetPolicyEngine();
    resetPermissionModeManager();
  });

  const runOnce = async () => {
    userDenyResult = await executeRealDeny('Write', { file_path: '/usr/bin/neo-probe', content: 'x' });
    expect(userDenyResult.success).toBe(false);
    // 夹具就是真实串：规则名 User deny: Write 来自 policyEngine（loadUserRules 的命名）。
    expect(userDenyResult.error).toContain('Blocked by your permission deny rule (User deny: Write)');
    expect(userDenyResult.metadata?.hostReason).toMatchObject({ code: HostReasonCode.PermissionDeniedUserRule });
  };

  it('zh：header 与展开卡说清是谁拦的、没执行、去哪改规则，英文原句不出现', async () => {
    await runOnce();
    const humanized = humanizeToolError(userDenyResult.error, 'Write', zh, userDenyResult.metadata);
    expect(humanized?.summary).toContain('被你设置的权限规则拦下了，没有执行');
    expect(humanized?.detail).toContain('用户级权限规则');
    expect(humanized?.detail).toContain('重新发起');
    expect(`${humanized?.summary ?? ''}${humanized?.detail ?? ''}`)
      .not.toMatch(/Blocked by|denied by the user|do not retry/i);

    const reason = humanizeToolFailureReason(asToolCall('t', 'Write', {}, userDenyResult), zh);
    expect(reason).toContain('用户级权限规则');
    expect(reason).not.toMatch(/Blocked by|denied by/i);
  });

  it('en：same wording contract, no CJK leaks into the English card', async () => {
    await runOnce();
    const humanized = humanizeToolError(userDenyResult.error, 'Write', en, userDenyResult.metadata);
    expect(humanized?.summary).toContain('was blocked by one of your permission rules and was not run');
    expect(humanized?.detail).toContain('User-level permission rules');
    expect(`${humanized?.summary ?? ''}${humanized?.detail ?? ''}`).not.toMatch(/[\u4e00-\u9fff]/);

    const reason = humanizeToolFailureReason(asToolCall('t', 'Write', {}, userDenyResult), en);
    expect(reason).toContain('User-level permission rules');
    expect(reason).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('zh ToolDetails：登记表文案上卡，无英文原句、无「查看原始报错」开关', async () => {
    await runOnce();
    i18nState.lang = 'zh';
    const markup = renderToStaticMarkup(React.createElement(ToolDetails, {
      toolCall: asToolCall('perm-deny-user-rule', 'Write', { file_path: '/etc/hosts', content: 'x' }, userDenyResult),
    }));
    expect(markup).toContain('被你设置的权限规则拦下了，没有执行');
    expect(markup).toContain('用户级权限规则');
    expect(markup).not.toContain('Blocked by your permission deny rule');
    expect(markup).not.toContain("denied by the user's settings");
    expect(markup).not.toContain('查看原始报错');
  });

  it('en ToolDetails：registered copy renders, raw error hidden, no CJK', async () => {
    await runOnce();
    i18nState.lang = 'en';
    const markup = renderToStaticMarkup(React.createElement(ToolDetails, {
      toolCall: asToolCall('perm-deny-user-rule', 'Write', { file_path: '/etc/hosts', content: 'x' }, userDenyResult),
    }));
    expect(markup).toContain('was blocked by one of your permission rules and was not run');
    expect(markup).toContain('User-level permission rules');
    expect(markup).not.toContain('Blocked by your permission deny rule');
    expect(markup).not.toContain('View original error');
    expect(markup).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('内置安全规则硬拒的人话卡片（真实 executor 结果）', () => {
  let safetyResult: ToolExecutionResult;

  beforeAll(() => {
    getProtocolRegistry();
  });
  beforeEach(() => {
    resetPolicyEngine();
    resetPermissionModeManager();
    getToolCache().clear();
  });
  afterEach(() => {
    resetPolicyEngine();
    resetPermissionModeManager();
  });

  // 只读探测不落盘：deny 发生在任何文件访问之前（同 guardFabricGate.builtinDeny 的 executor 用例）。
  const sshProbe = () => path.join(os.homedir(), '.ssh', 'id_rsa');
  const runOnce = async () => {
    safetyResult = await executeRealDeny('Read', { file_path: sshProbe() });
    expect(safetyResult.success).toBe(false);
    expect(safetyResult.error).toContain('Blocked by built-in safety rule (Block SSH key access)');
    expect(safetyResult.metadata?.hostReason).toMatchObject({ code: HostReasonCode.PermissionDeniedSafetyRule });
  };

  it('zh：说清是 Neo 的内置安全底线、没执行、给出替代出路', async () => {
    await runOnce();
    const humanized = humanizeToolError(safetyResult.error, 'Read', zh, safetyResult.metadata);
    expect(humanized?.summary).toContain('触碰了 Neo 的内置安全底线，已被拦截，没有执行');
    expect(humanized?.detail).toContain('工作文件夹内操作');
    expect(`${humanized?.summary ?? ''}${humanized?.detail ?? ''}`)
      .not.toMatch(/Blocked by built-in|Do not retry|workspace\/project/i);

    const reason = humanizeToolFailureReason(asToolCall('t', 'Read', {}, safetyResult), zh);
    expect(reason).toContain('不会代做');
    expect(reason).toContain('工作文件夹内操作');
    expect(reason).not.toMatch(/Blocked by built-in/i);
  });

  it('en：same wording contract, no CJK leaks into the English card', async () => {
    await runOnce();
    const humanized = humanizeToolError(safetyResult.error, 'Read', en, safetyResult.metadata);
    expect(humanized?.summary).toContain('built-in safety rules and was blocked; it did not run');
    expect(humanized?.detail).toContain('workspace folder instead');
    expect(`${humanized?.summary ?? ''}${humanized?.detail ?? ''}`).not.toMatch(/[\u4e00-\u9fff]/);

    const reason = humanizeToolFailureReason(asToolCall('t', 'Read', {}, safetyResult), en);
    expect(reason).toContain('workspace folder instead');
    expect(reason).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('zh ToolDetails：登记表文案上卡，无英文原句、无「查看原始报错」开关', async () => {
    await runOnce();
    i18nState.lang = 'zh';
    const markup = renderToStaticMarkup(React.createElement(ToolDetails, {
      toolCall: asToolCall('perm-deny-safety-rule', 'Read', { file_path: sshProbe() }, safetyResult),
    }));
    expect(markup).toContain('触碰了 Neo 的内置安全底线，已被拦截，没有执行');
    expect(markup).toContain('工作文件夹内操作');
    expect(markup).not.toContain('Blocked by built-in safety rule');
    expect(markup).not.toContain('SSH private key access is not allowed');
    expect(markup).not.toContain('查看原始报错');
  });

  it('en ToolDetails：registered copy renders, raw error hidden, no CJK', async () => {
    await runOnce();
    i18nState.lang = 'en';
    const markup = renderToStaticMarkup(React.createElement(ToolDetails, {
      toolCall: asToolCall('perm-deny-safety-rule', 'Read', { file_path: sshProbe() }, safetyResult),
    }));
    // markup 里撇号被转义成 &#x27;，断言避开撇号本体。
    expect(markup).toContain('built-in safety rules and was blocked; it did not run');
    expect(markup).toContain('workspace folder instead');
    expect(markup).not.toContain('Blocked by built-in safety rule');
    expect(markup).not.toContain('View original error');
    expect(markup).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('ask 拒绝（真人点拒审批卡）的人话卡片（真实 executor 结果）', () => {
  let askDeniedResult: ToolExecutionResult;
  let approvalAsked: number;

  beforeAll(() => {
    getProtocolRegistry();
  });
  beforeEach(() => {
    resetPolicyEngine();
    resetPermissionModeManager();
    getToolCache().clear();
    approvalAsked = 0;
  });
  afterEach(() => {
    resetPolicyEngine();
    resetPermissionModeManager();
  });

  // 写 $HOME 下（工作区外、不在任何硬拒名单）→ 真实走到审批；审批回调回裸 false =
  // 真人点拒（旧契约语义：bare boolean false 记 denialSource 'user'）。
  const runOnce = async () => {
    askDeniedResult = await executeRealDeny(
      'Write',
      { file_path: path.join(os.homedir(), `neo-ask-deny-probe-${process.pid}.txt`), content: 'x' },
      async () => {
        approvalAsked += 1;
        return false;
      },
    );
    expect(askDeniedResult.success).toBe(false);
    // 确实问过审批（走的是 ask 出口，不是又一条硬拒）。
    expect(approvalAsked).toBe(1);
    // 夹具就是真实串：ask-denied 出口的 error 与 metadata（failureCode + hostReason）。
    expect(askDeniedResult.error).toContain('Permission denied by user');
    expect(askDeniedResult.metadata?.hostReason).toMatchObject({ code: HostReasonCode.PermissionDeniedByUser });
    expect(askDeniedResult.metadata?.failureCode).toBe(AgentFailureCode.PermissionDenied);
  };

  it('zh：header 与展开卡都是登记表文案，无英文原句', async () => {
    await runOnce();
    const humanized = humanizeToolError(askDeniedResult.error, 'Write', zh, askDeniedResult.metadata);
    expect(humanized?.summary).toContain('你拒绝了');
    expect(humanized?.summary).toContain('写入');
    expect(humanized?.detail).toContain('审批被拒绝');
    expect(`${humanized?.summary ?? ''}${humanized?.detail ?? ''}`)
      .not.toMatch(/Permission denied|denied by the user|do not retry/i);

    const reason = humanizeToolFailureReason(asToolCall('t', 'Write', {}, askDeniedResult), zh);
    expect(reason).toContain('审批被拒绝');
    expect(reason).not.toMatch(/Permission denied/i);
  });

  it('en：same wording contract, no CJK leaks into the English card', async () => {
    await runOnce();
    const humanized = humanizeToolError(askDeniedResult.error, 'Write', en, askDeniedResult.metadata);
    expect(humanized?.summary).toContain('You declined');
    expect(humanized?.detail).toContain('The approval was denied');
    expect(`${humanized?.summary ?? ''}${humanized?.detail ?? ''}`).not.toMatch(/[\u4e00-\u9fff]/);

    const reason = humanizeToolFailureReason(asToolCall('t', 'Write', {}, askDeniedResult), en);
    expect(reason).toContain('The approval was denied');
    expect(reason).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('zh ToolDetails：登记表文案上卡，无英文原句、无「查看原始报错」开关', async () => {
    await runOnce();
    i18nState.lang = 'zh';
    const markup = renderToStaticMarkup(React.createElement(ToolDetails, {
      toolCall: asToolCall('perm-ask-deny', 'Write', { file_path: '~/neo-probe.txt', content: 'x' }, askDeniedResult),
    }));
    expect(markup).toContain('你拒绝了');
    expect(markup).toContain('审批被拒绝');
    expect(markup).not.toContain('Permission denied by user');
    expect(markup).not.toContain('查看原始报错');
  });

  it('en ToolDetails：registered copy renders, raw error hidden, no CJK', async () => {
    await runOnce();
    i18nState.lang = 'en';
    const markup = renderToStaticMarkup(React.createElement(ToolDetails, {
      toolCall: asToolCall('perm-ask-deny', 'Write', { file_path: '~/neo-probe.txt', content: 'x' }, askDeniedResult),
    }));
    expect(markup).toContain('You declined');
    expect(markup).toContain('The approval was denied');
    expect(markup).not.toContain('Permission denied by user');
    expect(markup).not.toContain('View original error');
    expect(markup).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
