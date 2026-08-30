// ============================================================================
// /model 交互选择器的数据构建（纯函数，无 Ink 依赖，可单测）
// 数据源：PROVIDER_REGISTRY + PROVIDER_ENV_KEYS + 当前 provider（chat.ts 注入）
// ============================================================================

export interface ModelPickerItem {
  /** provider id（/model <id> 直接用） */
  id: string;
  /** 显示名（DeepSeek / Anthropic Claude …） */
  label: string;
  /** 默认模型 */
  defaultModel: string;
  /** API key 是否已配置（✓/✗） */
  hasKey: boolean;
  /** 当前使用中的 provider（◄ 标记） */
  current: boolean;
}

export function buildModelPickerItems(
  registry: Record<string, { displayName: string; defaultModel: string }>,
  providerEnvKeys: Record<string, string>,
  env: Record<string, string | undefined>,
  currentProvider: string,
): ModelPickerItem[] {
  return Object.entries(registry).map(([id, info]) => {
    const envKey = providerEnvKeys[id];
    return {
      id,
      label: info.displayName,
      defaultModel: info.defaultModel,
      hasKey: Boolean(envKey && env[envKey]),
      current: id === currentProvider,
    };
  });
}
