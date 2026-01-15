// ============================================================================
// useDisclosure - Progressive Disclosure Hook
// ============================================================================

import { useAppStore, type DisclosureLevel } from '../stores/appStore';

// 功能可见性配置
const featureVisibility: Record<string, DisclosureLevel> = {
  // Simple 级别可见
  'chat': 'simple',
  'basic-tools': 'simple',

  // Standard 级别可见
  'todo-panel': 'standard',
  'generation-selector': 'standard',
  'model-settings': 'standard',
  'session-history': 'standard',
  'workspace-panel': 'standard',

  // Advanced 级别可见
  'planning-panel': 'advanced',
  'findings-panel': 'advanced',
  'errors-panel': 'advanced',
  'tool-execution-details': 'advanced',
  'custom-prompts': 'advanced',

  // Expert 级别可见
  'raw-api-response': 'expert',
  'token-metrics': 'expert',
  'debug-console': 'expert',
  'mcp-config': 'expert',
  'advanced-settings': 'expert',
};

// 级别优先级
const levelPriority: Record<DisclosureLevel, number> = {
  'simple': 0,
  'standard': 1,
  'advanced': 2,
  'expert': 3,
};

/**
 * 渐进披露 Hook
 * 用于控制 UI 元素的可见性
 */
export function useDisclosure() {
  const disclosureLevel = useAppStore((state) => state.disclosureLevel);
  const setDisclosureLevel = useAppStore((state) => state.setDisclosureLevel);

  /**
   * 检查功能是否可见
   */
  const isFeatureVisible = (featureId: string): boolean => {
    const requiredLevel = featureVisibility[featureId];
    if (!requiredLevel) return true; // 未配置的功能默认可见

    return levelPriority[disclosureLevel] >= levelPriority[requiredLevel];
  };

  /**
   * 检查是否达到指定级别
   */
  const isAtLeast = (level: DisclosureLevel): boolean => {
    return levelPriority[disclosureLevel] >= levelPriority[level];
  };

  /**
   * 获取当前级别的显示名称
   */
  const getLevelName = (): string => {
    const names: Record<DisclosureLevel, string> = {
      'simple': 'Simple',
      'standard': 'Standard',
      'advanced': 'Advanced',
      'expert': 'Expert',
    };
    return names[disclosureLevel];
  };

  /**
   * 升级到下一个级别
   */
  const upgradeLevel = (): void => {
    const levels: DisclosureLevel[] = ['simple', 'standard', 'advanced', 'expert'];
    const currentIndex = levels.indexOf(disclosureLevel);
    if (currentIndex < levels.length - 1) {
      setDisclosureLevel(levels[currentIndex + 1]);
    }
  };

  /**
   * 降级到上一个级别
   */
  const downgradeLevel = (): void => {
    const levels: DisclosureLevel[] = ['simple', 'standard', 'advanced', 'expert'];
    const currentIndex = levels.indexOf(disclosureLevel);
    if (currentIndex > 0) {
      setDisclosureLevel(levels[currentIndex - 1]);
    }
  };

  return {
    level: disclosureLevel,
    setLevel: setDisclosureLevel,
    isFeatureVisible,
    isAtLeast,
    getLevelName,
    upgradeLevel,
    downgradeLevel,

    // 便捷属性
    isSimple: disclosureLevel === 'simple',
    isStandard: isAtLeast('standard'),
    isAdvanced: isAtLeast('advanced'),
    isExpert: isAtLeast('expert'),

    // 常用功能检查
    showTodoPanel: isAtLeast('standard'),
    showPlanningPanel: isAtLeast('advanced'),
    showDebugInfo: isAtLeast('expert'),
  };
}

/**
 * 条件渲染组件
 * 根据披露级别决定是否渲染子组件
 */
export function DisclosureGate({
  feature,
  level,
  children,
  fallback = null,
}: {
  feature?: string;
  level?: DisclosureLevel;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { isFeatureVisible, isAtLeast } = useDisclosure();

  const shouldShow = feature
    ? isFeatureVisible(feature)
    : level
    ? isAtLeast(level)
    : true;

  return shouldShow ? <>{children}</> : <>{fallback}</>;
}
