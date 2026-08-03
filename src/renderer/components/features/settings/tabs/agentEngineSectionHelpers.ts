// ============================================================================
// agentEngineSectionHelpers — 设置页「执行引擎」section 的纯展示逻辑
// ----------------------------------------------------------------------------
// 把 listSources 返回的 AgentEngineSourceDescriptor（完整 manifest 探测来源）
// + list 返回的 AgentEngineDescriptor（正式 kind 可切换引擎）+ i18n
// 翻成可渲染的行模型。保持无 React、无 IO，便于单测：
//   - 正式 kind（WorkBuddy / Grok 等）可切换行
//   - 无 kind / 无 descriptor 来源只展示真实 detected / authState /
//     evidence / recommendation 状态，切换禁用
//   - 推荐项绝不伪装成已安装
// 所有用户可见文案都由调用方从 Translations 传入，本模块不散字面量，
// 也不按产品名写分支（只用 contract 字段）。
// ============================================================================

import type {
  AgentEngineDescriptor,
  AgentEngineInstallState,
  AgentEngineKind,
  AgentEngineSourceDescriptor,
  ExternalAgentEngineKind,
} from '@shared/contract/agentEngine';
import type { Translations } from '../../../../i18n/zh';
import { buildEngineBillingSummary, type EngineBillingSummary } from '../../../StatusBar/modelSwitcherHelpers';

/** 安装状态徽标的视觉色板（与 ModelSwitcher 引擎徽标同语义：内置/已装=正向，未装=中性灰）。 */
const INSTALL_STATE_BADGE_CLASS: Record<AgentEngineInstallState, string> = {
  builtin: 'border-badge-info/20 bg-sky-500/10 text-badge-info',
  installed: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  missing: 'border-zinc-700 bg-zinc-800 text-zinc-500',
};

/** 探测来源状态徽标色板（contract 派生，非产品名分支）。 */
const SOURCE_STATUS_BADGE_CLASS = {
  available: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  detected: 'border-badge-info/20 bg-sky-500/10 text-badge-info',
  needsLogin: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
  adapterPending: 'border-zinc-600 bg-zinc-800 text-zinc-400',
  notInstalled: 'border-zinc-700 bg-zinc-800 text-zinc-500',
  recommended: 'border-violet-500/20 bg-violet-500/10 text-violet-300',
  authUnverified: 'border-amber-500/20 bg-amber-500/10 text-amber-200',
  unavailable: 'border-zinc-700 bg-zinc-900 text-zinc-500',
} as const;

/**
 * 来源状态键：只由 source.detected / authState / evidence / recommendation /
 * selectable 派生，禁止按 manifestId 或产品名分支。
 */
export type EngineSourceStatusKey =
  | 'available'
  | 'detected_needs_login'
  | 'detected_adapter_pending'
  | 'detected_auth_unverified'
  | 'not_installed'
  | 'adapter_pending'
  | 'recommended'
  | 'unavailable';

export interface EngineSectionRow {
  /** Manifest 稳定 id（含无 kind 的探测来源）。 */
  manifestId: string;
  /** 正式引擎 kind；推荐/探测-only 来源可缺省。 */
  kind?: AgentEngineKind;
  label: string;
  summary: string;
  /** 探测来源状态（合同字段派生）。 */
  statusKey: EngineSourceStatusKey;
  statusLabel: string;
  statusBadgeClass: string;
  /** 次级徽标（如「已检测」旁的「需要登录」）。 */
  secondaryStatusLabel?: string;
  secondaryStatusBadgeClass?: string;
  /** 状态说明文案。 */
  statusDetail: string;
  /** 仅正式 descriptor 有安装状态；推荐项永不填 installed。 */
  installState?: AgentEngineInstallState;
  installStateLabel?: string;
  installStateBadgeClass?: string;
  /** 引擎级计费摘要；无 kind 时省略。 */
  billing?: EngineBillingSummary;
  version?: string;
  binaryPath?: string;
  /** 默认模型来源说明；仅正式 kind。 */
  defaultModelHint?: string;
  /** 仅外部正式引擎给登录提示。 */
  loginHint?: string;
  /** 仅 missing 的外部正式引擎给安装指引。 */
  installHint?: string;
  /**
   * 能否参与会话切换：必须有 kind 且能与 list() 的 descriptor 配对。
   * 无 kind / 无 descriptor 一律 false（按钮禁用）。
   */
  switchable: boolean;
  /** source.selectable：已检测 + adapter 生产就绪 + 已登录。 */
  selectable: boolean;
  /** 未检测但有 recommendation：只展示推荐，绝不伪装成已安装。 */
  isRecommendationOnly: boolean;
}

