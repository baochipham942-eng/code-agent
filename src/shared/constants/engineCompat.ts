// ============================================================================
// Runtime(引擎) × Model/Provider 兼容矩阵 — single source of truth
// ----------------------------------------------------------------------------
// 这个模块回答设置页「执行引擎」IA 的两个核心问题：
//   ① "这个模型为什么在这个引擎下用不了" → getEngineModelCompat() 返回结构化 reasonCode
//   ② "选这个引擎是什么计费模式"          → ENGINE_BILLING_MODE 给出 billingMode
//
// 设计约束（CLAUDE.md 硬规则）：
//   - 本模块只产出"枚举 + reasonCode"，绝不散字面量文案；所有用户可见文案在 renderer
//     侧经 i18n 由 reasonCode/billingMode 派生（见 engineCompatLabels）。
//   - 纯函数、无 IO：把"该引擎已知可用的模型集合"作为入参传进来（codex/claude 的签名
//     catalog 模型 id、native 的 provider 注册表），保持可单测、main/renderer 共用。
//   - 不改 native/codex/claude/mimo/kimi 现有运行逻辑的行为，只声明"兼容性元数据"。
// ============================================================================

import type { AgentEngineKind } from '../contract/agentEngine';

/**
 * 引擎级计费模式（区别于 provider 级的 BillingMode=free/plan/payg/unknown）。
 * 引擎是"谁来跑这一轮"的运行时；它的计费语义由运行时本身决定：
 *   - subscription   外部 CLI 经登录吃订阅/账号额度（codex/claude/mimo/kimi 默认）。
 *   - api_key_payg   按 API key 用量计费（native 引擎随所选 provider，主体是按量）。
 *   - free_tier      免费额度运行（如 mimo 自动/免费档；当前出厂矩阵默认不命中，预留）。
 *   - unknown        计费语义未确定（兜底，不把"省钱"作为任何自动策略依据）。
 */
export type EngineBillingMode = 'subscription' | 'api_key_payg' | 'free_tier' | 'unknown';

export const ENGINE_BILLING_MODES: readonly EngineBillingMode[] = [
  'subscription',
  'api_key_payg',
  'free_tier',
  'unknown',
];

/**
 * 各引擎的出厂计费模式：
 *   - native        → api_key_payg：随所选 provider，主体按 API key 用量计费。
 *                     （provider 级更细的 free/plan/payg 仍由 BillingMode 在模型层表达，
 *                      引擎层只表态"按量"这一主轴，不和 provider 级 billing 抢语义。）
 *   - codex/claude/
 *     mimo/kimi      → subscription：外部 CLI 经各自 login 吃订阅/账号额度，
 *                     适配器从不注入 API key（见各 adapter auditNotes）。
 */
export const ENGINE_BILLING_MODE: Record<AgentEngineKind, EngineBillingMode> = {
  native: 'api_key_payg',
  codex_cli: 'subscription',
  claude_code: 'subscription',
  mimo_code: 'subscription',
  kimi_code: 'subscription',
};

export function getEngineBillingMode(kind: AgentEngineKind): EngineBillingMode {
  return ENGINE_BILLING_MODE[kind] ?? 'unknown';
}

/**
 * 模型在某引擎下不可用 / 需提示的结构化原因码。
 * UI 文案由 reasonCode 经 i18n 派生，绝不在此写中文/英文字面量。
 *   - not_in_signed_catalog  codex/claude：模型不在该引擎的签名目录里（fail-closed，
 *                            绝不静默替换成默认模型，对齐 run 派发 strict 语义）。
 *   - disabled_in_catalog    模型在签名目录中存在但被标记停用（disabledReason）。
 *   - provider_not_registered native：模型解析不到注册表内的 provider。
 *   - resolved_by_cli        mimo/kimi：模型由 CLI 自身解析，引擎层不校验（supported=true）。
 */
export type EngineModelCompatReasonCode =
  | 'not_in_signed_catalog'
  | 'disabled_in_catalog'
  | 'provider_not_registered'
  | 'resolved_by_cli';

export const ENGINE_MODEL_COMPAT_REASON_CODES: readonly EngineModelCompatReasonCode[] = [
  'not_in_signed_catalog',
  'disabled_in_catalog',
  'provider_not_registered',
  'resolved_by_cli',
];

export interface EngineModelCompatResult {
  /** 该模型能否在该引擎下选用 */
  supported: boolean;
  /**
   * 结构化原因码：
   *   - supported=false 时说明"为什么用不了"；
   *   - supported=true 但带 reasonCode（resolved_by_cli）时说明"为什么可用但有注解"。
   * 无需任何注解（如 native 命中注册表 provider）时省略。
   */
  reasonCode?: EngineModelCompatReasonCode;
}

