// ============================================================================
// 设置页「执行引擎」section — 行模型派生逻辑单测
// 覆盖：安装状态徽标 / 计费标签 / 默认模型来源说明 / 登录-安装指引 的正确派生。
// ============================================================================

import { describe, expect, it } from 'vitest';
import type {
  AgentEngineDescriptor,
  AgentEngineInstallState,
  AgentEngineKind,
} from '../../../src/shared/contract/agentEngine';
import {
  buildEngineSectionRow,
  buildEngineSectionRows,
} from '../../../src/renderer/components/features/settings/tabs/agentEngineSectionHelpers';
import { zh, en } from '../../../src/renderer/i18n';

function descriptor(
  kind: AgentEngineKind,
  overrides: Partial<AgentEngineDescriptor> = {},
): AgentEngineDescriptor {
  const installState: AgentEngineInstallState = kind === 'native' ? 'builtin' : 'missing';
  return {
    kind,
    label: kind === 'native' ? 'Neo' : kind,
    summary: 'summary',
    installState,
    runtimeState: 'ready',
    executable: kind === 'native',
    capabilities: [],
    defaultPermissionProfile: 'read_only',
    cwdPolicy: 'workspace_only',
    riskTier: 'medium',
    detectedAt: 1,
    ...overrides,
  };
}

describe('buildEngineSectionRow', () => {
  it('native 引擎：内置徽标 + 按量计费 + provider 默认模型说明，无登录/安装指引', () => {
    const row = buildEngineSectionRow(descriptor('native'), zh);
    expect(row.installState).toBe('builtin');
    expect(row.installStateLabel).toBe(zh.engineCompat.engineSection.installState.builtin);
    expect(row.billing.mode).toBe('api_key_payg');
    expect(row.defaultModelHint).toBe(zh.engineCompat.engineSection.defaultModelNative);
    expect(row.loginHint).toBeUndefined();
    expect(row.installHint).toBeUndefined();
  });

  it('codex 未安装：未安装徽标 + 订阅计费 + 目录默认模型说明 + 登录指引 + 安装指引', () => {
    const row = buildEngineSectionRow(descriptor('codex_cli'), zh);
    expect(row.installState).toBe('missing');
    expect(row.installStateLabel).toBe(zh.engineCompat.engineSection.installState.missing);
    expect(row.billing.mode).toBe('subscription');
    expect(row.defaultModelHint).toBe(zh.engineCompat.engineSection.defaultModelHint);
    expect(row.loginHint).toBe(zh.engineCompat.engineSection.loginHint.codex_cli);
    expect(row.installHint).toBe(zh.engineCompat.engineSection.installHint.codex_cli);
  });

  it('已安装的外部引擎：保留登录指引但不再给安装指引，并带出版本/路径', () => {
    const row = buildEngineSectionRow(
      descriptor('claude_code', {
        installState: 'installed',
        version: '1.2.3',
        binaryPath: '/usr/local/bin/claude',
      }),
      zh,
    );
    expect(row.installState).toBe('installed');
    expect(row.installHint).toBeUndefined();
    expect(row.loginHint).toBe(zh.engineCompat.engineSection.loginHint.claude_code);
    expect(row.version).toBe('1.2.3');
    expect(row.binaryPath).toBe('/usr/local/bin/claude');
  });

  it('mimo/kimi：默认模型说明走「由 CLI 解析」分支', () => {
    expect(buildEngineSectionRow(descriptor('mimo_code'), zh).defaultModelHint)
      .toBe(zh.engineCompat.engineSection.defaultModelCliResolved);
    expect(buildEngineSectionRow(descriptor('kimi_code'), zh).defaultModelHint)
      .toBe(zh.engineCompat.engineSection.defaultModelCliResolved);
  });

  it('en locale 也能完整派生（i18n 不缺键）', () => {
    const row = buildEngineSectionRow(descriptor('kimi_code'), en);
    expect(row.installStateLabel).toBe(en.engineCompat.engineSection.installState.missing);
    expect(row.billing.label).toBe(en.engineCompat.billing.subscription.label);
    expect(row.loginHint).toBe(en.engineCompat.engineSection.loginHint.kimi_code);
  });
});

describe('buildEngineSectionRows', () => {
  it('保持入参顺序，逐一翻成行模型', () => {
    const descriptors: AgentEngineDescriptor[] = [
      descriptor('native'),
      descriptor('codex_cli'),
      descriptor('claude_code'),
      descriptor('mimo_code'),
      descriptor('kimi_code'),
    ];
    const rows = buildEngineSectionRows(descriptors, zh);
    expect(rows.map((r) => r.kind)).toEqual(['native', 'codex_cli', 'claude_code', 'mimo_code', 'kimi_code']);
    // 每行都有计费摘要与安装状态徽标
    expect(rows.every((r) => Boolean(r.billing.label) && Boolean(r.installStateLabel))).toBe(true);
  });
});
