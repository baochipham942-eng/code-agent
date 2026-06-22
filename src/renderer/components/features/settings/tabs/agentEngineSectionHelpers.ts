// ============================================================================
// agentEngineSectionHelpers — 设置页「执行引擎」section 的纯展示逻辑
// ----------------------------------------------------------------------------
// 把引擎描述符（AgentEngineDescriptor）+ i18n 翻成可渲染的行模型，保持无 React、
// 无 IO，便于单测「安装状态徽标 / 计费标签 / 默认模型提示 / 安装-登录指引」是否正确。
// 所有用户可见文案都由调用方从 Translations 传入，本模块不散字面量。
// ============================================================================

import type {
  AgentEngineDescriptor,
  AgentEngineInstallState,
  AgentEngineKind,
  ExternalAgentEngineKind,
} from '@shared/contract/agentEngine';
import type { Translations } from '../../../../i18n/zh';
import { buildEngineBillingSummary, type EngineBillingSummary } from '../../../StatusBar/modelSwitcherHelpers';

/** 安装状态徽标的视觉色板（与 ModelSwitcher 引擎徽标同语义：内置/已装=正向，未装=中性灰）。 */
const INSTALL_STATE_BADGE_CLASS: Record<AgentEngineInstallState, string> = {
  builtin: 'border-sky-500/20 bg-sky-500/10 text-sky-300',
  installed: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  missing: 'border-zinc-700 bg-zinc-800 text-zinc-500',
};

export interface EngineSectionRow {
  kind: AgentEngineKind;
  label: string;
  summary: string;
  /** 安装状态徽标文案 + 配色 */
  installState: AgentEngineInstallState;
  installStateLabel: string;
  installStateBadgeClass: string;
  /** 引擎级计费摘要（订阅/按量/免费/未知） */
  billing: EngineBillingSummary;
  version?: string;
  binaryPath?: string;
  /** 默认模型来源说明（native / cli-resolved / 目录可配 三类，文案走 i18n） */
  defaultModelHint: string;
  /** 仅外部引擎吃订阅，需登录；native 无此项 */
  loginHint?: string;
  /** 仅未安装的外部引擎给安装指引；已装 / native 无此项 */
  installHint?: string;
}

function isExternalKind(kind: AgentEngineKind): kind is ExternalAgentEngineKind {
  // 与 ExternalAgentEngineKind = Exclude<AgentEngineKind, 'native'> 一致：非 native 即外部 CLI。
  return kind !== 'native';
}

/**
 * 把单个引擎描述符翻成 section 行模型。
 *   - native        → 计费 api_key_payg；默认模型「随会话 provider」；无登录/安装指引。
 *   - 外部 CLI       → 计费 subscription；默认模型在目录里配（mimo/kimi 由 CLI 解析）；
 *                      恒给登录提示；仅 missing 时给安装指引。
 */
export function buildEngineSectionRow(
  descriptor: AgentEngineDescriptor,
  t: Translations,
): EngineSectionRow {
  const section = t.engineCompat.engineSection;
  const kind = descriptor.kind;
  const external = isExternalKind(kind);

  // 默认模型来源说明：native 随 provider；mimo/kimi 由 CLI 解析；codex/claude 在目录里配。
  let defaultModelHint = section.defaultModelHint;
  if (!external) {
    defaultModelHint = section.defaultModelNative;
  } else if (kind === 'mimo_code' || kind === 'kimi_code') {
    defaultModelHint = section.defaultModelCliResolved;
  }

  return {
    kind,
    label: descriptor.label,
    summary: descriptor.summary,
    installState: descriptor.installState,
    installStateLabel: section.installState[descriptor.installState],
    installStateBadgeClass: INSTALL_STATE_BADGE_CLASS[descriptor.installState],
    billing: buildEngineBillingSummary(kind, t),
    version: descriptor.version,
    binaryPath: descriptor.binaryPath,
    defaultModelHint,
    ...(external ? { loginHint: section.loginHint[kind] } : {}),
    ...(external && descriptor.installState === 'missing' ? { installHint: section.installHint[kind] } : {}),
  };
}

/** 批量翻整组引擎描述符为 section 行（顺序沿用 registry.list() 的 native→codex→claude→mimo→kimi）。 */
export function buildEngineSectionRows(
  descriptors: readonly AgentEngineDescriptor[],
  t: Translations,
): EngineSectionRow[] {
  return descriptors.map((descriptor) => buildEngineSectionRow(descriptor, t));
}