/**
 * 兼容判定所需的上下文。纯入参，调用方（renderer 用 engineCatalogResult / provider 列表，
 * main 用签名 catalog / PROVIDER_REGISTRY）按各自数据源填充，保持本模块零 IO。
 */
export interface EngineModelCompatContext {
  /**
   * codex/claude：该引擎签名目录里"已启用"的模型 id 集合（不含 disabledReason 的）。
   * 用于判定"在不在该引擎签名目录里"。
   */
  signedCatalogEnabledModelIds?: ReadonlySet<string> | readonly string[];
  /**
   * codex/claude：该引擎签名目录里"被停用"的模型 id 集合（带 disabledReason）。
   * 命中则 supported=false + reasonCode=disabled_in_catalog（比"不在目录里"更精确）。
   */
  signedCatalogDisabledModelIds?: ReadonlySet<string> | readonly string[];
  /**
   * native：判断给定 modelId 是否解析得到注册表内 provider。
   * 由调用方注入（避免本模块依赖 provider 注册表的解析实现）。
   */
  isRegisteredNativeModel?: (modelId: string) => boolean;
}

function toSet(value?: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  if (!value) return new Set();
  return value instanceof Set ? value : new Set(value);
}

/**
 * 判定一个模型在某引擎下是否可用，并给出结构化原因码。
 *
 * 规则（与 run 派发路径一致，见 web/routes/agent.ts + agentEngineModelCatalog.ts）：
 *   - native       → 支持 provider 注册表内可解析的模型；解析不到则
 *                    supported=false + provider_not_registered。
 *   - codex/claude → 仅支持各自签名目录内"已启用"的模型；
 *                    命中停用项 → disabled_in_catalog；不在目录 → not_in_signed_catalog（均 false）。
 *   - mimo/kimi    → 直传任意模型（supported=true），但标注 resolved_by_cli
 *                    表示"模型由 CLI 自身解析，引擎层不校验"。
 *
 * modelId 为空（未显式指定模型，走引擎默认）时一律 supported=true 且不带原因码 ——
 * 这与 resolveAgentEngineCatalogModel 的"未显式请求模型时回落默认、不 fail-closed"一致。
 */
export function getEngineModelCompat(
  kind: AgentEngineKind,
  modelId: string | null | undefined,
  context: EngineModelCompatContext = {},
): EngineModelCompatResult {
  const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
  if (!trimmed) {
    return { supported: true };
  }

  switch (kind) {
    case 'native': {
      const ok = context.isRegisteredNativeModel?.(trimmed) ?? true;
      return ok ? { supported: true } : { supported: false, reasonCode: 'provider_not_registered' };
    }
    case 'codex_cli':
    case 'claude_code': {
      const enabled = toSet(context.signedCatalogEnabledModelIds);
      if (enabled.has(trimmed)) {
        return { supported: true };
      }
      const disabled = toSet(context.signedCatalogDisabledModelIds);
      if (disabled.has(trimmed)) {
        return { supported: false, reasonCode: 'disabled_in_catalog' };
      }
      return { supported: false, reasonCode: 'not_in_signed_catalog' };
    }
    case 'mimo_code':
    case 'kimi_code':
      return { supported: true, reasonCode: 'resolved_by_cli' };
    default:
      return { supported: true };
  }
}

/** native 随所选 provider，引擎层无法只凭 kind 断定 billing；其余引擎可。 */
export function engineBillingModeIsAuthoritative(kind: AgentEngineKind): boolean {
  return kind !== 'native';
}

// ============================================================================
// HANDOFF — 设置页「执行引擎」section（下一子步）
// ----------------------------------------------------------------------------
// 设置页该消费的数据底座就是本模块 + 现有引擎描述符 IPC：
//   - 引擎列表 / 安装状态 / 可靠性：window.domainAPI.invoke(IPC_DOMAINS.AGENT_ENGINE, 'list')
//     → AgentEngineDescriptor[]（agentEngineRegistry）。
//   - 引擎签名模型目录：invoke(IPC_DOMAINS.AGENT_ENGINE, 'listModels')
//     → AgentEngineModelCatalogResult（codex/claude 用，mimo/kimi 无目录走直传）。
//   - 计费模式：getEngineBillingMode(kind) → EngineBillingMode；标签经
//     t.engineCompat.billing[mode]（设置页可复用 renderer 的 buildEngineBillingSummary）。
//   - 模型可用性 + 原因：getEngineModelCompat(kind, modelId, ctx)；ctx 由
//     listModels 结果的 enabled/disabled id 集合构造（见 ModelSwitcher.engineModelCompatContext），
//     reasonCode 经 t.engineCompat.reason[code] 翻译（resolveEngineModelCompatReason）。
// 设置页只读这些即可，无需新增 IPC；不要在设置页再造一份矩阵，统一从本模块派生。
// ============================================================================