function isExternalKind(kind: AgentEngineKind): kind is ExternalAgentEngineKind {
  // 与 ExternalAgentEngineKind = Exclude<AgentEngineKind, 'native'> 一致：非 native 即外部 CLI。
  return kind !== 'native';
}

/**
 * 把 contract 探测字段翻成状态键。
 * 顺序对齐 onboarding / EngineScopedModelPanel：selectable 优先，再 detected，
 * 再 evidence / recommendation；禁止按产品名特判。
 */
export function resolveEngineSourceStatus(
  source: AgentEngineSourceDescriptor,
): EngineSourceStatusKey {
  if (source.selectable) return 'available';
  if (source.detected) {
    if (source.authState === 'needs_login') return 'detected_needs_login';
    if (source.evidence !== 'production') return 'detected_adapter_pending';
    // unknown = 探测挂了没问出来，not_checked = 没探过；对用户都是「登录状态未确认」，
    // 都不能说成「需要登录」。
    if (source.authState === 'not_checked' || source.authState === 'unknown') {
      return 'detected_auth_unverified';
    }
    return 'detected_adapter_pending';
  }
  if (source.evidence === 'production') return 'not_installed';
  if (source.evidence === 'local_spike') return 'adapter_pending';
  if (source.recommendation) return 'recommended';
  return 'unavailable';
}

function sourceStatusPresentation(
  source: AgentEngineSourceDescriptor,
  statusKey: EngineSourceStatusKey,
  t: Translations,
): Pick<
  EngineSectionRow,
  | 'statusLabel'
  | 'statusBadgeClass'
  | 'secondaryStatusLabel'
  | 'secondaryStatusBadgeClass'
  | 'statusDetail'
> {
  const section = t.engineCompat.engineSection;
  const statusCopy = section.sourceStatus;
  const detailCopy = section.sourceStatusDetail;

  switch (statusKey) {
    case 'available':
      return {
        statusLabel: statusCopy.available,
        statusBadgeClass: SOURCE_STATUS_BADGE_CLASS.available,
        statusDetail: detailCopy.available,
      };
    case 'detected_needs_login':
      return {
        statusLabel: statusCopy.detected,
        statusBadgeClass: SOURCE_STATUS_BADGE_CLASS.detected,
        secondaryStatusLabel: statusCopy.needsLogin,
        secondaryStatusBadgeClass: SOURCE_STATUS_BADGE_CLASS.needsLogin,
        statusDetail: detailCopy.detectedNeedsLogin,
      };
    case 'detected_adapter_pending':
      return {
        statusLabel: statusCopy.adapterPending,
        statusBadgeClass: SOURCE_STATUS_BADGE_CLASS.adapterPending,
        statusDetail: detailCopy.detectedAdapterPending,
      };
    case 'detected_auth_unverified':
      return {
        statusLabel: statusCopy.detected,
        statusBadgeClass: SOURCE_STATUS_BADGE_CLASS.detected,
        secondaryStatusLabel: statusCopy.authUnverified,
        secondaryStatusBadgeClass: SOURCE_STATUS_BADGE_CLASS.authUnverified,
        statusDetail: detailCopy.detectedAuthUnverified,
      };
    case 'not_installed':
      return {
        statusLabel: statusCopy.notInstalled,
        statusBadgeClass: SOURCE_STATUS_BADGE_CLASS.notInstalled,
        statusDetail: detailCopy.notInstalled,
      };
    case 'adapter_pending':
      return {
        statusLabel: statusCopy.adapterPending,
        statusBadgeClass: SOURCE_STATUS_BADGE_CLASS.adapterPending,
        statusDetail: detailCopy.adapterPending,
      };
    case 'recommended':
      return {
        // 优先用 manifest recommendation 文案（contract 字段），否则 i18n 兜底。
        statusLabel: source.recommendation?.label || statusCopy.recommended,
        statusBadgeClass: SOURCE_STATUS_BADGE_CLASS.recommended,
        statusDetail: source.recommendation?.reason || detailCopy.recommended,
      };
    case 'unavailable':
    default:
      return {
        statusLabel: statusCopy.unavailable,
        statusBadgeClass: SOURCE_STATUS_BADGE_CLASS.unavailable,
        statusDetail: detailCopy.unavailable,
      };
  }
}

function defaultModelHintForKind(kind: AgentEngineKind, t: Translations): string {
  const section = t.engineCompat.engineSection;
  if (kind === 'native') return section.defaultModelNative;
  if (
    kind === 'mimo_code'
    || kind === 'kimi_code'
    || kind === 'codebuddy_code'
    || kind === 'grok_cli'
  ) {
    return section.defaultModelCliResolved;
  }
  return section.defaultModelHint;
}

