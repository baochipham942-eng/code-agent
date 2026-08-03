// ============================================================================
// 设置页「执行引擎」section — 行模型派生逻辑单测
// 覆盖：
//   - 正式 kind（WorkBuddy / Grok 等）可切换行 + 安装/计费/登录指引
//   - 无 kind 来源（Qoder / Comate / Cursor）真实状态展示与 switchable=false
//   - 推荐项绝不伪装成已安装
// ============================================================================

import { describe, expect, it } from 'vitest';
import type {
  AgentEngineDescriptor,
  AgentEngineInstallState,
  AgentEngineKind,
  AgentEngineSourceDescriptor,
} from '../../../src/shared/contract/agentEngine';
import {
  buildEngineSectionRow,
  buildEngineSectionRowFromSource,
  buildEngineSectionRows,
  buildEngineSectionRowsFromSources,
  resolveEngineSourceStatus,
} from '../../../src/renderer/components/features/settings/tabs/agentEngineSectionHelpers';
import { zh, en } from '../../../src/renderer/i18n';

function descriptor(
  kind: AgentEngineKind,
  overrides: Partial<AgentEngineDescriptor> = {},
): AgentEngineDescriptor {
  const installState: AgentEngineInstallState = kind === 'native' ? 'builtin' : 'missing';
  return {
    manifestId: kind,
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
    modelSelection: kind === 'native' ? 'neo_provider' : 'runtime_catalog',
    ...overrides,
  };
}

function source(
  overrides: Partial<AgentEngineSourceDescriptor> & Pick<AgentEngineSourceDescriptor, 'manifestId' | 'label'>,
): AgentEngineSourceDescriptor {
  return {
    summary: `${overrides.label} summary`,
    detected: false,
    selectable: false,
    authState: 'not_checked',
    modelSelection: 'unavailable',
    evidence: 'none',
    credentialOwner: 'official_client',
    auditNotes: [],
    ...overrides,
  };
}

describe('buildEngineSectionRow', () => {
  it('native 引擎：内置徽标 + 按量计费 + provider 默认模型说明，无登录/安装指引', () => {
    const row = buildEngineSectionRow(descriptor('native'), zh);
    expect(row.installState).toBe('builtin');
    expect(row.installStateLabel).toBe(zh.engineCompat.engineSection.installState.builtin);
    expect(row.billing?.mode).toBe('api_key_payg');
    expect(row.defaultModelHint).toBe(zh.engineCompat.engineSection.defaultModelNative);
    expect(row.loginHint).toBeUndefined();
    expect(row.installHint).toBeUndefined();
    expect(row.switchable).toBe(true);
  });

  it('codex 未安装：未安装徽标 + 订阅计费 + 目录默认模型说明 + 登录指引 + 安装指引', () => {
    const row = buildEngineSectionRow(descriptor('codex_cli'), zh);
    expect(row.installState).toBe('missing');
    expect(row.installStateLabel).toBe(zh.engineCompat.engineSection.installState.missing);
    expect(row.billing?.mode).toBe('subscription');
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
    expect(row.billing?.label).toBe(en.engineCompat.billing.subscription.label);
    expect(row.loginHint).toBe(en.engineCompat.engineSection.loginHint.kimi_code);
    expect(row.statusLabel).toBeTruthy();
    expect(en.engineCompat.engineSection.sourceStatus.recommended).toBeTruthy();
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
    expect(rows.every((r) => Boolean(r.billing?.label) && Boolean(r.installStateLabel))).toBe(true);
  });
});

describe('resolveEngineSourceStatus', () => {
  it('selectable → available', () => {
    expect(resolveEngineSourceStatus(source({
      manifestId: 'codebuddy_code',
      label: 'WorkBuddy',
      kind: 'codebuddy_code',
      detected: true,
      selectable: true,
      authState: 'authenticated',
      evidence: 'production',
    }))).toBe('available');
  });

  it('detected + needs_login → detected_needs_login（Qoder 场景）', () => {
    expect(resolveEngineSourceStatus(source({
      manifestId: 'qoder_work',
      label: 'Qoder Work',
      detected: true,
      selectable: false,
      authState: 'needs_login',
      evidence: 'local_spike',
    }))).toBe('detected_needs_login');
  });

  it('detected + non-production evidence → detected_adapter_pending（Comate spike）', () => {
    expect(resolveEngineSourceStatus(source({
      manifestId: 'comate_zulu',
      label: 'Comate / Zulu',
      detected: true,
      selectable: false,
      authState: 'not_checked',
      evidence: 'local_spike',
    }))).toBe('detected_adapter_pending');
  });

  it('未检测 + recommendation → recommended（Cursor 场景）', () => {
    expect(resolveEngineSourceStatus(source({
      manifestId: 'cursor_cli',
      label: 'Cursor CLI',
      detected: false,
      selectable: false,
      evidence: 'none',
      recommendation: { label: '推荐了解', reason: '需要完成官方协议验证' },
    }))).toBe('recommended');
  });
});

