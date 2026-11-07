// ============================================================================
// 用户 deny 规则 / 内置安全规则硬拒的人话卡片（N-FIX-PERM-DENY-ENGLISH-COPY）
// ----------------------------------------------------------------------------
// 夹具 = 真实 executor 结果形状：guardFabricGate 两条硬拒的 error 原文（规则名取自
// policyEngine 真源：User deny: Write / Block SSH key access）+ toolExecutor 硬拒出口
// 透传的 metadata.hostReason。zh/en 各渲染一遍，钉死：登记表文案出卡片、英文原句不漏、
// 结构化 hostReason 路径不出「查看原始报错」开关。
// ============================================================================

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HostReasonCode, type ToolCall } from '../../../src/shared/contract';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import {
  humanizeToolError,
  humanizeToolFailureReason,
} from '../../../src/renderer/utils/toolExecutionPresentation';

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

import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';

// guardFabricGate 硬拒 error 原文（policyEngine 真源规则名，字节照抄）。
const USER_DENY_ERROR = "Blocked by your permission deny rule (User deny: Write). This tool call is denied by the user's settings; do not retry it or try to achieve the same effect another way.";
const BUILTIN_SAFETY_ERROR = 'Blocked by built-in safety rule (Block SSH key access): SSH private key access is not allowed. Do not retry. Write inside the workspace/project directory instead, or ask the user to make this change themselves.';

/** 与 toolExecutor 硬拒出口回传形状一致的失败结果（metadata 只带 hostReason）。 */
function executorLikeResult(error: string, code: HostReasonCode, toolName: string) {
  return {
    success: false,
    error,
    metadata: {
      hostReason: { code, metadata: { toolName }, modelText: error },
    },
  };
}

const USER_DENY_CALL: ToolCall = {
  id: 'perm-deny-user-rule',
  name: 'Write',
  arguments: { file_path: '/etc/hosts', content: 'x' },
  result: executorLikeResult(USER_DENY_ERROR, HostReasonCode.PermissionDeniedUserRule, 'Write'),
} as unknown as ToolCall;

const SAFETY_RULE_CALL: ToolCall = {
  id: 'perm-deny-safety-rule',
  name: 'Read',
  arguments: { file_path: '~/.ssh/id_rsa' },
  result: executorLikeResult(BUILTIN_SAFETY_ERROR, HostReasonCode.PermissionDeniedSafetyRule, 'Read'),
} as unknown as ToolCall;