/**
 * 把单个引擎描述符翻成 section 行模型（正式 kind 路径，兼容旧调用）。
 *   - native        → 计费 api_key_payg；默认模型「随会话 provider」；无登录/安装指引。
 *   - 外部 CLI       → 计费 subscription；默认模型在目录里配（mimo/kimi 由 CLI 解析）；
 *                      恒给登录提示；仅 missing 时给安装指引。
 */
export function buildEngineSectionRow(
  descriptor: AgentEngineDescriptor,
  t: Translations,
): EngineSectionRow {
  const kind = descriptor.kind;
  const syntheticSource: AgentEngineSourceDescriptor = {
    manifestId: descriptor.manifestId,
    kind: descriptor.kind,
    label: descriptor.label,
    summary: descriptor.summary,
    ...(descriptor.command ? { command: descriptor.command } : {}),
    ...(descriptor.binaryPath ? { binaryPath: descriptor.binaryPath } : {}),
    ...(descriptor.version ? { version: descriptor.version } : {}),
    detected: descriptor.installState !== 'missing',
    selectable: descriptor.executable && descriptor.installState !== 'missing',
    authState: descriptor.reliability?.authState ?? 'not_checked',
    modelSelection: descriptor.modelSelection,
    ...(descriptor.iconAsset ? { iconAsset: descriptor.iconAsset } : {}),
    evidence: 'production',
    credentialOwner: kind === 'native' ? 'neo' : 'official_client',
    auditNotes: descriptor.auditNotes ?? [],
  };
  return buildEngineSectionRowFromSource(syntheticSource, descriptor, t);
}

/**
 * 把 listSources 的来源 + 可选正式 descriptor 翻成 section 行。
 * - 有 kind、descriptor、可执行文件且 source.selectable=true → switchable=true
 * - 无 kind 或无 descriptor → switchable=false，只展示真实探测状态
 * - isRecommendationOnly 时绝不写入 installState=installed
 */
export function buildEngineSectionRowFromSource(
  source: AgentEngineSourceDescriptor,
  descriptor: AgentEngineDescriptor | undefined,
  t: Translations,
): EngineSectionRow {
  const section = t.engineCompat.engineSection;
  const statusKey = resolveEngineSourceStatus(source);
  const status = sourceStatusPresentation(source, statusKey, t);
  const switchable = Boolean(
    source.kind
    && descriptor
    && descriptor.executable
    && source.selectable,
  );
  const isRecommendationOnly = !source.detected && Boolean(source.recommendation);

  const row: EngineSectionRow = {
    manifestId: source.manifestId,
    ...(source.kind ? { kind: source.kind } : {}),
    label: source.label,
    summary: source.summary,
    statusKey,
    ...status,
    version: source.version ?? descriptor?.version,
    binaryPath: source.binaryPath ?? descriptor?.binaryPath,
    switchable,
    selectable: source.selectable,
    isRecommendationOnly,
  };

  // 正式 descriptor 才写安装状态 / 计费 / 默认模型 / 登录安装指引。
  // 推荐-only 与无 kind 来源绝不写 installState=installed。
  if (descriptor && source.kind) {
    const kind = descriptor.kind;
    const external = isExternalKind(kind);
    row.installState = descriptor.installState;
    row.installStateLabel = section.installState[descriptor.installState];
    row.installStateBadgeClass = INSTALL_STATE_BADGE_CLASS[descriptor.installState];
    row.billing = buildEngineBillingSummary(kind, t);
    row.defaultModelHint = defaultModelHintForKind(kind, t);
    if (external) {
      row.loginHint = section.loginHint[kind];
      if (descriptor.installState === 'missing') {
        row.installHint = section.installHint[kind];
      }
    }
  }

  return row;
}

/**
 * 按 listSources 顺序构建完整行列表；正式 kind 与 list() descriptor 按 kind 配对。
 * 推荐/探测-only 来源保留在列表中，但 switchable=false。
 */
export function buildEngineSectionRowsFromSources(
  sources: readonly AgentEngineSourceDescriptor[],
  descriptors: readonly AgentEngineDescriptor[],
  t: Translations,
): EngineSectionRow[] {
  const descriptorByKind = new Map(
    descriptors.map((descriptor) => [descriptor.kind, descriptor] as const),
  );
  return sources.map((source) => {
    const descriptor = source.kind ? descriptorByKind.get(source.kind) : undefined;
    return buildEngineSectionRowFromSource(source, descriptor, t);
  });
}

/** @deprecated 兼容旧「仅 descriptors」调用；新 UI 请用 buildEngineSectionRowsFromSources。 */
export function buildEngineSectionRows(
  descriptors: readonly AgentEngineDescriptor[],
  t: Translations,
): EngineSectionRow[] {
  return descriptors.map((descriptor) => buildEngineSectionRow(descriptor, t));
}