describe('buildEngineSectionRowsFromSources — 可切换 vs 禁用边界', () => {
  it('WorkBuddy / Grok 正式 kind + descriptor：switchable=true，可带安装与登录指引', () => {
    const sources: AgentEngineSourceDescriptor[] = [
      source({
        manifestId: 'codebuddy_code',
        kind: 'codebuddy_code',
        label: 'WorkBuddy',
        detected: true,
        selectable: true,
        authState: 'authenticated',
        evidence: 'production',
        modelSelection: 'client_default',
        version: 'wb-1',
        binaryPath: '/Applications/WorkBuddy.app/cli/codebuddy',
      }),
      source({
        manifestId: 'grok_cli',
        kind: 'grok_cli',
        label: 'Grok Build',
        detected: true,
        selectable: true,
        authState: 'authenticated',
        evidence: 'production',
        modelSelection: 'runtime_catalog',
        version: 'grok-2',
      }),
    ];
    const descriptors = [
      descriptor('codebuddy_code', {
        installState: 'installed',
        executable: true,
        runtimeState: 'ready',
        version: 'wb-1',
        binaryPath: '/Applications/WorkBuddy.app/cli/codebuddy',
        modelSelection: 'client_default',
        label: 'WorkBuddy',
      }),
      descriptor('grok_cli', {
        installState: 'installed',
        executable: true,
        runtimeState: 'ready',
        version: 'grok-2',
        label: 'Grok Build',
      }),
    ];

    const rows = buildEngineSectionRowsFromSources(sources, descriptors, zh);
    expect(rows).toHaveLength(2);

    const workbuddy = rows.find((row) => row.manifestId === 'codebuddy_code');
    expect(workbuddy).toMatchObject({
      kind: 'codebuddy_code',
      switchable: true,
      selectable: true,
      statusKey: 'available',
      installState: 'installed',
      isRecommendationOnly: false,
    });
    expect(workbuddy?.loginHint).toBe(zh.engineCompat.engineSection.loginHint.codebuddy_code);
    expect(workbuddy?.defaultModelHint).toBe(zh.engineCompat.engineSection.defaultModelCliResolved);
    expect(workbuddy?.billing?.mode).toBe('subscription');

    const grok = rows.find((row) => row.manifestId === 'grok_cli');
    expect(grok).toMatchObject({
      kind: 'grok_cli',
      switchable: true,
      selectable: true,
      statusKey: 'available',
      installState: 'installed',
    });
    expect(grok?.loginHint).toBe(zh.engineCompat.engineSection.loginHint.grok_cli);
  });

  it('Qoder：已检测 + 需要登录，无 kind/descriptor → switchable=false', () => {
    const qoder = source({
      manifestId: 'qoder_work',
      label: 'Qoder Work',
      detected: true,
      selectable: false,
      authState: 'needs_login',
      evidence: 'local_spike',
      recommendation: {
        label: '需要登录',
        reason: '请先在 Qoder Work CLI 完成官方登录',
      },
    });
    const row = buildEngineSectionRowFromSource(qoder, undefined, zh);
    expect(row.switchable).toBe(false);
    expect(row.kind).toBeUndefined();
    expect(row.statusKey).toBe('detected_needs_login');
    expect(row.statusLabel).toBe(zh.engineCompat.engineSection.sourceStatus.detected);
    expect(row.secondaryStatusLabel).toBe(zh.engineCompat.engineSection.sourceStatus.needsLogin);
    expect(row.statusDetail).toBe(zh.engineCompat.engineSection.sourceStatusDetail.detectedNeedsLogin);
    expect(row.installState).toBeUndefined();
    expect(row.isRecommendationOnly).toBe(false);
    expect(row.billing).toBeUndefined();
  });

  it('Comate spike：已检测 + 适配未开放，switchable=false', () => {
    const comate = source({
      manifestId: 'comate_zulu',
      label: 'Comate / Zulu',
      detected: true,
      selectable: false,
      authState: 'not_checked',
      evidence: 'local_spike',
      recommendation: { label: '可探测', reason: '适合后续接入' },
    });
    const row = buildEngineSectionRowFromSource(comate, undefined, zh);
    expect(row.switchable).toBe(false);
    expect(row.statusKey).toBe('detected_adapter_pending');
    expect(row.statusLabel).toBe(zh.engineCompat.engineSection.sourceStatus.adapterPending);
    expect(row.statusDetail).toBe(zh.engineCompat.engineSection.sourceStatusDetail.detectedAdapterPending);
    expect(row.installState).toBeUndefined();
    expect(row.isRecommendationOnly).toBe(false);
  });

  it('Cursor 未检测：推荐安装，绝不伪装成已安装，switchable=false', () => {
    const cursor = source({
      manifestId: 'cursor_cli',
      label: 'Cursor CLI',
      detected: false,
      selectable: false,
      evidence: 'none',
      recommendation: {
        label: '推荐了解',
        reason: '需要完成官方协议与实机验证后才能在 Neo 中选择。',
      },
    });
    const row = buildEngineSectionRowFromSource(cursor, undefined, zh);
    expect(row.switchable).toBe(false);
    expect(row.statusKey).toBe('recommended');
    expect(row.isRecommendationOnly).toBe(true);
    expect(row.installState).toBeUndefined();
    expect(row.installStateLabel).toBeUndefined();
    // 使用 contract recommendation 文案，不硬编码产品特判
    expect(row.statusLabel).toBe('推荐了解');
    expect(row.statusDetail).toContain('官方协议');
  });

  it('有 kind 但没有配对 descriptor：只展示状态，switchable=false', () => {
    const orphan = source({
      manifestId: 'codebuddy_code',
      kind: 'codebuddy_code',
      label: 'WorkBuddy',
      detected: true,
      selectable: true,
      authState: 'authenticated',
      evidence: 'production',
    });
    const row = buildEngineSectionRowFromSource(orphan, undefined, zh);
    expect(row.switchable).toBe(false);
    expect(row.installState).toBeUndefined();
    expect(row.statusKey).toBe('available');
  });

  it('有正式 descriptor 但来源未通过可用性门禁：switchable=false', () => {
    const gated = source({
      manifestId: 'codebuddy_code',
      kind: 'codebuddy_code',
      label: 'WorkBuddy',
      detected: true,
      selectable: false,
      authState: 'needs_login',
      evidence: 'production',
    });
    const row = buildEngineSectionRowFromSource(
      gated,
      descriptor('codebuddy_code', {
        installState: 'installed',
        executable: true,
        runtimeState: 'ready',
      }),
      zh,
    );
    expect(row.switchable).toBe(false);
    expect(row.statusKey).toBe('detected_needs_login');
  });

  it('完整来源列表按 listSources 顺序保留，正式与探测-only 共存', () => {
    const sources: AgentEngineSourceDescriptor[] = [
      source({
        manifestId: 'native',
        kind: 'native',
        label: 'Neo',
        detected: true,
        selectable: true,
        authState: 'authenticated',
        evidence: 'production',
        modelSelection: 'neo_provider',
        credentialOwner: 'neo',
      }),
      source({
        manifestId: 'codebuddy_code',
        kind: 'codebuddy_code',
        label: 'WorkBuddy',
        detected: true,
        selectable: true,
        authState: 'authenticated',
        evidence: 'production',
        modelSelection: 'client_default',
      }),
      source({
        manifestId: 'qoder_work',
        label: 'Qoder Work',
        detected: true,
        authState: 'needs_login',
        evidence: 'local_spike',
      }),
      source({
        manifestId: 'comate_zulu',
        label: 'Comate / Zulu',
        detected: true,
        evidence: 'local_spike',
      }),
      source({
        manifestId: 'cursor_cli',
        label: 'Cursor CLI',
        recommendation: { label: '推荐安装', reason: '尚无协议证据' },
      }),
    ];
    const rows = buildEngineSectionRowsFromSources(
      sources,
      [
        descriptor('native', { installState: 'builtin', executable: true, label: 'Neo' }),
        descriptor('codebuddy_code', {
          installState: 'installed',
          executable: true,
          label: 'WorkBuddy',
          modelSelection: 'client_default',
        }),
      ],
      zh,
    );

    expect(rows.map((row) => row.manifestId)).toEqual([
      'native',
      'codebuddy_code',
      'qoder_work',
      'comate_zulu',
      'cursor_cli',
    ]);
    expect(rows.filter((row) => row.switchable).map((row) => row.manifestId)).toEqual([
      'native',
      'codebuddy_code',
    ]);
    expect(rows.find((row) => row.manifestId === 'cursor_cli')?.isRecommendationOnly).toBe(true);
    // 推荐项不得出现 installState=installed
    expect(rows.every((row) => !(row.isRecommendationOnly && row.installState === 'installed'))).toBe(true);
  });

  it('en locale 对探测-only 状态键齐全', () => {
    const row = buildEngineSectionRowFromSource(
      source({
        manifestId: 'qoder_work',
        label: 'Qoder Work',
        detected: true,
        authState: 'needs_login',
        evidence: 'local_spike',
      }),
      undefined,
      en,
    );
    expect(row.statusLabel).toBe(en.engineCompat.engineSection.sourceStatus.detected);
    expect(row.secondaryStatusLabel).toBe(en.engineCompat.engineSection.sourceStatus.needsLogin);
    expect(row.statusDetail).toBe(en.engineCompat.engineSection.sourceStatusDetail.detectedNeedsLogin);
  });
});