describe('用户 deny 规则硬拒的人话卡片', () => {
  it('zh：header 与展开卡说清是谁拦的、没执行、去哪改规则，英文原句不出现', () => {
    const humanized = humanizeToolError(USER_DENY_ERROR, 'Write', zh, USER_DENY_CALL.result!.metadata);
    expect(humanized?.summary).toContain('被你设置的权限规则拦下了，没有执行');
    expect(humanized?.detail).toContain('用户级权限规则');
    expect(humanized?.detail).toContain('重新发起');
    expect(`${humanized?.summary ?? ''}${humanized?.detail ?? ''}`)
      .not.toMatch(/Blocked by|denied by the user|do not retry/i);

    const reason = humanizeToolFailureReason(USER_DENY_CALL, zh);
    expect(reason).toContain('用户级权限规则');
    expect(reason).not.toMatch(/Blocked by|denied by/i);
  });

  it('en：same wording contract, no CJK leaks into the English card', () => {
    const humanized = humanizeToolError(USER_DENY_ERROR, 'Write', en, USER_DENY_CALL.result!.metadata);
    expect(humanized?.summary).toContain('was blocked by one of your permission rules and was not run');
    expect(humanized?.detail).toContain('User-level permission rules');
    expect(`${humanized?.summary ?? ''}${humanized?.detail ?? ''}`).not.toMatch(/[\u4e00-\u9fff]/);

    const reason = humanizeToolFailureReason(USER_DENY_CALL, en);
    expect(reason).toContain('User-level permission rules');
    expect(reason).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('zh ToolDetails：登记表文案上卡，无英文原句、无「查看原始报错」开关', () => {
    i18nState.lang = 'zh';
    const markup = renderToStaticMarkup(React.createElement(ToolDetails, { toolCall: USER_DENY_CALL }));
    expect(markup).toContain('被你设置的权限规则拦下了，没有执行');
    expect(markup).toContain('用户级权限规则');
    expect(markup).not.toContain('Blocked by your permission deny rule');
    expect(markup).not.toContain("denied by the user's settings");
    expect(markup).not.toContain('查看原始报错');
  });

  it('en ToolDetails：registered copy renders, raw error hidden, no CJK', () => {
    i18nState.lang = 'en';
    const markup = renderToStaticMarkup(React.createElement(ToolDetails, { toolCall: USER_DENY_CALL }));
    expect(markup).toContain('was blocked by one of your permission rules and was not run');
    expect(markup).toContain('User-level permission rules');
    expect(markup).not.toContain('Blocked by your permission deny rule');
    expect(markup).not.toContain('View original error');
    expect(markup).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('内置安全规则硬拒的人话卡片', () => {
  it('zh：说清是 Neo 的内置安全底线、没执行、给出替代出路', () => {
    const humanized = humanizeToolError(BUILTIN_SAFETY_ERROR, 'Read', zh, SAFETY_RULE_CALL.result!.metadata);
    expect(humanized?.summary).toContain('触碰了 Neo 的内置安全底线，已被拦截，没有执行');
    expect(humanized?.detail).toContain('工作文件夹内操作');
    expect(`${humanized?.summary ?? ''}${humanized?.detail ?? ''}`)
      .not.toMatch(/Blocked by built-in|Do not retry|workspace\/project/i);

    const reason = humanizeToolFailureReason(SAFETY_RULE_CALL, zh);
    expect(reason).toContain('不会代做');
    expect(reason).toContain('工作文件夹内操作');
    expect(reason).not.toMatch(/Blocked by built-in/i);
  });

  it('en：same wording contract, no CJK leaks into the English card', () => {
    const humanized = humanizeToolError(BUILTIN_SAFETY_ERROR, 'Read', en, SAFETY_RULE_CALL.result!.metadata);
    expect(humanized?.summary).toContain("hit one of Neo's built-in safety rules and was blocked; it did not run");
    expect(humanized?.detail).toContain('workspace folder instead');
    expect(`${humanized?.summary ?? ''}${humanized?.detail ?? ''}`).not.toMatch(/[\u4e00-\u9fff]/);

    const reason = humanizeToolFailureReason(SAFETY_RULE_CALL, en);
    expect(reason).toContain('workspace folder instead');
    expect(reason).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('zh ToolDetails：登记表文案上卡，无英文原句、无「查看原始报错」开关', () => {
    i18nState.lang = 'zh';
    const markup = renderToStaticMarkup(React.createElement(ToolDetails, { toolCall: SAFETY_RULE_CALL }));
    expect(markup).toContain('触碰了 Neo 的内置安全底线，已被拦截，没有执行');
    expect(markup).toContain('工作文件夹内操作');
    expect(markup).not.toContain('Blocked by built-in safety rule');
    expect(markup).not.toContain('SSH private key access is not allowed');
    expect(markup).not.toContain('查看原始报错');
  });

  it('en ToolDetails：registered copy renders, raw error hidden, no CJK', () => {
    i18nState.lang = 'en';
    const markup = renderToStaticMarkup(React.createElement(ToolDetails, { toolCall: SAFETY_RULE_CALL }));
    // markup 里撇号被转义成 &#x27;，断言避开撇号本体。
    expect(markup).toContain('built-in safety rules and was blocked; it did not run');
    expect(markup).toContain('workspace folder instead');
    expect(markup).not.toContain('Blocked by built-in safety rule');
    expect(markup).not.toContain('View original error');
    expect(markup).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
