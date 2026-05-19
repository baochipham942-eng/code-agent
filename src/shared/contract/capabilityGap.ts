// ============================================================================
// CapabilityGap DTO — Step 7 PR 3
//
// `CapabilityRecommender` (main) 输出的能力缺口 DTO，序列化友好、可在 IPC 边
// 界传到 renderer 直接消费。GapCard UI 只读这套类型。
//
// 设计原则：
// - 不直接引用 main 的 PluginManifest / ModelCandidate，避免把 plugin protocol
//   (Tool / HookEvent / ToolModule) 拖进 renderer
// - 只保留 GapCard 渲染所需字段。未来 UI 需要更多元数据再扩。
// ============================================================================

import type { ModelDomainCapability } from '../constants';

/**
 * Plugin 候选 DTO — `PluginManifest` 的最小投影。
 *
 * marketplace 接入前，`CapabilityGap`(type='plugin') 的 candidates 永远为空数
 * 组；本类型保留是为了 GapCard 在未来 marketplace 上线后能直接渲染候选列表
 * 而不用改 IPC schema。
 */
export interface CapabilityGapPluginCandidate {
  /** 插件唯一标识 */
  id: string;
  /** 插件人类可读名称 */
  name: string;
  /** semver 版本号 */
  version: string;
  /** 可选描述 */
  description?: string;
}

/**
 * Model 候选 DTO — 与 main `ModelCandidate` 同形（provider/model 字符串对）。
 *
 * UI 展示用，不应作为模型路由决策依据。
 */
export interface CapabilityGapModelCandidate {
  provider: string;
  model: string;
}

/**
 * 能力缺口分类。Discriminated union — UI 按 `type` narrowing。
 *
 * - `plugin`：本地 plugin manifest 没有声明该 capability 标签
 * - `model`：当前所有候选 model 都不具备该 capability
 * - `apikey`：候选 model 在册，但所有对应 provider 都没配 key
 */
export type CapabilityGap =
  | {
      type: 'plugin';
      /** 缺失的 capability 标签（kebab-case） */
      missing: string;
      /** marketplace 接入前 candidates 始终为空数组 */
      candidates: CapabilityGapPluginCandidate[];
    }
  | {
      type: 'model';
      missing: ModelDomainCapability;
      candidates: CapabilityGapModelCandidate[];
    }
  | {
      type: 'apikey';
      /** 缺失项（kebab-case capability 标签或模型能力名，用于人类可读消息） */
      missing: string;
      /** 推荐优先配置的 provider */
      provider: string;
    };
